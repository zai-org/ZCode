import { isZCodeAgentModelSelectionBasisUnsupportedError } from "#src/zcode-agent/zcodeAgentErrors.js";
import { replyToBotChannel } from "#src/bots/channelReply.js";
import {
  BotAdminRequiredError,
  BotReplyError,
  createGroupAdminAttention,
} from "#src/bots/groupAdminAttention.js";
import { createTopicPreparationState } from "#src/bots/topicPreparationState.js";
import { createTopicContinuation } from "#src/bots/topicContinuation.js";
import { TopicHistoryPermissionError } from "#src/bots/topicHistory.js";
import {
  createTopicHistoryAttachment,
  botGroupCommandId,
} from "#src/bots/topicHistoryAttachment.js";
import { createGroupDeliveryThrottle } from "#src/bots/groupDeliveryThrottle.js";
import { createGroupResultDelivery } from "#src/bots/groupResultDelivery.js";
import { createGroupQueueCardSync } from "#src/bots/groupQueueCard.js";
import { readAuthorizedTopicResource, authorizeTopicResource } from "#src/bots/topicResource.js";
import {
  getBotConversationKey,
  getBotStateKey,
  isGroupOwnerCommand,
  canAnswerGroupQuestion,
} from "./groupSessions.js";
/* eslint-disable max-lines -- Bots 服务仍复用原 RPC 文件名，先把鉴权、命令路由、ZCode Agent 桥接收口集中在同一服务内。 */
import { Buffer } from "node:buffer";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { IDisposable } from "@zcode/rpc";
import { completeNewModelSelection } from "@zcode/provider";
import {
  ALL_BOT_WORKSPACES,
  parseRemoteWorkspaceIdentity,
  CONVERSATION_SELECTION_MAX_TEXT_LENGTH,
  generateTraceId,
  normalizeAgentProviderToZCodeAgent,
  ZCODE_AGENT_PROVIDER,
  BOT_TASK_BROADCAST_CHANNEL,
  BOT_TASK_STREAM_BROADCAST_CHANNEL,
  appendAssistantMessagePart,
  buildZCodeAssistantPresentation,
  decodeCustomModelValue,
  encodeCustomModelValue,
  getPermissionRequestPreview,
  getSupportedBotReplyGranularities,
  normalizeBotReplyGranularity,
  type ZCodeConfigOption,
  type ZCodeElicitationRequest,
  type ZCodeElicitationQuestion,
  type ZCodePermissionOption,
  type ZCodePermissionRequest,
  type ZCodePromptAttachment,
  type ZCodeTaskMode,
  type ZCodeAssistantMessagePart,
  type ZCodeAutomationBotDeliveryTarget,
  type ZCodeProvider,
  type ZCodeStreamEvent,
  type TaskStreamMirrorableEvent,
  type ZCodeTaskMeta,
  type BotActor,
  type BotTaskBroadcastPayload,
  type BotTaskStreamBroadcastPayload,
  type BotConfig,
  type BotContextState,
  type BotDraftOptions,
  type BotCommand,
  type BotInboundAttachment,
  type BotInboundMessage,
  type BotOutboundMessage,
  type BotGroupDelivery,
  type BotGroupInputProgress,
  type BotGroupInputStatus,
  type BotPendingElicitation,
  type BotStructuredElicitationResponse,
  isFeishuBotProvider,
  type BotProvider,
  type BotProviderCallbackResult,
  type BotReplyGranularity,
  type BotRuntimeInfo,
  type BotWorkspaceRef,
  type ModelSelection,
  type BotsConfigFile,
  type Locale,
  type SelectionPrompt,
} from "@zcode/shared";
import type { BotRemoteRuntimeService } from "#src/bot-project-runtime/contract.js";
import {
  readProjectCatalog,
  projectSelectionId,
  type ProjectCatalogSnapshot,
} from "#src/project-catalog/index.js";
import type { IProjectService } from "#src/project/contract.js";
import type { IRemoteProjectService } from "#src/remote-projects/contract.js";
import {
  buildRemoteHostWorkspaceIdentity,
  formatBotInputClientId,
  remoteHostIdFromWorkspaceIdentity,
  toZhOrEnLocale,
} from "@zcode/shared";
import type { IZCodeTaskService } from "../session/zcodeTaskService.js";
import { resolveProviderModeIdFromConfigOptions } from "#src/session/sessionModeOptions.js";
import { deriveSessionTitle as deriveTaskTitle } from "#src/session/sessionTitle.js";
import type { IBroadcastService } from "../broadcast/broadcast.js";
import type { ICredentialService } from "../credential/credential.js";
import { getAppConfigDir } from "../paths.js";
import type { ISettingService } from "../setting/setting.js";
import type {
  IModelSelectionService,
  ModelSelectionView,
} from "../model-provider/providerFacadeServices.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import type {
  BotBindCodeResult,
  BotAutomationRunWatchParams,
  BotCreateBindCodeParams,
  BotListWorkspaceRefsParams,
  BotSaveBotParams,
  BotTestResult,
  BotUserConfigOptionsParams,
  IBotsService,
} from "./bots.js";
import {
  beginFeishuAppRegistration,
  pollFeishuAppRegistration,
} from "./providers/feishuAppRegistration.js";
import {
  BOT_BIND_CODE_TTL_MS,
  buildBotCredentialKey,
  buildBotWebhookSecretKey,
  getDefaultBotReplyGranularity,
  normalizeBotCommandPolicy,
  normalizeBotCurrentOptions,
} from "./config.js";
import { BOT_MENU_COMMAND_ORDER } from "./commandOrder.js";
import { parseBotCommand } from "./commandParser.js";
import { BotsRepo } from "./repo.js";
import type {
  BotProviderAdapter,
  BotStreamingReplyCardBlock,
  BotStreamingReplyCardHandle,
  BotTransientInteractionCardHandle,
  BotTypingTarget,
} from "./providers/types.js";
import { createTelegramBotProvider } from "./providers/telegramProvider.js";
import { createWebhookBotProvider } from "./providers/webhookProvider.js";
import { createWeixinBotProvider } from "./providers/weixinProvider.js";
import {
  beginWeixinRegistration as beginWeixinQrRegistration,
  pollWeixinRegistration as pollWeixinQrRegistration,
} from "./providers/weixinRegistration.js";
import { createFeishuBotProvider, splitFeishuText } from "./providers/feishuProvider.js";
import { formatBotMessage, type BotMessageId } from "./messages.js";
import {
  extractBotAssistantResponseMessages,
  formatBotAssistantReplyBlocks,
  formatBotToolCallSummaryLine,
  formatBotPermissionRequestSummary,
  formatBotToolCallReply,
  isBotToolCallReplyTerminal,
  updateBotReplyToolCalls,
  type BotAssistantReplyBlock,
  type BotReplyToolCallState,
} from "./replyFormatter.js";
import {
  findBoundUser,
  findAuthorizedBot,
  findCallbackBot,
  findBot,
  isUserCommandAllowed,
  normalizeBotConfig,
  normalizeConfigBots,
} from "./botConfigHelpers.js";
import {
  firstAllowedWorkspace,
  createWorkspaceRef,
  filterAllowedWorkspaces,
  getWorkspaceLabel,
  getWorkspaceKey,
  isWorkspaceAllowed,
  normalizeAllowedWorkspaces,
  normalizeConfiguredAllowedWorkspaces,
  resolveWorkspaceByValue,
} from "./workspaceHelpers.js";
import { getNativeModelProviderId } from "./modelSelectionHelpers.js";
import {
  formatStatusStreamToolProgress,
  formatStatusTaskLine,
  formatTaskRunningDuration,
  normalizeStatusProgressText,
  readLatestAssistantTurnChangeSummary,
  readLatestTaskProgress,
  readTaskWorkedDurationMs,
  taskStatus,
  truncateLiveStatusProgressText,
} from "./statusFormatting.js";
import { createTelegramChannelRuntime } from "./telegramChannelRuntime.js";
import { createBotTaskStreamHub } from "#src/bots/taskStreamHub.js";
import { createWeixinChannelRuntime } from "./weixinChannelRuntime.js";
import { createFeishuChannelRuntime } from "./feishuChannelRuntime.js";
import { registerMemoryDiagnosticsProvider } from "#src/memoryDiagnostics.js";

const botsLogger = createServiceLogger("bots");

function formatBotModelSelectionValue(selection: ModelSelection | undefined): string | undefined {
  if (!selection) return undefined;
  return selection.providerId === ZCODE_AGENT_PROVIDER
    ? selection.modelId
    : encodeCustomModelValue(selection.providerId, selection.modelId);
}

function parseBotModelOptionValue(value: string): ModelSelection | undefined {
  const decoded = decodeCustomModelValue(value);
  if (decoded?.providerId && decoded.modelName) {
    return { providerId: decoded.providerId, modelId: decoded.modelName };
  }
  const separatorIndex = value.indexOf("/");
  if (separatorIndex > 0 && separatorIndex < value.length - 1) {
    return {
      providerId: value.slice(0, separatorIndex),
      modelId: value.slice(separatorIndex + 1),
    };
  }
  return value.trim() ? { providerId: ZCODE_AGENT_PROVIDER, modelId: value.trim() } : undefined;
}

const BOT_REPLY_GRANULARITY_OPTIONS = [
  {
    id: "assistant_changes",
    label: { "zh-CN": "标准回复", "en-US": "Standard reply" },
    aliases: ["assistant", "assistant_changes", "normal", "default", "standard", "标准回复"],
  },
  {
    id: "assistant_toolcalls_changes",
    label: { "zh-CN": "完整回复", "en-US": "Full reply" },
    aliases: ["full", "tool", "toolcalls", "assistant_toolcalls_changes", "完整回复"],
  },
  {
    id: "summary_changes",
    label: { "zh-CN": "摘要回复", "en-US": "Summary reply" },
    aliases: ["summary", "summary_changes", "latest", "摘要回复"],
  },
  {
    id: "streaming_card",
    label: { "zh-CN": "流式卡片", "en-US": "Streaming card" },
    aliases: ["stream", "streaming", "streaming_card", "流式", "流式卡片"],
  },
] as const satisfies ReadonlyArray<{
  id: BotReplyGranularity;
  label: Record<"zh-CN" | "en-US", string>;
  aliases: readonly string[];
}>;

const BOT_EXCLUSIVE_CREDENTIAL_PROVIDERS = new Set<BotProvider>(["telegram", "feishu", "lark"]);
const FEISHU_STREAMING_CARD_MIN_UPDATE_INTERVAL_MS = 1_000;
const FEISHU_STREAMING_CARD_REQUEST_TIMEOUT_MS = 15_000;
const FEISHU_STREAMING_CARD_FAILURE_BACKOFF_BASE_MS = 1_000;
const FEISHU_STREAMING_CARD_FAILURE_CIRCUIT_THRESHOLD = 3;
const BOT_ELICITATION_PROGRESS_BROADCAST_TIMEOUT_MS = 1_000;
const BOT_PROVIDER_CALLBACK_ACK_TIMEOUT_MS = 3_000;

type StreamingCardTimelineBlock =
  | {
      type: "message";
      text: string;
    }
  | {
      type: "tools";
      toolIds: string[];
    };

const helpMessageByCommand = {
  help: "helpHelp",
  bind: "helpBind",
  status: "helpStatus",
  new: "helpNew",
  workspace: "helpWorkspace",
  model: "helpModel",
  mode: "helpMode",
  thoughtLevel: "helpThoughtLevel",
  reply: "helpReply",
} as const satisfies Record<(typeof BOT_MENU_COMMAND_ORDER)[number], BotMessageId>;

function validateBotConfig(config: BotsConfigFile, candidate: BotConfig): void {
  if (!candidate.id.trim()) {
    throw new Error("Bot id is required.");
  }
  if (candidate.enabled && candidate.providerUserId?.trim()) {
    const duplicateBinding = config.bots.find(
      (bot) =>
        bot.id !== candidate.id &&
        bot.enabled &&
        bot.provider === candidate.provider &&
        bot.providerUserId === candidate.providerUserId,
    );
    if (duplicateBinding) {
      throw new Error("An enabled bot with this provider user already exists.");
    }
  }
  if (
    candidate.enabled &&
    candidate.credentialRef?.trim() &&
    BOT_EXCLUSIVE_CREDENTIAL_PROVIDERS.has(candidate.provider)
  ) {
    const duplicateCredential = config.bots.find(
      (bot) =>
        bot.id !== candidate.id &&
        bot.enabled &&
        bot.provider === candidate.provider &&
        bot.credentialRef === candidate.credentialRef,
    );
    if (duplicateCredential) {
      throw new Error("Enabled polling bots cannot share the same credential.");
    }
  }
}

interface BotsServiceDeps {
  credentialService: ICredentialService;
  zcodeTaskService: IZCodeTaskService;
  projectService: Pick<IProjectService, "readProjects" | "readTree" | "prepareSession">;
  remoteProjectService?: Pick<IRemoteProjectService, "readDirectory">;
  ownerHostId?: string;
  broadcastService?: IBroadcastService;
  settingService?: ISettingService;
  modelSelectionService: Pick<IModelSelectionService, "getView">;
  remoteWorkspaceService?: BotRemoteWorkspaceService;
  repo?: BotsRepo;
  // 修复原因：desktop-attached 远端启动阶段不应抢跑 bot 轮询、runtime lock 和模型候选缓存；
  // 这些后台任务属于本地桌面 host，不属于 SSH/Docker 远端首屏连接路径。
  runStartupBackgroundTasks?: boolean;
}

type BotRemoteWorkspaceReconnectResult = Awaited<
  ReturnType<BotRemoteRuntimeService["ensureConnected"]>
>;
type BotRemoteWorkspaceService = Pick<BotRemoteRuntimeService, "isConnected" | "ensureConnected"> &
  Partial<Omit<BotRemoteRuntimeService, "isConnected" | "ensureConnected">> & {
    resolveWorkspace?: (target: {
      workspacePath: string;
      workspaceIdentity: string;
    }) => Promise<{ workspacePath: string; workspaceIdentity: string } | null>;
  };

interface PreparedTopicMessage {
  generation: number;
  message: BotInboundMessage;
  prepared: PreparedBotMessageContent;
}

interface PreparedBotMessageContent {
  content: string;
  zcodeAttachments: ZCodePromptAttachment[];
}

type BotAuthorizedCommand =
  | "help"
  | "status"
  | "new"
  | "reconnect"
  | "workspace"
  | "model"
  | "mode"
  | "thoughtLevel"
  | "task"
  | "reply"
  | "stop"
  | "message"
  | "approve";

interface BindCodeRecord {
  botId: string;
  code: string;
  allowedWorkspaces: string[];
  expiresAt: number;
}

interface BotModelOption {
  id: string;
  label: string;
  description?: string;
}

interface BotModelProviderOption {
  id: string;
  label: string;
  description?: string;
  models: BotModelOption[];
}

interface BotTaskSelectionEntry {
  task: ZCodeTaskMeta;
  workspacePath: string;
  workspaceIdentity?: string;
}

interface BotWorkspaceSelectionEntry {
  workspace: BotWorkspaceRef;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readNestedRecord(
  value: Record<string, unknown> | null | undefined,
  key: string,
): Record<string, unknown> | null {
  const nested = value?.[key];
  return isRecord(nested) ? nested : null;
}

function readNestedString(
  value: Record<string, unknown> | null | undefined,
  key: string,
): string | undefined {
  const nested = value?.[key];
  return typeof nested === "string" && nested.trim().length > 0 ? nested : undefined;
}

function summarizeCallbackPayload(payload: unknown): string {
  if (!isRecord(payload)) {
    return `type=${typeof payload}`;
  }
  const header = readNestedRecord(payload, "header");
  const event = readNestedRecord(payload, "event") ?? payload;
  const message = readNestedRecord(event, "message");
  const context = readNestedRecord(payload, "context");
  const action = readNestedRecord(payload, "action");
  const keys = Object.keys(payload).slice(0, 16).join(",");
  return [
    `keys=${keys || "none"}`,
    `botId=${readNestedString(payload, "botId") ?? "none"}`,
    `eventType=${readNestedString(header, "event_type") ?? readNestedString(header, "type") ?? readNestedString(payload, "event_type") ?? "none"}`,
    `messageType=${readNestedString(message, "message_type") ?? "none"}`,
    `chatType=${readNestedString(message, "chat_type") ?? readNestedString(context, "chat_type") ?? readNestedString(payload, "chat_type") ?? "none"}`,
    `hasAction=${action ? "true" : "false"}`,
  ].join(" ");
}

function createCode(): string {
  return randomBytes(3).toString("hex").toUpperCase();
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

function getReplyGranularityOptions(locale: Locale | undefined, provider?: BotProvider) {
  const messageLocale = locale === "en-US" ? "en-US" : "zh-CN";
  const supportedIds = provider ? new Set(getSupportedBotReplyGranularities(provider)) : null;
  return BOT_REPLY_GRANULARITY_OPTIONS.filter(
    (option) => !supportedIds || supportedIds.has(option.id),
  ).map((option) => ({
    id: option.id,
    label: option.label[messageLocale],
  }));
}

function resolveReplyGranularityByValue(
  value: string,
  locale: Locale | undefined,
  provider?: BotProvider,
) {
  const trimmed = value.trim();
  const index = Number.parseInt(trimmed, 10);
  const options = getReplyGranularityOptions(locale, provider);
  if (Number.isFinite(index) && index > 0) {
    return options[index - 1] ?? null;
  }
  const normalized = normalizeText(trimmed);
  const option = BOT_REPLY_GRANULARITY_OPTIONS.find(
    (item) =>
      (item.aliases as readonly string[]).includes(normalized) ||
      normalizeText(item.label["zh-CN"]) === normalized ||
      normalizeText(item.label["en-US"]) === normalized,
  );
  return option ? (options.find((item) => item.id === option.id) ?? null) : null;
}

function resolveOptionByValue<T extends { id: string; label: string }>(
  items: T[],
  value: string,
): T | null {
  const trimmed = value.trim();
  if (/^[1-9]\d*$/u.test(trimmed)) {
    const index = Number.parseInt(trimmed, 10);
    return items[index - 1] ?? null;
  }
  const normalized = normalizeText(trimmed);
  return (
    items.find(
      (item) => normalizeText(item.id) === normalized || normalizeText(item.label) === normalized,
    ) ?? null
  );
}

function isSelectionIndexValue(value: string): boolean {
  return /^[1-9]\d*$/u.test(value.trim());
}

function createOutbound(
  actor: BotActor,
  text: string,
  selection?: SelectionPrompt,
  extras: Pick<
    BotOutboundMessage,
    "elicitation" | "locale" | "groupSourceCommandId" | "groupTaskId"
  > = {},
): BotOutboundMessage {
  return {
    botId: actor.botId,
    provider: actor.provider,
    providerUserId: actor.chatId ?? actor.providerUserId,
    ...(isFeishuBotProvider(actor.provider) && actor.chatType === "group" && actor.providerMessageId
      ? {
          replyToMessageId: actor.providerMessageId,
          mentionedUserIds:
            !actor.threadId || actor.mentionedBot === true ? [actor.providerUserId] : undefined,
        }
      : {}),
    ...(actor.threadId ? { threadId: actor.threadId, rootMessageId: actor.rootMessageId } : {}),
    ...(actor.conversationThreadId !== undefined
      ? { conversationThreadId: actor.conversationThreadId }
      : {}),
    text,
    ...(selection ? { selection } : {}),
    ...extras,
    ...(actor.providerContextToken ? { providerContextToken: actor.providerContextToken } : {}),
  };
}

function groupCardFor(
  actor: BotActor,
  context: BotContextState,
): import("@zcode/shared").BotGroupCard {
  const group = context.group!;
  const threadId = actor.threadId ?? group.threadId;
  return {
    chatId: group.chatId,
    threadId,
    taskId: context.activeTaskId,
    authorizationId: group.authorizationId!,
    ...(threadId !== group.threadId ? { conversationThreadId: group.threadId ?? null } : {}),
  };
}

function resolveAutomationBotDeliveryTarget(
  actor: BotActor,
): ZCodeAutomationBotDeliveryTarget | undefined {
  if (actor.provider !== "feishu" && actor.provider !== "lark" && actor.provider !== "weixin") {
    return undefined;
  }
  const providerUserId = actor.chatId?.trim() || actor.providerUserId.trim();
  if (!providerUserId) return undefined;
  return {
    provider: actor.provider,
    botId: actor.botId,
    providerUserId,
    chatType: actor.chatType,
    ...(actor.threadId ? { threadId: actor.threadId, rootMessageId: actor.rootMessageId } : {}),
  };
}

function formatSelectionFallback(selection: SelectionPrompt, locale?: Locale): string {
  const lines = selection.options.map((option, index) => {
    const description = option.description ? ` ${option.description}` : "";
    return `${index + 1}. ${option.label}${description}`;
  });
  // Bugfix: 微信这类纯文本通道没有原生选项卡，之前把完整 slash command 和长路径展开，
  // workspace/remote identity 会把消息刷得很长。这里只展示编号，数字解析仍走 pending selection。
  if (selection.showCancel === false) {
    return `${selection.title}\n${lines.join("\n")}\n\n${formatBotMessage(locale, "selectionTextHintNoCancel")}`;
  }
  const cancelLabel = selection.cancelLabel ?? formatBotMessage(locale, "selectionCancelOption");
  return `${selection.title}\n0. ${cancelLabel}\n${lines.join("\n")}\n\n${formatBotMessage(locale, "selectionTextHint")}`;
}

type BotPermissionOptionDisplayKind =
  | "allowOnce"
  | "allowAlways"
  | "rejectOnce"
  | "rejectAlways"
  | "custom";

const BOT_PERMISSION_OPTION_PRIORITY = {
  allowOnce: 0,
  allowAlways: 1,
  rejectOnce: 2,
  rejectAlways: 3,
  custom: 4,
} as const satisfies Record<BotPermissionOptionDisplayKind, number>;

function getBotPermissionOptionDisplayKind(
  option: ZCodePermissionOption,
): BotPermissionOptionDisplayKind {
  const text = `${option.optionId} ${option.kind} ${option.name}`.toLowerCase();
  const isAlways =
    /\b(always|persistent|permanent|remember)\b/u.test(text) ||
    /始终|永久|记住|不再询问/u.test(text);
  const isAllow = /\b(allow|approve|accept|yes)\b/u.test(text) || /允许|同意|批准/u.test(text);
  const isReject = /\b(deny|reject|decline|no)\b/u.test(text) || /拒绝|不允许|否/u.test(text);
  if (isAllow) {
    return isAlways ? "allowAlways" : "allowOnce";
  }
  if (isReject) {
    return isAlways ? "rejectAlways" : "rejectOnce";
  }
  return "custom";
}

function sortBotPermissionOptions(
  options: readonly ZCodePermissionOption[],
): ZCodePermissionOption[] {
  return [...options].sort((left, right) => {
    const leftPriority = BOT_PERMISSION_OPTION_PRIORITY[getBotPermissionOptionDisplayKind(left)];
    const rightPriority = BOT_PERMISSION_OPTION_PRIORITY[getBotPermissionOptionDisplayKind(right)];
    return leftPriority - rightPriority;
  });
}

function formatBotPermissionOptionLabel(option: ZCodePermissionOption, locale?: Locale): string {
  const displayKind = getBotPermissionOptionDisplayKind(option);
  if (locale === "en-US") {
    switch (displayKind) {
      case "allowOnce":
        return "Allow";
      case "allowAlways":
        return "Always Allow";
      case "rejectOnce":
        return "Deny";
      case "rejectAlways":
        return "Always Deny";
      case "custom":
        return option.name;
    }
  }
  switch (displayKind) {
    case "allowOnce":
      return "允许";
    case "allowAlways":
      return "始终允许";
    case "rejectOnce":
      return "拒绝";
    case "rejectAlways":
      return "始终拒绝";
    case "custom":
      return option.name;
  }
}

function formatBotPermissionOptionDescription(
  option: ZCodePermissionOption,
  request: Pick<ZCodePermissionRequest, "title" | "description" | "kind" | "raw">,
  locale?: Locale,
): string | undefined {
  const displayKind = getBotPermissionOptionDisplayKind(option);
  if (displayKind === "custom") {
    return option.kind;
  }
  const scope = getPermissionRequestPreview(request).scope;
  if (locale === "en-US") {
    if (displayKind === "allowOnce") {
      return "Allow this time only";
    }
    if (displayKind === "rejectOnce") {
      return "Reject this time";
    }
    if (displayKind === "allowAlways") {
      return scope === "command"
        ? "Do not ask again for the same command"
        : scope === "file"
          ? "Do not ask again for the same file operation"
          : "Do not ask again for the same permission request";
    }
    return scope === "command"
      ? "Always reject the same command"
      : scope === "file"
        ? "Always reject the same file operation"
        : "Always reject the same permission request";
  }
  if (displayKind === "allowOnce") {
    return "仅允许这一次";
  }
  if (displayKind === "rejectOnce") {
    return "这次先拒绝";
  }
  if (displayKind === "allowAlways") {
    return scope === "command"
      ? "后续相同命令不再询问"
      : scope === "file"
        ? "后续相同文件操作不再询问"
        : "后续相同权限请求不再询问";
  }
  return scope === "command"
    ? "后续相同命令也会直接拒绝"
    : scope === "file"
      ? "后续相同文件操作也会直接拒绝"
      : "后续相同权限请求也会直接拒绝";
}

function isBotPermissionRejectOption(option: ZCodePermissionOption): boolean {
  const displayKind = getBotPermissionOptionDisplayKind(option);
  return displayKind === "rejectOnce" || displayKind === "rejectAlways";
}

function stripModelProviderDescriptionsForTextSelection(
  selection: SelectionPrompt,
): SelectionPrompt {
  if (selection.action !== "model.provider.set") {
    return selection;
  }
  return {
    ...selection,
    options: selection.options.map((option) => ({
      ...option,
      description: undefined,
    })),
  };
}

function formatWorkspaceOptionLabel(workspace: BotWorkspaceRef, locale?: Locale): string {
  if (!workspace.workspaceIdentity) {
    return workspace.label;
  }
  const remoteLabel = locale === "en-US" ? "[Remote]" : "[远端]";
  return `${workspace.label} ${remoteLabel}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DEFAULT_BOT_ZCODE_PROVIDER: ZCodeProvider = ZCODE_AGENT_PROVIDER;
// Bot 模式硬锁 yolo：所有 bot task 一律免交互权限，且禁止通过 /mode 切换运行模式。
const BOT_FORCED_MODE = "yolo";
const BOT_TYPING_INTERVAL_MS = 4_000;
const BOT_TASK_META_RETRY_DELAYS_MS = [80, 160, 320] as const;
const BOT_MAX_ATTACHMENTS_PER_MESSAGE = 4;
const BOT_ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 30_000;
const REMOTE_RECONNECT_DEDUPE_TTL_MS = 3_000;
const REMOTE_RECONNECT_DELIVERY_DEDUPE_TTL_MS = 2 * 60_000;
const BOT_INBOUND_DELIVERY_DEDUPE_TTL_MS = 2 * 60_000;
const BOT_AUTOMATION_DELIVERY_WARNING_TTL_MS = 5 * 60_000;
const BOT_ELICITATION_CUSTOM_OPTION_ID = "__custom__";
const BOT_ELICITATION_SUBMIT_OPTION_ID = "__submit__";
const BOT_ELICITATION_SKIP_OPTION_ID = "__skip__";
const BOT_ELICITATION_FORM_VALUE_PREFIX = "__form__:";

export function createBotsService(
  deps: BotsServiceDeps,
): IBotsService & { disposeAll(): void; disposeAllAndWait(): Promise<void> } {
  const runStartupBackgroundTasks = deps.runStartupBackgroundTasks !== false;
  const repo = deps.repo ?? new BotsRepo();
  const bindCodes = new Map<string, BindCodeRecord>();
  const automationDeliveryWarningAtByKey = new Map<string, number>();
  const streamSubscriptions = new Map<
    string,
    IDisposable & { automation(runId?: string): void; imInput(): void }
  >();
  const taskStreamHub = createBotTaskStreamHub<ZCodeStreamEvent | TaskStreamMirrorableEvent>();
  const failedPrivateDeliveries = new Map<
    string,
    {
      id: string;
      message: BotOutboundMessage;
      bindingId: string | undefined;
      taskId: string;
      sending: boolean;
    }
  >();
  const privateReconciliations = new Map<string, Promise<void>>();
  const privateImTraces = new Set<string>();
  const watchStarts = new Map<string, Promise<void>>();
  const privateWatches = new Map<string, { signature: string; key: string }>();
  const forwardedTaskEvents = new WeakSet<object>();
  let privateRecoveryTimer: ReturnType<typeof setInterval> | undefined;
  let privateRecoveryPending = false;
  const streamingCardRequestControllers = new Set<AbortController>();
  const transientInteractionCards = new Map<
    string,
    {
      bot: BotConfig;
      taskId: string;
      handle: BotTransientInteractionCardHandle;
    }
  >();
  const typingIntervals = new Map<string, ReturnType<typeof setInterval>>();
  const typingTargets = new Map<string, { bot: BotConfig; target: BotTypingTarget }>();
  const runningTasks = new Set<string>();
  const topicContinuations = new Map<
    string,
    ReturnType<typeof createTopicContinuation<PreparedTopicMessage>>
  >();
  const topicHistoryReady = new Map<string, string>();
  const botHistoryEpoch = new Map<string, number>();
  const groupHistoryEpoch = new Map<string, number>();
  const topicStops = new Map<string, Promise<void>>();
  const topicPreparation = createTopicPreparationState();
  const publishTopicPreparation = () =>
    deps.broadcastService?.send({ channel: "bots:group-state", payload: {} });
  const topicGenerations = new Map<string, number>();
  const topicReplies = new Map<string, Map<string, (replies: BotOutboundMessage[]) => void>>();

  const liveStatusProgressByTaskId = new Map<
    string,
    { kind: "message" | "thought" | "tool"; text: string }
  >();
  const runtimeByBotId = new Map<string, BotRuntimeInfo>();
  const pendingSelectionsByContext = new Map<string, SelectionPrompt>();
  // 只读取任务订阅和运行状态的数量，不暴露消息内容。
  const memoryDiagnostics = registerMemoryDiagnosticsProvider("bots", () => ({
    streamSubs: streamSubscriptions.size,
    runningTasks: runningTasks.size,
    typingIntervals: typingIntervals.size,
    liveStatusProgress: liveStatusProgressByTaskId.size,
  }));
  const pendingTaskSelectionsByContext = new Map<string, Map<string, BotTaskSelectionEntry>>();
  const pendingWorkspaceSelectionsByContext = new Map<
    string,
    Map<string, BotWorkspaceSelectionEntry>
  >();
  const pendingRemoteReconnectsByKey = new Map<string, Promise<BotOutboundMessage[]>>();
  const recentRemoteReconnectAtByKey = new Map<string, number>();
  const recentRemoteReconnectDeliveryAtByKey = new Map<string, number>();
  const recentInboundDeliveryAtByKey = new Map<string, number>();
  const inboundProcessingQueuesByContext = new Map<string, Promise<void>>();
  let botStorageMigrationPromise: Promise<void> | null = null;
  let cachedLocale: Locale | undefined;
  const providers: Record<BotProvider, BotProviderAdapter | null> = {
    telegram: createTelegramBotProvider({
      loadCredential: (key) => deps.credentialService.load(key),
    }),
    webhook: createWebhookBotProvider({
      loadCredential: (key) => deps.credentialService.load(key),
    }),
    feishu: createFeishuBotProvider({
      onDeliveryResult,
      loadCredential: (key) => deps.credentialService.load(key),
    }),
    lark: createFeishuBotProvider({
      onDeliveryResult,
      loadCredential: (key) => deps.credentialService.load(key),
    }),
    weixin: createWeixinBotProvider({
      loadCredential: (key) => deps.credentialService.load(key),
    }),
    discord: null,
    wecom: null,
  };
  let service: IBotsService & {
    disposeAll(): void;
    disposeAllAndWait(): Promise<void>;
  };
  let shutdownPromise: Promise<void> | null = null;

  function onDeliveryResult(bot: BotConfig, deliveryError: string | undefined): void {
    // 收消息正常不代表回复已投递，不能把投递错误混成连接错误。
    const current = runtimeByBotId.get(bot.id);
    setRuntimeStatus({
      botId: bot.id,
      provider: bot.provider,
      status: current?.status ?? (bot.enabled ? "idle" : "disabled"),
      deliveryError:
        deliveryError ?? (failedPrivateDeliveries.has(bot.id) ? current?.deliveryError : undefined),
    });
  }

  function setRuntimeStatus(status: BotRuntimeInfo): void {
    runtimeByBotId.set(status.botId, {
      ...runtimeByBotId.get(status.botId),
      ...status,
      lastUpdateAt: Date.now(),
    });
  }

  const statusSink = {
    getRuntimeStatus(botId: string) {
      return runtimeByBotId.get(botId);
    },
    setRuntimeStatus,
  };
  const telegramRuntime = createTelegramChannelRuntime({
    runBackgroundTasks: runStartupBackgroundTasks,
    credentialService: deps.credentialService,
    telegramProvider: providers.telegram,
    logger: botsLogger,
    statusSink,
    ensureBotStorageMigrated,
    readConfig: () => repo.readConfig(),
    readTelegramOffset,
    writeTelegramOffset,
    processProviderCallback,
  });
  const weixinRuntime = createWeixinChannelRuntime({
    runBackgroundTasks: runStartupBackgroundTasks,
    credentialService: deps.credentialService,
    logger: botsLogger,
    statusSink,
    ensureBotStorageMigrated,
    readConfig: () => repo.readConfig(),
    readWeixinGetUpdatesBuf,
    writeWeixinGetUpdatesBuf,
    processProviderCallback,
  });
  const feishuRuntime = createFeishuChannelRuntime({
    runBackgroundTasks: runStartupBackgroundTasks,
    credentialService: deps.credentialService,
    logger: botsLogger,
    statusSink,
    ensureBotStorageMigrated,
    readConfig: () => repo.readConfig(),
    summarizeCallbackPayload,
    onConnectionInvalidated: (botId) =>
      botHistoryEpoch.set(botId, (botHistoryEpoch.get(botId) ?? 0) + 1),
    processProviderCallback,
  });

  async function readTelegramOffset(botId: string): Promise<number | undefined> {
    return (await repo.readState()).bots[botId]?.telegramOffset;
  }

  async function writeTelegramOffset(botId: string, offset: number): Promise<void> {
    await updateProviderCursor(botId, { telegramOffset: offset });
  }

  async function readWeixinGetUpdatesBuf(botId: string): Promise<string | undefined> {
    return (await repo.readState()).bots[botId]?.weixinGetUpdatesBuf;
  }

  async function writeWeixinGetUpdatesBuf(botId: string, buf: string): Promise<void> {
    await updateProviderCursor(botId, { weixinGetUpdatesBuf: buf });
  }

  async function updateProviderCursor(
    botId: string,
    patch: Pick<BotContextState, "telegramOffset" | "weixinGetUpdatesBuf">,
  ): Promise<void> {
    const bot = findBot(await repo.readConfig(), botId);
    if (!bot) return;
    const context = await readContext(
      {
        botId,
        chatType: "private",
        provider: bot.provider,
        providerUserId: bot.providerUserId ?? "",
      },
      bot,
    );
    if (!context) return;
    await serializeStateWrite(async () => {
      await repo.updateContext(botId, (current) =>
        current ? { ...current, ...patch, updatedAt: Date.now() } : undefined,
      );
    });
  }

  async function readContext(actor: BotActor, bot: BotConfig): Promise<BotContextState | null> {
    await ensureBotStorageMigrated();
    const state = await repo.readState();
    const existing = state.bots[getBotConversationKey(actor)];
    if (existing) {
      if (existing.hostId !== undefined) return existing;
      // 旧 SSH alias 必须先由可信 Host 解析，再匹配项目；不能以相同路径猜测 Source。
      const resolved = await normalizeWorkspaceRef(
        createWorkspaceRef(existing.workspacePath, existing.workspaceIdentity),
      );
      const next = upgradeLegacyContext(
        {
          ...existing,
          workspacePath: resolved.workspacePath,
          workspaceIdentity: resolved.workspaceIdentity,
        },
        await readProjectCatalog(deps),
      );
      return (
        (await repo.updateContext(getBotConversationKey(actor), (current) =>
          current?.hostId !== undefined ? current : { ...current, ...next },
        )) ?? null
      );
    }
    if (actor.chatType === "group") {
      if (!actor.threadId) return null;
      const parent =
        state.bots[
          getBotConversationKey({ ...actor, threadId: undefined, conversationThreadId: undefined })
        ];
      if (!parent?.group?.enabled || parent.group.ownerId !== bot.providerUserId) return null;
      let topicTitle = actor.topicTitle;
      let topicUrl = actor.topicUrl;
      let rootMessageId = actor.rootMessageId;
      if (!topicTitle && actor.providerMessageId) {
        try {
          const resolved = await providers[bot.provider]?.resolveTopic?.(bot, actor);
          topicTitle = resolved?.topicTitle;
          topicUrl = resolved?.topicUrl;
          rootMessageId = resolved?.rootMessageId ?? rootMessageId;
        } catch {
          // 原生事件已带话题身份时，缺少额外读取权限仅影响标题；不扩大历史读取范围。
          topicTitle = actor.threadId;
        }
      }
      // 话题只继承配置快照；不能复制默认任务的输入、问答或审批授权。
      const topic: BotContextState = {
        botId: bot.id,
        workspacePath: parent.workspacePath,
        workspaceIdentity: parent.workspaceIdentity,
        workspaceId: parent.workspaceId,
        projectId: parent.projectId,
        hostId: parent.hostId,
        additionalDirectories: parent.additionalDirectories,
        mode: "draft",
        activeTaskId: null,
        updatedAt: Date.now(),
        draftOptions: { ...(await buildActiveTaskDraftOptions(parent)), mode: "default" },
        group: {
          chatId: parent.group.chatId,
          threadId: actor.threadId,
          rootMessageId,
          topicTitle,
          topicUrl,
          name: parent.group.name,
          ownerId: parent.group.ownerId,
          enabled: true,
          authorizationId: parent.group.authorizationId,
          taskIds: [],
          currentOptions: { ...parent.group.currentOptions, mode: "default" },
        },
      };
      await serializeStateWrite(async () => {
        const latest = await repo.readState();
        const currentParent = latest.bots[getBotStateKey(parent)];
        const key = getBotStateKey(topic);
        if (
          latest.bots[key] ||
          !currentParent?.group?.enabled ||
          currentParent.group.authorizationId !== topic.group!.authorizationId
        )
          return;
        latest.bots[key] = topic;
        await repo.writeState(latest);
      });
      return (await repo.readState()).bots[getBotStateKey(topic)] ?? null;
    }
    const workspaces = await listWorkspaceRefs();
    const workspace = firstAllowedWorkspace(workspaces, {
      ...bot,
      allowedWorkspaces: normalizeConfiguredAllowedWorkspaces(bot.allowedWorkspaces, workspaces),
    });
    if (!workspace) return null;
    const execution = await bindProject(workspace);
    const context: BotContextState = {
      botId: bot.id,
      ...execution,
      mode: "draft",
      activeTaskId: null,
      draftOptions: await buildInitializedDraftOptions(execution),
      updatedAt: Date.now(),
    };
    return (
      (await repo.updateContext(bot.id, (current) =>
        current?.hostId !== undefined ? current : { ...current, ...context },
      )) ?? null
    );
  }

  let stateWriteTail: Promise<void> = Promise.resolve();
  async function readQueueCardScope(key: string) {
    const [botId, chatId, taskId, authorizationId, inputId, threadId] = JSON.parse(key) as string[];
    const state = await repo.readState();
    const context =
      state.bots[getBotConversationKey({ botId: botId!, chatType: "group", chatId, threadId })];
    const bot = findBot(await repo.readConfig(), botId!);
    const input = context?.group?.inputs?.[inputId!];
    if (
      !bot?.enabled ||
      !context?.group?.enabled ||
      context.group.ownerId !== bot.providerUserId ||
      context.group.authorizationId !== authorizationId ||
      context.activeTaskId !== taskId ||
      input?.taskId !== taskId
    )
      return undefined;
    return { state, context, bot, input };
  }
  const queueCards = createGroupQueueCardSync({
    read: async (key) => (await readQueueCardScope(key))?.input.progress ?? undefined,
    mutate: async (key, update) => {
      let result: BotGroupInputProgress | undefined;
      await serializeStateWrite(async () => {
        const scope = await readQueueCardScope(key);
        if (!scope) return;
        result = update(scope.input.progress ?? { status: "waiting" });
        scope.input.progress = result;
        await repo.writeState(scope.state);
      });
      return result;
    },
    render: async (key, providerMessageId, status) => {
      const scope = await readQueueCardScope(key);
      // 话题复用单向状态记录，但不渲染或更新历史遗留排队卡。
      if (!scope || scope.context.group?.threadId) return;
      const english = (await readMessageLocale()) === "en-US";
      const text: Record<BotGroupInputStatus, string> = english
        ? {
            waiting: "Waiting to run",
            working: "Running",
            done: "Completed",
            failed: "Failed",
            stopped: "Stopped",
            cancelled: "Cancelled",
            discarded: "Not executed",
          }
        : {
            waiting: "等待执行",
            working: "正在执行",
            done: "已完成",
            failed: "执行失败",
            stopped: "已停止",
            cancelled: "已取消",
            discarded: "未执行",
          };
      const adapter = providers[scope.bot.provider];
      if (!adapter?.updateTransientInteractionCard)
        throw new Error("Queue card update unavailable");
      await adapter.updateTransientInteractionCard(
        scope.bot,
        { providerMessageId },
        {
          botId: scope.bot.id,
          provider: scope.bot.provider,
          providerUserId: scope.context.group!.chatId,
          text: text[status],
        },
      );
    },
  });
  function serializeStateWrite(operation: () => Promise<void>): Promise<void> {
    const next = stateWriteTail.catch(() => undefined).then(operation);
    stateWriteTail = next;
    return next;
  }
  async function writeBotConfig(next: BotsConfigFile): Promise<BotsConfigFile> {
    const invalidatedTopics: BotActor[] = [];
    const previous = await repo.readConfig();
    const saved = await repo.writeConfig(next);
    const changedBindings = new Set(
      previous.bots
        .filter((before) => {
          const after = saved.bots.find((bot) => bot.id === before.id);
          return (
            !after ||
            before.providerUserId !== after.providerUserId ||
            before.provider !== after.provider ||
            before.feishuAppId !== after.feishuAppId ||
            before.credentialRef !== after.credentialRef
          );
        })
        .map((bot) => bot.id),
    );
    const operation = stateWriteTail
      .catch(() => undefined)
      .then(async () => {
        const state = await repo.readState();
        let changed = false;
        for (const [key, context] of Object.entries(state.bots)) {
          const group = context.group;
          if (!group) {
            const before = previous.bots.find((item) => item.id === context.botId);
            const after = saved.bots.find((item) => item.id === context.botId);
            if (changedBindings.has(context.botId) || before?.enabled !== after?.enabled) {
              if (
                changedBindings.has(context.botId) &&
                before?.provider === "weixin" &&
                context.privateRecipientId
              )
                await deps.credentialService.delete(
                  weixinContextKey(before, context.privateRecipientId),
                );
              state.bots[key] = {
                ...context,
                privateBindingId: randomUUID(),
                ...(changedBindings.has(context.botId) ? { privateRecipientId: undefined } : {}),
              };
              changed = true;
            }
            continue;
          }
          const current = saved.bots.find((bot) => bot.id === context.botId);
          if (!changedBindings.has(context.botId) && current?.providerUserId === group.ownerId)
            continue;
          const originalBot = previous.bots.find((bot) => bot.id === context.botId);
          if (group.threadId && originalBot)
            invalidatedTopics.push({
              botId: context.botId,
              provider: originalBot.provider,
              chatType: "group",
              chatId: group.chatId,
              threadId: group.threadId,
              providerUserId: group.ownerId,
            });
          state.bots[key] = {
            ...context,
            group: {
              ...group,
              enabled: false,
              authorizationId: randomUUID(),
              deliveries: Object.fromEntries(
                Object.entries(group.deliveries ?? {}).map(([id, result]) => [
                  id,
                  result.status === "sent" ? result : { ...result, status: "invalidated" as const },
                ]),
              ),
            },
          };
          changed = true;
        }
        if (changed) await repo.writeState(state);
      });
    stateWriteTail = operation;
    await operation;
    // 授权变更还必须失效尚未提交的材料，不能等旧准备返回后再生成回复。
    await Promise.all(invalidatedTopics.map(cancelTopicInputs));
    if (changedBindings.size)
      await deps.broadcastService
        ?.send({ channel: "bots:group-state", payload: {} })
        .catch(() => undefined);
    for (const botId of new Set([...previous.bots, ...saved.bots].map((item) => item.id)))
      await reconcilePrivateSynchronization(botId);
    return saved;
  }

  async function writeContext(
    context: BotContextState,
    updateAuthorization = false,
    expectedTaskId?: string | null,
  ): Promise<void> {
    const next = stateWriteTail
      .catch(() => undefined)
      .then(async () => {
        const state = await repo.readState();
        const key = getBotStateKey(context);
        const latest = state.bots[key];
        const latestGroup = latest?.group;
        if (
          !context.group &&
          expectedTaskId !== undefined &&
          (latest?.activeTaskId !== expectedTaskId ||
            latest?.privateBindingId !== context.privateBindingId)
        )
          return;
        // 群事件可能在停用、换绑或切换任务前开始处理；旧事件不能恢复已经撤销的关联。
        if (
          context.group &&
          !updateAuthorization &&
          latestGroup &&
          (latestGroup.authorizationId !== context.group.authorizationId ||
            (expectedTaskId !== undefined && latest?.activeTaskId !== expectedTaskId))
        )
          return;
        const group =
          context.group && latestGroup && !updateAuthorization
            ? {
                ...context.group,
                enabled: latestGroup.enabled,
                ownerId: latestGroup.ownerId,
                authorizationId: latestGroup.authorizationId,
                // 其他话题可能已更新群级历史开关，旧输入回写不能覆盖最新配置。
                historyEnabled: latestGroup.historyEnabled,
                topicActive: latestGroup.topicActive ?? context.group.topicActive,
                taskIds: [...new Set([...latestGroup.taskIds, ...context.group.taskIds])],
                // 已确认的 admission 是终态，迟到的流事件不能写回 pending。
                inputs: Object.fromEntries(
                  Object.entries({ ...latestGroup.inputs, ...context.group.inputs }).map(
                    ([id, input]) => {
                      const latestInput = latestGroup.inputs?.[id];
                      const selected =
                        latestInput?.admission === "accepted" ||
                        latestInput?.admission === "rejected"
                          ? latestInput
                          : input;
                      // 流事件可能先于 admission 返回；写回接收结果时保留已推进的卡片状态。
                      return [
                        id,
                        { ...selected, progress: latestInput?.progress ?? selected.progress },
                      ];
                    },
                  ),
                ),
                taskWorkspaces: { ...latestGroup.taskWorkspaces, ...context.group.taskWorkspaces },
                topicAliases: latestGroup.topicAliases,
                deliveries: latestGroup.deliveries,
              }
            : context.group;
        // 自动互答次数由入口串行持久化；迟到的任务/授权回写不能用旧快照恢复额度。
        if (group && latestGroup?.autoReplyGuard) group.autoReplyGuard = latestGroup.autoReplyGuard;
        // 背景检查点由入口/接收提交更新，旧任务快照不能覆盖或复活它。
        if (group && latestGroup) group.backgroundHistory = latestGroup.backgroundHistory;
        if (group && (!group.enabled || state.bots[key]?.activeTaskId !== context.activeTaskId)) {
          group.deliveries = Object.fromEntries(
            Object.entries(group.deliveries ?? {}).map(([id, entry]) => [
              id,
              entry.status === "sent" ? entry : { ...entry, status: "invalidated" as const },
            ]),
          );
        }
        const taskIds =
          group && context.activeTaskId
            ? [...new Set([...group.taskIds, context.activeTaskId])]
            : group?.taskIds;
        state.bots[key] = {
          ...context,
          telegramOffset: latest?.telegramOffset ?? context.telegramOffset,
          weixinGetUpdatesBuf: latest?.weixinGetUpdatesBuf ?? context.weixinGetUpdatesBuf,
          ...(!group
            ? {
                privateBindingId:
                  latest?.activeTaskId === context.activeTaskId &&
                  getWorkspaceKey(latest.workspacePath, latest.workspaceIdentity) ===
                    getWorkspaceKey(context.workspacePath, context.workspaceIdentity)
                    ? (latest.privateBindingId ?? randomUUID())
                    : randomUUID(),
              }
            : {}),
          ...(group
            ? {
                group: {
                  ...group,
                  taskIds: taskIds!,
                  taskWorkspaces: {
                    ...group.taskWorkspaces,
                    ...(context.activeTaskId
                      ? {
                          [context.activeTaskId]: {
                            workspacePath: context.workspacePath,
                            workspaceIdentity: context.workspaceIdentity,
                          },
                        }
                      : {}),
                  },
                },
              }
            : {}),
          updatedAt: Date.now(),
        };
        if (updateAuthorization && group && !group.threadId) {
          // 群授权是单一权威；停用或换绑必须在同一次写入中使所有话题卡片失效。
          for (const [topicKey, topic] of Object.entries(state.bots)) {
            if (
              topic.botId !== context.botId ||
              topic.group?.chatId !== group.chatId ||
              !topic.group.threadId
            )
              continue;
            stopGroupSynchronization(topic);
            state.bots[topicKey] = {
              ...topic,
              group: {
                ...topic.group,
                enabled: group.enabled,
                ownerId: group.ownerId,
                authorizationId: group.authorizationId,
                deliveries: Object.fromEntries(
                  Object.entries(topic.group.deliveries ?? {}).map(([id, result]) => [
                    id,
                    result.status === "sent"
                      ? result
                      : { ...result, status: "invalidated" as const },
                  ]),
                ),
              },
            };
          }
        }
        await repo.writeState(state);
      });
    stateWriteTail = next;
    await next;
    if (!context.group) {
      context.privateBindingId = (await repo.readState()).bots[context.botId]?.privateBindingId;
      await reconcilePrivateSynchronization(context.botId);
    }
    if (context.group)
      await deps.broadcastService
        ?.send({
          channel: "bots:group-state",
          payload: { botId: context.botId, chatId: context.group.chatId },
        })
        .catch(() => undefined);
  }

  function privateSyncSupported(bot: BotConfig): boolean {
    return ["feishu", "lark", "telegram", "weixin"].includes(bot.provider);
  }

  function taskStreamKey(context: BotContextState, actor: BotActor): string {
    return [
      getWorkspaceKey(context.workspacePath, context.workspaceIdentity),
      context.activeTaskId,
      getBotConversationKey(actor),
    ].join("::");
  }

  async function reconcilePrivateSynchronization(botId: string): Promise<void> {
    const previous = privateReconciliations.get(botId) ?? Promise.resolve();
    const pending = previous
      .catch(() => undefined)
      .then(() => restorePrivateSynchronization(botId))
      .catch(async (error: unknown) => {
        const bot = findBot(await repo.readConfig(), botId);
        if (bot) onDeliveryResult(bot, error instanceof Error ? error.message : String(error));
        botsLogger.warn(undefined, `Private Bot subscription failed bot=${botId}`);
      });
    privateReconciliations.set(botId, pending);
    try {
      await pending;
    } finally {
      if (privateReconciliations.get(botId) === pending) privateReconciliations.delete(botId);
    }
  }

  async function restorePrivateSynchronization(botId: string): Promise<void> {
    const bot = findBot(await repo.readConfig(), botId);
    let context = (await repo.readState()).bots[botId];
    const recipient =
      bot?.provider === "weixin" ? context?.privateRecipientId : bot?.providerUserId;
    const valid =
      !shutdownPromise &&
      bot?.enabled &&
      recipient &&
      privateSyncSupported(bot) &&
      context &&
      !context.group &&
      context.mode === "task" &&
      context.activeTaskId &&
      isWorkspaceAllowed(
        context.workspaceId ?? getWorkspaceKey(context.workspacePath, context.workspaceIdentity),
        bot.allowedWorkspaces,
      ) &&
      (await isRemoteWorkspaceConnected(context));
    if (valid && context && !context.privateBindingId) {
      await serializeStateWrite(async () => {
        const state = await repo.readState();
        const latest = state.bots[botId];
        if (latest && !latest.privateBindingId) {
          state.bots[botId] = { ...latest, privateBindingId: randomUUID() };
          await repo.writeState(state);
        }
      });
      context = (await repo.readState()).bots[botId];
    }
    const signature = valid
      ? JSON.stringify([
          context?.privateBindingId,
          bot?.provider,
          recipient,
          context?.activeTaskId,
          context?.workspacePath,
          context?.workspaceIdentity,
        ])
      : "";
    const existing = privateWatches.get(botId);
    if (existing && existing.signature !== signature) {
      streamSubscriptions.get(existing.key)?.dispose();
      streamSubscriptions.delete(existing.key);
      privateWatches.delete(botId);
      failedPrivateDeliveries.delete(botId);
      const runtime = runtimeByBotId.get(botId);
      if (runtime)
        setRuntimeStatus({ ...runtime, deliveryRetryId: undefined, deliveryError: undefined });
    }
    if (!valid || !bot || !context || !signature || privateWatches.has(botId)) return;
    if (!(await isRemoteWorkspaceConnected(context))) return;
    const taskService = await resolveZCodeTaskServiceForContext(context);
    const deleted = await taskService.listDeletedTaskIds?.({
      workspacePath: context.workspacePath,
      workspaceIdentity: context.workspaceIdentity,
    });
    if (deleted?.includes(context.activeTaskId!)) return;
    // 只读取权威快照以冷恢复，不提交输入，也不回放快照中的历史正文。
    await taskService.getTaskSnapshot({
      taskId: context.activeTaskId!,
      workspacePath: context.workspacePath,
      workspaceIdentity: context.workspaceIdentity,
      clientMode: "desktop-continuous",
    });
    if (shutdownPromise) return;
    const actor: BotActor = {
      botId,
      provider: bot.provider,
      providerUserId: recipient!,
      chatType: "private",
    };
    const key = taskStreamKey(context, actor);
    await watchTaskStream(bot, actor, context, bot);
    privateWatches.set(botId, { signature, key });
  }

  function weixinContextKey(bot: BotConfig, userId: string): string {
    // 凭证按账号和接收人隔离；不进入普通 Bot 状态或日志。
    return `bot-weixin-context-${createHash("sha256")
      .update(JSON.stringify([bot.id, bot.providerUserId, bot.credentialRef, userId]))
      .digest("hex")}`;
  }

  async function capturePrivateContextToken(message: BotInboundMessage): Promise<void> {
    if (message.actor.provider !== "weixin" || message.actor.chatType !== "private") return;
    const bot = findAuthorizedBot(await repo.readConfig(), message.actor);
    if (!bot || bot.id !== message.botId) return;
    const context = await readContext(message.actor, bot);
    if (!context) return;
    // iLink 的 config.providerUserId 是机器人身份，不能把它当成出站接收人。
    await serializeStateWrite(async () => {
      const state = await repo.readState();
      const latest = state.bots[bot.id];
      if (!latest) return;
      if (latest.privateRecipientId !== message.actor.providerUserId) {
        state.bots[bot.id] = {
          ...latest,
          privateRecipientId: message.actor.providerUserId,
          privateBindingId: randomUUID(),
        };
        await repo.writeState(state);
      }
    });
    if (message.actor.providerContextToken)
      await deps.credentialService.save(
        weixinContextKey(bot, message.actor.providerUserId),
        message.actor.providerContextToken,
      );
    await reconcilePrivateSynchronization(bot.id);
  }

  function stopGroupSynchronization(context: BotContextState): void {
    if (!context.group || !context.activeTaskId) return;
    const key = [
      getWorkspaceKey(context.workspacePath, context.workspaceIdentity),
      context.activeTaskId,
      getBotStateKey(context),
    ].join("::");
    streamSubscriptions.get(key)?.dispose();
    streamSubscriptions.delete(key);
  }

  async function restoreGroupSynchronization(context: BotContextState): Promise<void> {
    if (!context.group?.enabled || !context.activeTaskId || shutdownPromise) return;
    const bot = findBot(await repo.readConfig(), context.botId);
    if (
      !bot?.enabled ||
      !isFeishuBotProvider(bot.provider) ||
      bot.providerUserId !== context.group.ownerId
    )
      return;
    // 恢复仅订阅后续事件；远端断开时不建立新连接，也不重放已接收输入。
    if (!(await isRemoteWorkspaceConnected(context))) return;
    await watchTaskStream(
      bot,
      {
        botId: bot.id,
        provider: bot.provider,
        chatType: "group",
        chatId: context.group.chatId,
        threadId: context.group.threadId,
        rootMessageId: context.group.rootMessageId,
        providerUserId: context.group.ownerId,
      },
      context,
      { ...bot, currentOptions: context.group.currentOptions, replyMode: "summary_changes" },
    );
  }

  async function handleGroupActivation(
    message: BotInboundMessage,
    enabled: boolean,
  ): Promise<BotOutboundMessage[]> {
    const locale = await readMessageLocale();
    const config = await repo.readConfig();
    const bot = findBot(config, message.botId);
    if (
      !bot?.enabled ||
      !isFeishuBotProvider(bot.provider) ||
      message.actor.chatType !== "group" ||
      !message.actor.chatId
    ) {
      return [createOutbound(message.actor, msg(locale, "privateChatOnly"))];
    }
    if (bot.providerUserId !== message.actor.providerUserId) {
      return [
        {
          ...administratorReply(
            message.actor,
            bot,
            "owner-command",
            createOutbound(message.actor, msg(locale, "groupOwnerOnly")),
          ),
          callbackToastOnly: true,
        },
      ];
    }
    // 群启用不等于平台授权；首次与再次启用都提供同一权限入口。
    const activationValues = {
      permissionsUrl:
        bot.provider === "lark" ? "https://open.larksuite.com/app" : "https://open.feishu.cn/app",
    };
    const key = getBotConversationKey({
      ...message.actor,
      threadId: undefined,
      conversationThreadId: undefined,
    });
    const existing = (await repo.readState()).bots[key];
    if (existing?.group?.ownerId === bot.providerUserId) {
      if (existing.group.enabled !== enabled) {
        stopGroupSynchronization(existing);
        const updated = {
          ...existing,
          group: { ...existing.group, enabled, authorizationId: randomUUID() },
        };
        await writeContext(updated, true);
        if (!enabled) await cancelGroupTopicInputs(message.actor);
        if (enabled) {
          for (const candidate of Object.values((await repo.readState()).bots)) {
            if (candidate.botId === bot.id && candidate.group?.chatId === message.actor.chatId)
              await restoreGroupSynchronization(candidate);
          }
        }
      }
      return [
        createOutbound(
          message.actor,
          msg(locale, enabled ? "groupEnabled" : "groupDisabled", activationValues),
        ),
      ];
    }
    if (!enabled) return [createOutbound(message.actor, msg(locale, "groupDisabled"))];
    const privateContext = await readContext(
      { ...message.actor, chatType: "private", chatId: undefined },
      bot,
    );
    if (!privateContext)
      return [
        administratorReply(
          message.actor,
          bot,
          "workspace",
          createOutbound(message.actor, msg(locale, "noWorkspaceAllowed")),
        ),
      ];
    const inherited = await buildActiveTaskDraftOptions(privateContext);
    const info = await providers[bot.provider]?.getGroupInfo?.(bot, message.actor.chatId);
    const context: BotContextState = {
      botId: bot.id,
      workspacePath: privateContext.workspacePath,
      workspaceIdentity: privateContext.workspaceIdentity,
      workspaceId: privateContext.workspaceId,
      mode: "draft",
      activeTaskId: null,
      updatedAt: Date.now(),
      draftOptions: { ...inherited, mode: "default" },
      group: {
        chatId: message.actor.chatId,
        chatMode: info?.chatMode,
        name: info?.name ?? message.actor.chatId,
        ownerId: bot.providerUserId!,
        enabled: true,
        authorizationId: randomUUID(),
        taskIds: [],
        currentOptions: {
          // 模型重构后需继承完整选择，旧 model/thoughtLevel 字段已不再持久化。
          modelSelection: bot.currentOptions.modelSelection,
          mode: "default",
        },
      },
    };
    await writeContext(context, true);
    return [createOutbound(message.actor, msg(locale, "groupEnabled", activationValues))];
  }

  async function handleGroupHistory(
    message: BotInboundMessage,
    enabled?: boolean,
  ): Promise<BotOutboundMessage[]> {
    const auth = await withAuthorizedContext(message, "workspace");
    if (!auth.ok) return auth.reply;
    if (!auth.context.group)
      return [
        createOutbound(
          message.actor,
          auth.locale === "en-US"
            ? "Topic history is configured in a group."
            : "请在群里配置话题历史读取。",
        ),
      ];
    const key = getBotConversationKey({
      ...message.actor,
      threadId: undefined,
      conversationThreadId: undefined,
    });
    let active = false;
    await serializeStateWrite(async () => {
      const state = await repo.readState();
      const parent = state.bots[key];
      if (!parent?.group?.enabled || parent.group.ownerId !== message.actor.providerUserId)
        throw new Error("Group authorization changed");
      if (enabled !== undefined) {
        parent.group.historyEnabled = enabled;
        await repo.writeState(state);
      }
      if (enabled !== undefined) {
        const key = JSON.stringify([message.botId, parent.group.chatId]);
        groupHistoryEpoch.set(key, (groupHistoryEpoch.get(key) ?? 0) + 1);
      }
      active = parent.group.historyEnabled !== false;
    });
    if (enabled === false) await cancelGroupTopicInputs(message.actor);
    return [
      createOutbound(
        message.actor,
        auth.locale === "en-US"
          ? active
            ? "Topic history enabled. The next topic input reconciles discussion history."
            : "Topic history is off. Topic input is paused."
          : active
            ? "已开启话题历史读取。下次话题输入会补齐讨论历史。"
            : "话题历史读取已关闭，话题输入已暂停。",
      ),
    ];
  }

  async function writeDraftContext(
    context: BotContextState,
    draftOptions?: BotDraftOptions,
  ): Promise<BotContextState> {
    // Bugfix: 新建草稿状态以前散落在 /new 和 /workspace 分支里，各自手写 activeTaskId=null。
    // workspace 切换后如果还带着旧 task/pending permission，Telegram 权限按钮会命中错误上下文。
    // 这里把“进入新任务草稿”的服务端状态变更收口到同一个 helper，避免跨 workspace 复用旧任务状态。
    const draftContext: BotContextState = {
      ...context,
      mode: "draft",
      activeTaskId: null,
      draftOptions,
      pendingPermissionOptions: undefined,
      pendingElicitation: undefined,
    };
    if (context.group) {
      const prefix = `${context.botId}::`;
      for (const key of pendingSelectionsByContext.keys()) {
        if (key.startsWith(prefix) && key.includes(`::${context.group.chatId}::`)) {
          pendingSelectionsByContext.delete(key);
          pendingTaskSelectionsByContext.delete(key);
          pendingWorkspaceSelectionsByContext.delete(key);
        }
      }
    } else clearPrivatePendingSelectionsForBot(context.botId);
    await writeContext(draftContext);
    stopGroupSynchronization(context);
    return draftContext;
  }

  async function handleWeixinFirstActivation(
    message: BotInboundMessage,
    command: BotCommand,
  ): Promise<BotOutboundMessage[] | null> {
    if (message.actor.provider !== "weixin" || command.type !== "message") {
      return null;
    }
    const state = await repo.readState();
    const existing = state.bots[message.botId];
    if (
      existing?.weixinActivatedAt ||
      existing?.draftOptions ||
      existing?.activeTaskId ||
      existing?.pendingPermissionOptions ||
      existing?.pendingElicitation
    ) {
      return null;
    }
    const auth = await withAuthorizedContext(message, "help");
    if (!auth.ok) {
      return auth.reply;
    }
    if (auth.context.weixinActivatedAt) {
      return null;
    }
    // Bugfix: 微信扫码登录只返回 bot token/id，不返回可投递的用户 id。
    // 第一条微信入站消息用于建立会话目标，因此只回激活说明，不把“你好”这类激活文本误当成任务 prompt。
    await writeContext({
      ...auth.context,
      weixinActivatedAt: Date.now(),
    });
    return [
      createOutbound(
        message.actor,
        [msg(auth.locale, "weixinActivatedWelcome"), buildHelpText(auth.locale, auth.bot)].join(
          "\n\n",
        ),
      ),
    ];
  }

  const adminAttention = createGroupAdminAttention();

  function administratorReply(
    actor: BotActor,
    bot: Pick<BotConfig, "providerUserId">,
    reason: string,
    reply: BotOutboundMessage,
  ): BotOutboundMessage {
    if (actor.chatType !== "group") return reply;
    const mentionedUserIds = adminAttention.mention(actor, bot.providerUserId, reason);
    return { ...reply, mentionedUserIds, administratorAttention: !!mentionedUserIds?.length };
  }

  function administratorErrorReply(
    actor: BotActor,
    bot: BotConfig | null | undefined,
    error: unknown,
    reply: BotOutboundMessage,
  ): BotOutboundMessage {
    if (!bot || actor.chatType !== "group" || !(error instanceof BotAdminRequiredError))
      return reply;
    const hint =
      error.reason === "model"
        ? cachedLocale === "en-US"
          ? "Please check this conversation's model configuration."
          : "请机器人管理员检查当前会话的模型配置。"
        : undefined;
    return administratorReply(
      actor,
      bot,
      error.reason,
      hint ? { ...reply, text: `${reply.text}\n\n${hint}` } : reply,
    );
  }

  async function readMessageLocale(): Promise<Locale | undefined> {
    const settings = await deps.settingService?.get().catch(() => null);
    // 机器人消息只有中英两套，下游大量 `locale === "en-US"` 判断；ja-JP/ru-RU/ko-KR 等
    // 非中文界面语言在这里统一收敛成 en-US，否则会落到中文分支。
    cachedLocale = settings?.locale ? toZhOrEnLocale(settings.locale) : cachedLocale;
    return cachedLocale;
  }

  function msg(
    locale: Locale | undefined,
    id: BotMessageId,
    values?: Record<string, string | number | undefined>,
  ): string {
    return formatBotMessage(locale, id, values);
  }

  function isSessionExpiredError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? "");
    return /\bSession (not found|is not active):/i.test(message);
  }

  function formatUserFacingBotError(error: unknown, locale: Locale | undefined): string {
    // 旧 Worker 缺少选模并发保护时保持拒绝，用稳定错误码提示升级，不自动重发。
    if (isZCodeAgentModelSelectionBasisUnsupportedError(error)) {
      return msg(locale, "modelSelectionBasisUnsupported");
    }
    // Bugfix: 旧 bot 消息或脏 task index 会让协议层抛出 Session not found。
    // 直接把 session id 发给用户不可操作；这里保留日志原文，只引导用户新建任务恢复。
    if (isSessionExpiredError(error)) {
      return msg(locale, "sessionExpiredNewTaskHint");
    }
    return error instanceof Error ? error.message : String(error);
  }

  function sanitizeAttachmentFilename(filename: string): string {
    const normalized = Array.from(filename.trim())
      .map((char) => (char.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(char) ? "_" : char))
      .join("");
    return normalized.length > 0 ? normalized.slice(0, 160) : "attachment";
  }

  function formatAttachmentSize(sizeBytes: number | undefined): string {
    if (!sizeBytes || sizeBytes <= 0) {
      return "unknown size";
    }
    if (sizeBytes >= 1024 * 1024) {
      return `${(sizeBytes / (1024 * 1024)).toFixed(1)}MB`;
    }
    if (sizeBytes >= 1024) {
      return `${Math.ceil(sizeBytes / 1024)}KB`;
    }
    return `${sizeBytes}B`;
  }

  function formatAttachmentRejectedReason(error: unknown, locale: Locale | undefined): string {
    const message = error instanceof Error ? error.message : String(error);
    if (
      /attachment download failed/i.test(message) ||
      /file download failed/i.test(message) ||
      /download .+ failed: HTTP/i.test(message) ||
      /file download timed out/i.test(message) ||
      /attachment download timed out/i.test(message) ||
      /download .+ timed out/i.test(message)
    ) {
      // Bugfix: provider 下载错误会包含 Feishu/Telegram/HTTP 等内部细节，直接回给用户既不友好也不可行动。
      return msg(locale, "attachmentDownloadUnavailable");
    }
    return message;
  }

  function buildAttachmentCachePath(params: {
    botId: string;
    providerMessageId?: string;
    attachment: BotInboundAttachment;
  }): string {
    const messageKey = params.providerMessageId?.trim() || `message-${Date.now()}`;
    const digest = createHash("sha256")
      .update(`${params.botId}:${messageKey}:${params.attachment.id}`)
      .digest("hex")
      .slice(0, 16);
    return join(
      getAppConfigDir(),
      "bot-attachments",
      sanitizeAttachmentFilename(params.botId),
      sanitizeAttachmentFilename(messageKey),
      `${digest}-${sanitizeAttachmentFilename(params.attachment.filename)}`,
    );
  }

  async function fetchAttachmentDownloadUrl(
    attachment: BotInboundAttachment,
  ): Promise<Uint8Array | null> {
    if (!attachment.downloadUrl) {
      return null;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), BOT_ATTACHMENT_DOWNLOAD_TIMEOUT_MS);
    try {
      const response = await fetch(attachment.downloadUrl, {
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`download ${attachment.filename} failed: HTTP ${response.status}`);
      }
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      if ((error as { name?: unknown })?.name === "AbortError") {
        // Bugfix: 附件下载卡住时必须尽快失败并回复用户，不能让 bot 回调一直悬挂。
        throw new Error(`download ${attachment.filename} timed out.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function resolveAttachmentBytes(
    bot: BotConfig,
    attachment: BotInboundAttachment,
    actor: BotActor,
  ): Promise<{ attachment: BotInboundAttachment; data: Uint8Array } | null> {
    if (attachment.dataBase64) {
      return {
        attachment,
        data: Buffer.from(attachment.dataBase64, "base64"),
      };
    }
    if (attachment.localPath) {
      return {
        attachment,
        data: await readFile(attachment.localPath),
      };
    }
    const provider = providers[bot.provider];
    const downloaded = await provider?.downloadAttachment?.(bot, attachment, actor);
    if (downloaded) {
      return downloaded;
    }
    const fromUrl = await fetchAttachmentDownloadUrl(attachment);
    return fromUrl ? { attachment, data: fromUrl } : null;
  }

  async function cacheResolvedAttachment(params: {
    bot: BotConfig;
    message: BotInboundMessage;
    attachment: BotInboundAttachment;
    data: Uint8Array;
  }): Promise<BotInboundAttachment> {
    const localPath = buildAttachmentCachePath({
      botId: params.bot.id,
      providerMessageId: params.message.actor.providerMessageId,
      attachment: params.attachment,
    });
    await mkdir(dirname(localPath), { recursive: true });
    await writeFile(localPath, params.data);
    return {
      ...params.attachment,
      localPath,
      sizeBytes: params.data.byteLength,
    };
  }

  async function prepareBotMessageContent(
    bot: BotConfig,
    message: BotInboundMessage,
    locale: Locale | undefined,
  ): Promise<PreparedBotMessageContent> {
    const isGroup = message.actor.chatType === "group";
    if (isGroup && (message.attachments?.length ?? 0) > BOT_MAX_ATTACHMENTS_PER_MESSAGE) {
      throw new Error(
        locale === "en-US"
          ? "Attach at most 4 files per message."
          : "每条消息最多提交 4 个附件，请拆分后发送。",
      );
    }
    const rawAttachments = (message.attachments ?? []).slice(0, BOT_MAX_ATTACHMENTS_PER_MESSAGE);
    const zcodeAttachments: ZCodePromptAttachment[] = [];
    const fileLines: string[] = [];
    for (const rawAttachment of rawAttachments) {
      const resolved = await resolveAttachmentBytes(bot, rawAttachment, message.actor);
      if (!resolved) {
        if (isGroup) throw new Error("attachment download failed");
        fileLines.push(
          `附件：${rawAttachment.filename} (${rawAttachment.mimeType}, ${formatAttachmentSize(rawAttachment.sizeBytes)})，未能下载。`,
        );
        continue;
      }
      // 旧 5 MiB 上限会拒绝平台已成功下载的文件；Bot 不再额外限大小，沿用缓存与下游附件校验。
      const cached = await cacheResolvedAttachment({
        bot,
        message,
        attachment: resolved.attachment,
        data: resolved.data,
      });
      const dataBase64 = Buffer.from(resolved.data).toString("base64");
      if (isGroup) {
        // 旧兼容入口只把文件路径拼进正文，既丢失 V4 附件又破坏末尾引用块；群输入只走标准寄存。
        zcodeAttachments.push({
          kind: cached.kind === "image" || cached.kind === "audio" ? cached.kind : "file",
          filename: cached.filename,
          mimeType: cached.mimeType,
          sizeBytes: resolved.data.byteLength,
          dataBase64,
          localPath: cached.localPath,
        });
        continue;
      }
      if (cached.kind === "image" || cached.kind === "audio") {
        zcodeAttachments.push({
          kind: cached.kind,
          filename: cached.filename,
          mimeType: cached.mimeType,
          dataBase64,
          // Bugfix：Bot 已把附件缓存到本地，ZCodePromptAttachment 也必须携带该路径。
          // 只在 prompt 文本里描述路径会让下游附件策略无法选择本地文件读取。
          localPath: cached.localPath,
        });
        // Bugfix: bot 附件已经被 gateway 下载并缓存到本地。只把图片作为 ZCode Agent image block 传入时，
        // 下游 agent 可能把内部临时 URL 再 curl 到 /tmp，导致重复下载、额外权限请求和模型安全拦截。
        // 因此同时把本地缓存路径写进 prompt，明确后续工具操作只能围绕本地文件进行。
        fileLines.push(
          `附件：${cached.filename} (${cached.mimeType}, ${formatAttachmentSize(cached.sizeBytes)})，已作为${cached.kind === "image" ? "图片" : "音频"}输入提供，并保存到：${cached.localPath}。如需读取附件，请直接使用这个本地路径，不要下载或访问临时/远程 URL。`,
        );
        continue;
      }
      fileLines.push(
        `附件：${cached.filename} (${cached.mimeType}, ${formatAttachmentSize(cached.sizeBytes)})，已保存到：${cached.localPath}`,
      );
    }
    const trimmed = message.text.trim();
    const baseContent =
      trimmed || (rawAttachments.length > 0 ? msg(locale, "attachmentOnlyPrompt") : "");
    return {
      content: [baseContent, ...fileLines].filter(Boolean).join("\n\n"),
      zcodeAttachments,
    };
  }

  function requiresRemoteWorkspaceRuntime(requestedCommand: BotAuthorizedCommand): boolean {
    return (
      requestedCommand !== "help" &&
      requestedCommand !== "status" &&
      requestedCommand !== "workspace" &&
      requestedCommand !== "reconnect" &&
      requestedCommand !== "reply"
    );
  }

  async function isRemoteWorkspaceConnected(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity" | "hostId">,
  ): Promise<boolean> {
    if (!context.workspaceIdentity) {
      return true;
    }
    if (!deps.remoteWorkspaceService) {
      // Bugfix: 远端 workspace 没有注入重连服务时，不能默认当作已连接。
      // 否则 Bot 会继续使用缓存模型创建 task，最终在远端 API 层才暴露“模型不存在”等误导性错误。
      return false;
    }
    return deps.remoteWorkspaceService
      .isConnected({
        workspacePath: context.workspacePath,
        workspaceIdentity: context.workspaceIdentity,
        ...(context.hostId ? { hostId: context.hostId } : {}),
      })
      .catch(() => false);
  }

  async function reconnectRemoteWorkspaceForBot(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity" | "hostId">,
  ): Promise<BotRemoteWorkspaceReconnectResult> {
    if (!context.workspaceIdentity) {
      return { ok: true };
    }
    if (!deps.remoteWorkspaceService) {
      return {
        ok: false,
        message: "remote reconnect service unavailable",
      };
    }
    return deps.remoteWorkspaceService.ensureConnected({
      workspacePath: context.workspacePath,
      workspaceIdentity: context.workspaceIdentity,
      ...(context.hostId ? { hostId: context.hostId } : {}),
    });
  }

  async function resolveZCodeTaskServiceForContext(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity" | "hostId">,
  ): Promise<IZCodeTaskService> {
    if (!context.workspaceIdentity) {
      return deps.zcodeTaskService;
    }
    const remoteZCodeTaskService = await deps.remoteWorkspaceService?.getZCodeTaskService?.({
      workspacePath: context.workspacePath,
      workspaceIdentity: context.workspaceIdentity,
      ...(context.hostId ? { hostId: context.hostId } : {}),
    });
    if (remoteZCodeTaskService) {
      return remoteZCodeTaskService;
    }
    // Bugfix: 远端 workspace 的 bot 请求不能缺 runtime 时静默走本地 zcodeTaskService。
    // 否则 /root 这类远端路径会在 macOS/Windows 本地 host 创建任务，模型和文件系统都错位。
    throw new BotAdminRequiredError(
      "remote",
      `当前远端项目 ${context.workspacePath} runtime 不可用，请发送 **/重连** 后重试。`,
    );
  }

  async function resolveModelSelectionServiceForContext(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity" | "hostId">,
  ): Promise<Pick<IModelSelectionService, "getView">> {
    if (!context.workspaceIdentity) return deps.modelSelectionService;
    const service = await deps.remoteWorkspaceService?.getModelSelectionService?.({
      workspacePath: context.workspacePath,
      workspaceIdentity: context.workspaceIdentity,
      ...(context.hostId ? { hostId: context.hostId } : {}),
    });
    if (service) return service;
    throw new BotAdminRequiredError(
      "remote",
      `当前远端项目 ${context.workspacePath} runtime 不可用，请发送 **/重连** 后重试。`,
    );
  }

  async function blockDisconnectedRemoteWorkspace(params: {
    message: BotInboundMessage;
    context: BotContextState;
    locale: Locale | undefined;
    requestedCommand: BotAuthorizedCommand;
  }): Promise<BotOutboundMessage[] | null> {
    if (
      !params.context.workspaceIdentity ||
      !requiresRemoteWorkspaceRuntime(params.requestedCommand)
    ) {
      return null;
    }
    if (await isRemoteWorkspaceConnected(params.context)) {
      adminAttention.clear(params.message.actor, params.context.group?.ownerId, "remote");
      return null;
    }
    // Bugfix: 普通消息、配置修改和权限响应不应该隐式改变远端连接状态。
    // 远端恢复只允许显式 /reconnect 触发，避免同一条消息有时执行、有时只是在后台打开连接。
    return [
      administratorReply(
        params.message.actor,
        { providerUserId: params.context.group?.ownerId },
        "remote",
        createOutbound(
          params.message.actor,
          msg(params.locale, "remoteDisconnected", {
            workspacePath: params.context.workspacePath,
          }),
        ),
      ),
    ];
  }

  function currentOptionSuffix(locale: Locale | undefined): string {
    return locale === "en-US" ? "current" : "当前";
  }

  function formatReplyGranularityLabel(
    id: BotReplyGranularity | undefined,
    locale: Locale | undefined,
    provider?: BotProvider,
  ): string {
    const currentId = provider
      ? normalizeBotReplyGranularity(provider, id)
      : (id ?? getDefaultBotReplyGranularity());
    return (
      getReplyGranularityOptions(locale, provider).find((option) => option.id === currentId)
        ?.label ?? currentId
    );
  }

  function markCurrentSelection(
    selection: SelectionPrompt,
    locale: Locale | undefined,
  ): SelectionPrompt {
    const cancelLabel = msg(locale, "selectionCancelOption");
    if (!selection.currentId) {
      return { ...selection, cancelLabel };
    }
    const suffix = currentOptionSuffix(locale);
    return {
      ...selection,
      cancelLabel,
      options: selection.options.map((option) =>
        option.id === selection.currentId
          ? { ...option, label: `${option.label} · ${suffix}` }
          : option,
      ),
    };
  }

  async function listUserConfigOptions(
    _params: BotUserConfigOptionsParams,
  ): Promise<ZCodeConfigOption[]> {
    return [];
  }
  async function ensureBotStorageMigrated(): Promise<void> {
    // 单向导入已收口到 Repo；这里只等待初始化，不再读取旧模型字段或重写当前状态。
    if (!botStorageMigrationPromise) {
      botStorageMigrationPromise = Promise.all([repo.readConfig(), repo.readState()])
        .then(() => undefined)
        .catch((error: unknown) => {
          botStorageMigrationPromise = null;
          throw error;
        });
    }
    await botStorageMigrationPromise;
  }

  async function listActiveTaskConfigOptions(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity" | "hostId">,
    taskId: string,
  ): Promise<ZCodeConfigOption[]> {
    const zcodeTaskService = await resolveZCodeTaskServiceForContext(context);
    return zcodeTaskService.getTaskConfigOptions({ taskId });
  }

  function findSelectConfigOption(
    options: readonly ZCodeConfigOption[],
    configId: "model" | "mode" | "thoughtLevel",
  ): (ZCodeConfigOption & { type: "select" }) | undefined {
    const category = configId === "thoughtLevel" ? "thought_level" : configId;
    return options.find(
      (item): item is ZCodeConfigOption & { type: "select" } =>
        item.type === "select" && (item.category === category || item.id === category),
    );
  }

  function listConfigSelectOptions(
    options: readonly ZCodeConfigOption[],
    configId: "model" | "mode" | "thoughtLevel",
    context: { locale?: Locale; provider?: ZCodeProvider } = {},
  ): BotModelOption[] {
    const option = findSelectConfigOption(options, configId);
    return (option?.options ?? []).map((item) => {
      const baseOption = {
        id: item.value,
        label: item.name,
        description: item.description,
      };
      return {
        ...baseOption,
        // 保持 Bot 与工具栏的模式展示一致。
        label: formatConfigOptionLabel(baseOption, {
          configId,
          locale: context.locale,
          provider: context.provider,
        }),
      };
    });
  }

  function getConfigCommandMissingMessageId(configId: "mode" | "thoughtLevel"): BotMessageId {
    return configId === "mode" ? "modeMissing" : "thoughtLevelMissing";
  }

  function getModeDisplayLabel(
    locale: Locale | undefined,
    provider: ZCodeProvider | undefined,
    option: Pick<BotModelOption, "id" | "label">,
  ): string {
    if (!provider) {
      return option.label;
    }
    const isEnglish = locale === "en-US";
    const labels: Partial<Record<ZCodeProvider, Record<string, string>>> = {
      glm: {
        default: isEnglish ? "Default" : "默认",
        yolo: "Yolo",
        plan: isEnglish ? "Plan" : "计划",
      },
    };
    return labels[provider]?.[option.id] ?? option.label;
  }

  function formatConfigOptionLabel(
    option: BotModelOption,
    context: {
      configId: "model" | "mode" | "thoughtLevel";
      locale?: Locale;
      provider?: ZCodeProvider;
    },
  ): string {
    if (context.configId !== "mode") {
      return option.label;
    }
    return getModeDisplayLabel(context.locale, context.provider, option);
  }

  function createModelSelectionProviderOption(
    provider: ModelSelectionView["providers"][number],
  ): BotModelProviderOption {
    return {
      id: provider.providerId,
      label: provider.providerName?.trim() || provider.providerId,
      models: provider.models.map((model) => ({
        id: encodeCustomModelValue(provider.providerId, model.modelId),
        label: model.modelId,
      })),
    };
  }

  async function readModelSelectionView(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity" | "hostId">,
    selection?: ModelSelection,
  ): Promise<ModelSelectionView | null> {
    const service = await resolveModelSelectionServiceForContext(context).catch(() => null);
    if (!service) return null;
    return service.getView
      .call(service, selection ? { selection } : undefined)
      .catch((error: unknown) => {
        botsLogger.warn(
          undefined,
          `read model selection view for bot model display failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      });
  }

  async function listModelSelectionProviderOptions(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity" | "hostId">,
  ): Promise<BotModelProviderOption[]> {
    const view = await readModelSelectionView(context);
    // 旧缓存没有 workspaceIdentity 隔离，远端断连时会显示其他 Host 的候选。
    // 当前菜单只消费目标 View；失败留空，下一次正常读取即可恢复，不借本地补选。
    if (!view) return [];
    return view.providers
      .map(createModelSelectionProviderOption)
      .filter((provider) => provider.models.length > 0);
  }

  async function listModelProviderOptionsForActiveTask(
    task: Pick<ZCodeTaskMeta, "model" | "workspacePath" | "workspaceIdentity">,
    _activeProvider: ZCodeProvider,
  ): Promise<BotModelProviderOption[]> {
    return listModelSelectionProviderOptions(task);
  }

  async function listModelOptionsForProviderFromActiveTask(
    task: Pick<ZCodeTaskMeta, "model" | "workspacePath" | "workspaceIdentity">,
    activeProvider: ZCodeProvider,
    providerId: string,
  ): Promise<BotModelOption[]> {
    return (
      (await listModelProviderOptionsForActiveTask(task, activeProvider)).find(
        (provider) => provider.id === providerId,
      )?.models ?? []
    );
  }

  function readModelProviderSelectionModels(provider: unknown): BotModelOption[] {
    const models = isRecord(provider) ? provider.models : undefined;
    if (!Array.isArray(models)) {
      return [];
    }
    return models.filter(
      (model): model is BotModelOption =>
        isRecord(model) && typeof model.id === "string" && typeof model.label === "string",
    );
  }

  async function listAllModelOptionsForActiveTask(
    task: Pick<ZCodeTaskMeta, "model" | "workspacePath" | "workspaceIdentity">,
    activeProvider: ZCodeProvider,
  ): Promise<BotModelOption[]> {
    return (await listModelProviderOptionsForActiveTask(task, activeProvider)).flatMap(
      (provider) => provider.models,
    );
  }

  function readCurrentActiveTaskModel(
    task: Pick<ZCodeTaskMeta, "model">,
    options: readonly ZCodeConfigOption[],
  ): string | undefined {
    return readConfigSelectCurrentValue(options, "model") ?? task.model;
  }

  async function formatStatusModelLabel(
    model: string | undefined,
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity" | "hostId">,
  ): Promise<string> {
    if (!model) {
      return "-";
    }
    const customModel = decodeCustomModelValue(model);
    if (customModel?.providerId) {
      const modelSelectionOptions = await listModelSelectionProviderOptions(context);
      const providerLabel = modelSelectionOptions.find(
        (item) => item.id === customModel.providerId,
      )?.label;
      if (providerLabel && customModel.modelName) {
        return `${providerLabel}/${customModel.modelName}`;
      }
      return providerLabel ?? model;
    }
    const separatorIndex = model.indexOf("/");
    if (separatorIndex <= 0 || separatorIndex === model.length - 1) {
      return model;
    }
    const providerId = model.slice(0, separatorIndex);
    const modelName = model.slice(separatorIndex + 1);
    const modelSelectionOptions = await listModelSelectionProviderOptions(context);
    const providerLabel = modelSelectionOptions.find((item) => item.id === providerId)?.label;
    // Bugfix: /status 只应该暴露用户能识别的模型供应商名称。
    // 旧 bot-state 或 task config 可能保存成 providerId/modelId，providerId 对用户没有意义。
    return providerLabel ? `${providerLabel}/${modelName}` : model;
  }

  async function readCurrentModelProviderId(
    task: Pick<ZCodeTaskMeta, "model" | "workspacePath" | "workspaceIdentity">,
    options: readonly ZCodeConfigOption[],
    activeProvider: ZCodeProvider,
  ): Promise<string | undefined> {
    const currentValue = readCurrentActiveTaskModel(task, options);
    if (!currentValue) {
      return undefined;
    }
    const customModel = decodeCustomModelValue(currentValue);
    if (customModel?.providerId) {
      return customModel.providerId;
    }
    return (
      (await listModelProviderOptionsForActiveTask(task, activeProvider)).find((provider) =>
        provider.models.some((model) => model.id === currentValue),
      )?.id ?? getNativeModelProviderId(activeProvider)
    );
  }

  function resolveCustomModelRuntimeModelId(
    _activeProvider: ZCodeProvider,
    customModel: { providerId: string; modelName?: string },
  ): string | undefined {
    if (!customModel.modelName) {
      return undefined;
    }
    return customModel.modelName;
  }

  function readConfigSelectCurrentValue(
    options: readonly ZCodeConfigOption[],
    configId: "model" | "mode" | "thoughtLevel",
  ): string | undefined {
    const currentValue = findSelectConfigOption(options, configId)?.currentValue;
    return typeof currentValue === "string" ? currentValue : undefined;
  }

  function resolveSupportedDraftMode(
    options: readonly ZCodeConfigOption[],
    mode: string | undefined,
    provider: ZCodeProvider,
  ): string | undefined {
    if (!mode) {
      return undefined;
    }
    return resolveProviderModeIdFromConfigOptions({
      configOptions: options,
      modeId: mode,
      provider,
    })
      ? mode
      : undefined;
  }

  function readConfigSelectCurrentLabel(
    options: readonly ZCodeConfigOption[],
    configId: "model" | "mode" | "thoughtLevel",
    context: { locale?: Locale; provider?: ZCodeProvider } = {},
  ): string | undefined {
    const currentValue = readConfigSelectCurrentValue(options, configId);
    if (!currentValue) {
      return undefined;
    }
    return (
      listConfigSelectOptions(options, configId, context).find(
        (option) => option.id === currentValue,
      )?.label ?? currentValue
    );
  }

  function readConfigSelectLabelForValue(
    options: readonly ZCodeConfigOption[],
    configId: "model" | "mode" | "thoughtLevel",
    value: string | undefined,
    context: { locale?: Locale; provider?: ZCodeProvider } = {},
  ): string | undefined {
    if (!value) {
      return undefined;
    }
    return (
      listConfigSelectOptions(options, configId, context).find((option) => option.id === value)
        ?.label ?? value
    );
  }

  function readCurrentActiveTaskMode(
    task: Pick<ZCodeTaskMeta, "mode">,
    options: readonly ZCodeConfigOption[],
  ): string | undefined {
    return readConfigSelectCurrentValue(options, "mode") ?? task.mode;
  }

  async function listProviderConfigOptionsForActiveTask(
    task: Pick<ZCodeTaskMeta, "workspacePath" | "workspaceIdentity">,
    activeProvider: ZCodeProvider,
  ): Promise<ZCodeConfigOption[]> {
    return listUserConfigOptions({
      workspacePath: task.workspacePath,
      workspaceIdentity: task.workspaceIdentity,
      provider: activeProvider,
    });
  }

  function normalizeBotDraftOptions(draftOptions: BotDraftOptions): BotDraftOptions {
    // Bugfix: bot-state 里可能还残留旧三方 CLI 草稿 provider。
    // 如果直接复用，/new 后首条消息会重新创建第三方 runtime，绕过 ZCode Agent 单一事实源。
    return {
      ...draftOptions,
      provider: normalizeAgentProviderToZCodeAgent(draftOptions.provider),
    };
  }

  async function buildInitializedDraftOptions(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity" | "hostId">,
    provider?: ZCodeProvider,
  ): Promise<BotDraftOptions> {
    const requestedProvider = normalizeAgentProviderToZCodeAgent(
      provider ?? DEFAULT_BOT_ZCODE_PROVIDER,
    );
    if (context.workspaceIdentity && !(await isRemoteWorkspaceConnected(context))) {
      // Bugfix: 远端断连时初始化草稿也不能偷偷申请远端 ZCode Agent runtime。
      // 只有 /reconnect 能恢复连接；草稿先保留最小默认值，重连成功后再刷新。
      return { provider: requestedProvider };
    }
    const resolvedProvider = requestedProvider;
    return {
      provider: resolvedProvider,
      mode: "group" in context && context.group ? "default" : BOT_FORCED_MODE,
    };
  }

  async function buildActiveTaskDraftOptions(context: BotContextState): Promise<BotDraftOptions> {
    const activeTask = await readContextActiveTaskMeta(context);
    if (!context.activeTaskId || !activeTask?.provider) {
      return context.draftOptions
        ? normalizeBotDraftOptions(context.draftOptions)
        : buildInitializedDraftOptions(context);
    }
    const configOptions = await listActiveTaskConfigOptions(context, context.activeTaskId).catch(
      () => [],
    );
    const resolvedProvider = normalizeAgentProviderToZCodeAgent(activeTask.provider);
    // Bot 硬锁 yolo：继承当前 task 时也强制 yolo，不沿用原 task 的 mode。
    const forcedMode = resolveSupportedDraftMode(
      configOptions,
      "group" in context && context.group ? "default" : BOT_FORCED_MODE,
      resolvedProvider,
    );
    // 继承的是领域选择，不是菜单显示值；显示值中的 $max 曾被误存为 modelId。
    // 由同一工作区的任务服务读取真实选择，保留 Provider、模型和显式思考等级。
    const taskService = await resolveZCodeTaskServiceForContext(context);
    const modelSelection = await taskService.getTaskModelSelection({
      taskId: context.activeTaskId,
    });
    return {
      provider: resolvedProvider,
      ...(modelSelection ? { modelSelection } : {}),
      ...(forcedMode ? { mode: forcedMode } : {}),
    };
  }

  async function ensureDraftOptions(context: BotContextState): Promise<BotDraftOptions> {
    if (context.draftOptions) {
      const normalizedDraftOptions = normalizeBotDraftOptions(context.draftOptions);
      if (normalizedDraftOptions.provider !== context.draftOptions.provider) {
        await writeContext({ ...context, draftOptions: normalizedDraftOptions });
      }
      return normalizedDraftOptions;
    }
    const draftOptions = await buildInitializedDraftOptions(context);
    await writeContext({ ...context, draftOptions });
    return draftOptions;
  }

  async function writeDraftOptions(
    context: BotContextState,
    draftOptions: BotDraftOptions,
  ): Promise<BotContextState> {
    const normalizedDraftOptions = normalizeBotDraftOptions(draftOptions);
    const nextContext: BotContextState = {
      ...context,
      mode: "draft",
      activeTaskId: null,
      draftOptions: normalizedDraftOptions,
    };
    await writeContext(nextContext);
    return nextContext;
  }

  async function resolveDraftOptionsForDisplay(context: BotContextState): Promise<BotDraftOptions> {
    const original = await ensureDraftOptions(context);
    const view = await readModelSelectionView(context, original.modelSelection);
    // 菜单也必须展示派发将使用的身份。这里只返回副本；查看菜单不能写回原草稿。
    return {
      ...original,
      modelSelection:
        (original.modelSelection ? view?.effectiveSelection : view?.preferredSelection) ??
        undefined,
    };
  }

  async function listDraftConfigOptions(
    context: BotContextState,
    draftOptions: BotDraftOptions,
    resolvedView?: ModelSelectionView | null,
  ): Promise<ZCodeConfigOption[]> {
    const view =
      resolvedView === undefined
        ? await readModelSelectionView(context, draftOptions.modelSelection)
        : resolvedView;
    const selection = draftOptions.modelSelection
      ? view?.effectiveSelection
      : view?.preferredSelection;
    if (!selection) return [];
    const model = view?.providers
      .find((provider) => provider.providerId === selection.providerId)
      ?.models.find((candidate) => candidate.modelId === selection.modelId);
    const spec = model?.config.optionSpecs.reasoningLevel;
    if (!spec) return [];
    return [
      {
        id: "thought_level",
        name: "Reasoning",
        category: "thought_level",
        type: "select",
        currentValue: selection.options?.reasoningLevel ?? "",
        options: spec.values.map((value) => ({ value, name: value })),
      },
    ];
  }

  async function applyDraftConfigOptions(
    context: BotContextState,
    taskId: string,
    traceId: string,
  ): Promise<void> {
    const draftOptions = context.draftOptions;
    if (!draftOptions) {
      return;
    }
    // Bugfix: workspace configOptions 描述的是切换前的工作区模型，不能用来校验新 task 的配置。
    // 例如 GLM 的 enabled 会被误下发给刚切换到的其他 provider 模型，导致首条微信消息回调失败。
    const configOptions = await listActiveTaskConfigOptions(context, taskId);
    const modeOption = configOptions.find(
      (option) => option.category === "mode" && option.type === "select",
    );
    // Bot 硬锁 yolo：无论草稿/继承的 mode 是什么，建 task 时一律下发 yolo。
    // 这是 mode 真正进入 agent session 的唯一咽喉，保证任何 bot task 都免交互权限。
    const forcedDraftMode = resolveSupportedDraftMode(
      configOptions,
      context.group ? (draftOptions.mode ?? "default") : BOT_FORCED_MODE,
      draftOptions.provider,
    );
    if ((modeOption?.id && forcedDraftMode) || context.group) {
      const zcodeTaskService = await resolveZCodeTaskServiceForContext(context);
      await zcodeTaskService.setMode({
        taskId,
        mode: (forcedDraftMode ?? "default") as ZCodeTaskMode,
      });
    } else if (modeOption?.id) {
      // provider 不支持 yolo（非 ZCode Agent）：保持其自身默认模式，避免首条消息回调失败。
      botsLogger.debug(
        traceId,
        `skip forced yolo mode unsupported provider=${draftOptions.provider}`,
      );
    }
  }

  function getActorContextKey(actor: BotActor): string {
    return [
      actor.botId,
      actor.provider,
      actor.chatId?.trim() || actor.providerUserId,
      ...(actor.threadId ? [actor.threadId] : []),
      ...(actor.chatType === "group" ? [actor.providerUserId] : []),
    ].join("::");
  }

  function clearPrivatePendingSelectionsForBot(botId: string): void {
    // 私聊新建不能清掉群成员的菜单；群 key 额外包含发送者这一段。
    const matchesBot = (contextKey: string): boolean =>
      contextKey === botId ||
      (contextKey.startsWith(`${botId}::`) &&
        contextKey.slice(botId.length + 2).split("::").length === 2);
    for (const contextKey of pendingSelectionsByContext.keys()) {
      if (matchesBot(contextKey)) {
        pendingSelectionsByContext.delete(contextKey);
      }
    }
    for (const contextKey of pendingTaskSelectionsByContext.keys()) {
      if (matchesBot(contextKey)) {
        pendingTaskSelectionsByContext.delete(contextKey);
      }
    }
    for (const contextKey of pendingWorkspaceSelectionsByContext.keys()) {
      if (matchesBot(contextKey)) {
        pendingWorkspaceSelectionsByContext.delete(contextKey);
      }
    }
  }

  function resolvePendingSelectionOption(
    actor: BotActor,
    action: SelectionPrompt["action"],
    value: string,
  ): SelectionPrompt["options"][number] | null {
    const actorContextKey = getActorContextKey(actor);
    const selection = pendingSelectionsByContext.get(actorContextKey);
    if (selection?.action !== action) {
      return null;
    }
    const option = resolveOptionByValue(selection.options, value);
    if (option) {
      pendingSelectionsByContext.delete(actorContextKey);
    }
    return option;
  }

  function clearPendingSelection(actor: BotActor): void {
    const actorContextKey = getActorContextKey(actor);
    pendingSelectionsByContext.delete(actorContextKey);
    pendingTaskSelectionsByContext.delete(actorContextKey);
    pendingWorkspaceSelectionsByContext.delete(actorContextKey);
  }

  function resolvePendingSelectionCommand(actor: BotActor, value: string): BotCommand | null {
    const actorContextKey = getActorContextKey(actor);
    const selection = pendingSelectionsByContext.get(actorContextKey);
    if (!selection) {
      return null;
    }
    if (actor.provider !== "weixin") {
      // Bugfix: 只有微信没有结构化选项，只能靠“回复数字”承接 pending selection。
      // Telegram/飞书等 provider 有按钮回调，普通文本不应被隐式解析成菜单选择。
      clearPendingSelection(actor);
      return null;
    }
    if (!isSelectionIndexValue(value)) {
      // Bugfix: /task 等列表命令会留下 pending selection。
      // 旧逻辑允许普通文本按 label 命中选项，用户输入与 task 标题同名的消息时会被误切 task。
      // 隐式选择只接受纯数字；按 id/label 选择仍通过显式 /task <value> 等命令完成。
      clearPendingSelection(actor);
      return null;
    }
    const option = resolveOptionByValue(selection.options, value);
    if (!option) {
      clearPendingSelection(actor);
      return null;
    }
    pendingSelectionsByContext.delete(actorContextKey);
    switch (selection.action) {
      case "queue.cancel":
        return parseBotCommand(option.id);
      case "workspace.set":
        return { type: "workspace.set", value: option.id };
      case "model.provider.set":
        return { type: "model.provider.set", value: option.id };
      case "model.set":
        return { type: "model.set", value: option.id };
      case "mode.set":
        return { type: "mode.set", value: option.id };
      case "thoughtLevel.set":
        return { type: "thoughtLevel.set", value: option.id };
      case "task.set":
        return { type: "task.set", value: option.id };
      case "reply.set":
        return { type: "reply.set", value: option.id };
      case "permission.respond":
        return { type: "permission.respond", value };
      case "elicitation.respond":
        return { type: "elicitation.respond", value: option.id };
    }
  }

  function shouldUseTransientInteractionCard(bot: BotConfig, user: BotConfig): boolean {
    const adapter = providers[bot.provider];
    return (
      isFeishuBotProvider(bot.provider) &&
      normalizeBotReplyGranularity(bot.provider, user.replyMode) === "streaming_card" &&
      Boolean(adapter?.createTransientInteractionCard) &&
      Boolean(adapter?.updateTransientInteractionCard)
    );
  }

  async function upsertTransientInteractionCard(
    bot: BotConfig,
    actor: BotActor,
    taskId: string,
    message: BotOutboundMessage,
  ): Promise<void> {
    const adapter = providers[bot.provider];
    const key = getActorContextKey(actor);
    const existing = transientInteractionCards.get(key);
    if (existing) {
      // 修复原因：交互推进时 POST 新卡再 DELETE 旧卡会显示撤回痕迹。
      // callback token 更新失败后的降级路径也只能 PATCH 原 message_id，保持单卡身份稳定。
      await adapter?.updateTransientInteractionCard?.(existing.bot, existing.handle, message);
      return;
    }
    const handle = await adapter?.createTransientInteractionCard?.(bot, message);
    if (!handle) {
      return;
    }
    transientInteractionCards.set(key, { bot, taskId, handle });
  }

  async function finalizeTransientInteractionCard(
    actor: BotActor,
    fallback: BotOutboundMessage,
  ): Promise<boolean> {
    const key = getActorContextKey(actor);
    const existing = transientInteractionCards.get(key);
    if (!existing) {
      return false;
    }
    const adapter = providers[existing.bot.provider];
    try {
      // 修复原因：交互完成后撤回卡片会让问答和计划从聊天历史消失，用户无法回看
      // 决策上下文。终态只更新为无控件卡片并释放运行时句柄，后续交互会创建新卡。
      await adapter?.updateTransientInteractionCard?.(existing.bot, existing.handle, fallback);
    } catch (error) {
      botsLogger.warn(
        undefined,
        `finalize interaction card failed bot=${existing.bot.id} task=${existing.taskId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      transientInteractionCards.delete(key);
    }
    return true;
  }

  const waitForGroupDeliverySlot = createGroupDeliveryThrottle();
  const groupDeliverySenders = new Map<string, ReturnType<typeof createGroupResultDelivery>>();
  function getGroupDeliverySender(bot: BotConfig, chatId: string, threadId?: string) {
    const key = getBotConversationKey({ botId: bot.id, chatType: "group", chatId, threadId });
    const existing = groupDeliverySenders.get(key);
    if (existing) return existing;
    const authorized = async (result: BotGroupDelivery): Promise<boolean> => {
      const state = (await repo.readState()).bots[key];
      const currentBot = findBot(await repo.readConfig(), bot.id);
      return Boolean(
        currentBot?.enabled &&
        (!result.appId || result.appId === currentBot.feishuAppId) &&
        (!result.contentParts ||
          !["cancelled", "discarded", "stopped"].includes(
            state?.group?.inputs?.[result.sourceCommandId ?? ""]?.progress?.status ?? "",
          )) &&
        state?.group?.enabled &&
        state.group.ownerId === currentBot.providerUserId &&
        state.activeTaskId === result.taskId &&
        state.group.deliveries?.[result.id]?.status !== "invalidated" &&
        (!result.authorizationId || result.authorizationId === state.group.authorizationId),
      );
    };
    const sender = createGroupResultDelivery({
      onSettled: async () => {
        await deps.broadcastService
          ?.send({ channel: "bots:group-state", payload: { botId: bot.id, chatId } })
          .catch(() => undefined);
      },
      read: async (id) => (await repo.readState()).bots[key]?.group?.deliveries?.[id],
      authorized,
      write: async (result) => {
        const operation = stateWriteTail
          .catch(() => undefined)
          .then(async () => {
            const state = await repo.readState();
            const context = state.bots[key];
            if (!context?.group) return;
            const invalidated =
              !context.group.enabled ||
              context.activeTaskId !== result.taskId ||
              (Boolean(result.authorizationId) &&
                context.group.authorizationId !== result.authorizationId) ||
              context.group.deliveries?.[result.id]?.status === "invalidated";
            state.bots[key] = {
              ...context,
              group: {
                ...context.group,
                deliveries: {
                  ...context.group.deliveries,
                  [result.id]: invalidated ? { ...result, status: "invalidated" } : result,
                },
              },
            };
            await repo.writeState(state);
          });
        stateWriteTail = operation;
        await operation;
        await deps.broadcastService
          ?.send({ channel: "bots:group-state", payload: { botId: bot.id, chatId } })
          .catch(() => undefined);
      },
      send: async (result) => {
        await waitForGroupDeliverySlot(`${bot.provider}:${chatId}`);
        if (!(await authorized(result)))
          throw Object.assign(new Error("Group delivery authorization changed"), {
            deliveryRejected: true,
          });
        const currentBot = findBot(await repo.readConfig(), bot.id);
        const adapter = currentBot && providers[currentBot.provider];
        if (!adapter || !currentBot)
          throw Object.assign(new Error("Bot provider unavailable"), { deliveryRejected: true });
        if (
          result.contentParts &&
          (currentBot.provider !== bot.provider || currentBot.feishuAppId !== result.appId)
        )
          throw Object.assign(new Error("Channel reply application changed"), {
            deliveryRejected: true,
          });
        return adapter.send(currentBot, {
          botId: bot.id,
          provider: bot.provider,
          providerUserId: chatId,
          text: result.text,
          deliveryId: result.id,
          replyToMessageId: result.replyToMessageId,
          mentionedUserIds: result.mentionedUserIds,
          contentParts: result.contentParts,
          trace: result.trace,
          threadId: result.threadId ?? threadId,
          rootMessageId:
            result.rootMessageId ?? (await repo.readState()).bots[key]?.group?.rootMessageId,
        });
      },
    });
    groupDeliverySenders.set(key, sender);
    return sender;
  }

  async function sendOutbound(
    bot: BotConfig,
    message: BotOutboundMessage,
    authorize?: () => Promise<boolean>,
  ): Promise<void> {
    const conversationThreadId =
      message.conversationThreadId !== undefined
        ? (message.conversationThreadId ?? undefined)
        : message.threadId;
    if (isFeishuBotProvider(bot.provider) && message.groupTaskId && message.deliveryId) {
      const parts = splitFeishuText(message.text);
      const group = (await repo.readState()).bots[
        getBotConversationKey({
          botId: bot.id,
          chatType: "group",
          chatId: message.providerUserId,
          threadId: message.threadId,
          conversationThreadId: message.conversationThreadId,
        })
      ]?.group;
      const authorizationId = message.groupCard?.authorizationId ?? group?.authorizationId;
      for (const [index, text] of parts.entries()) {
        const id = createHash("sha256").update(`${message.deliveryId}:${index}`).digest("hex");
        const result: BotGroupDelivery = {
          authorizationId,
          id,
          taskId: message.groupTaskId,
          sourceCommandId: message.groupSourceCommandId,
          text,
          replyToMessageId: message.replyToMessageId,
          mentionedUserIds: index === 0 ? message.mentionedUserIds : undefined,
          threadId: message.threadId,
          rootMessageId: message.rootMessageId,
          status: "pending",
          updatedAt: Date.now(),
        };
        await getGroupDeliverySender(bot, message.providerUserId, conversationThreadId)(result);
      }
      return;
    }
    if (isFeishuBotProvider(bot.provider) && message.providerUserId.startsWith("oc_")) {
      await waitForGroupDeliverySlot(`${bot.provider}:${message.providerUserId}`);
    }
    // 定时任务也使用稳定群目标；等待发送额度之后重新检查启用状态。
    if (authorize && !(await authorize())) return;
    if (isFeishuBotProvider(bot.provider) && message.groupTaskId) {
      const groupState = (await repo.readState()).bots[
        getBotConversationKey({
          botId: bot.id,
          chatType: "group",
          chatId: message.providerUserId,
          threadId: message.threadId,
          conversationThreadId: message.conversationThreadId,
        })
      ];
      const currentBot = findBot(await repo.readConfig(), bot.id);
      if (
        !currentBot?.enabled ||
        !groupState?.group?.enabled ||
        groupState.group.ownerId !== currentBot.providerUserId ||
        groupState.activeTaskId !== message.groupTaskId
      )
        return;
    }
    const adapter = providers[bot.provider];
    if (!adapter) {
      return;
    }
    if (bot.provider === "weixin") {
      const token = await deps.credentialService.load(
        weixinContextKey(bot, message.providerUserId),
      );
      if (token) message = { ...message, providerContextToken: token };
    }
    let handle: Awaited<ReturnType<BotProviderAdapter["send"]>>;
    try {
      handle = await adapter.send(bot, message);
      onDeliveryResult(bot, undefined);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const locale = await readMessageLocale();
      onDeliveryResult(
        bot,
        bot.provider === "weixin"
          ? locale === "en-US"
            ? `${detail}. Send a message to the bot in Weixin, then retry.`
            : `${detail}。请在微信给机器人发一条消息后重试。`
          : detail,
      );
      throw error;
    }
    if (
      message.selection?.action === "queue.cancel" &&
      message.groupSourceCommandId &&
      message.groupCard?.taskId &&
      handle?.providerMessageId
    ) {
      await queueCards
        .attach(
          JSON.stringify([
            bot.id,
            message.groupCard.chatId,
            message.groupCard.taskId,
            message.groupCard.authorizationId,
            message.groupSourceCommandId,
            message.groupCard.conversationThreadId !== undefined
              ? message.groupCard.conversationThreadId
              : message.groupCard.threadId,
          ]),
          handle.providerMessageId,
        )
        .catch((error) => {
          botsLogger.warn(
            undefined,
            `queue card catch-up failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    }
  }

  function buildInboundDeliveryKey(message: BotInboundMessage): string | null {
    const providerMessageId = message.actor.providerMessageId?.trim();
    if (!providerMessageId) {
      return null;
    }
    return [
      message.actor.botId,
      message.actor.provider,
      message.actor.chatId ?? message.actor.providerUserId,
      providerMessageId,
    ].join("::");
  }

  function createInputTraceId(
    message: BotInboundMessage,
    taskId: string,
    hasAttachments: boolean,
  ): string {
    // 附件输入走旧 session/send，不按 inputId 去重：固定 ID 没有保护，还会让两轮共用一个 inputId。
    const deliveryKey = hasAttachments ? null : buildInboundDeliveryKey(message);
    // Bugfix：私聊 traceId 即 v4 sendText 的 commandId，原来每次随机生成。微信游标未提交时，
    // getupdates 会重投同一条消息，内存去重 2 分钟后过期，每次重投都以新 commandId 入队，
    // 线上同一句话每 2 分钟入队一次、持续约 23 小时。按 provider 消息身份固定 commandId，
    // 由 CLI 命令账本返回 duplicate；没有消息 ID 时无法识别重投，保留随机 ID。
    // 群聊输入另用 botGroupCommandId 提交，这里的 ID 在群聊里只用于配置日志。
    return deliveryKey
      ? `bot-input-${createHash("sha256").update(deliveryKey).digest("hex")}`
      : generateTraceId(taskId);
  }

  function releaseInboundDelivery(message: BotInboundMessage): void {
    const deliveryKey = buildInboundDeliveryKey(message);
    if (deliveryKey) {
      recentInboundDeliveryAtByKey.delete(deliveryKey);
    }
  }

  async function enqueueInboundProcessing<T>(
    actor: BotActor,
    task: () => Promise<T>,
    control = false,
  ): Promise<T> {
    // 控制请求独立串行，不能被等待附件或 admission 的普通输入挡住。
    const actorContextKey = `${getBotConversationKey(actor)}${control ? ":control" : ""}`;
    const previous = inboundProcessingQueuesByContext.get(actorContextKey) ?? Promise.resolve();
    let releaseQueue = (): void => undefined;
    const current = previous
      .catch(() => undefined)
      .then(
        () =>
          new Promise<void>((resolve) => {
            releaseQueue = resolve;
          }),
      );
    inboundProcessingQueuesByContext.set(actorContextKey, current);
    await previous.catch(() => undefined);
    try {
      // Bugfix: 同一个用户可能连续点击 AskUserQuestion 按钮或快速回复多条消息。
      // 这里按 actor 串行化入站处理，避免两个并发请求同时读取同一个 pendingElicitation 并重复 respondElicitation。
      return await task();
    } finally {
      releaseQueue();
      if (inboundProcessingQueuesByContext.get(actorContextKey) === current) {
        inboundProcessingQueuesByContext.delete(actorContextKey);
      }
    }
  }

  function pruneRecentInboundDeliveryDedupe(now: number): void {
    for (const [key, at] of recentInboundDeliveryAtByKey) {
      if (now - at >= BOT_INBOUND_DELIVERY_DEDUPE_TTL_MS) {
        recentInboundDeliveryAtByKey.delete(key);
      }
    }
  }

  function markInboundDelivery(message: BotInboundMessage): boolean {
    const now = Date.now();
    pruneRecentInboundDeliveryDedupe(now);
    const deliveryKey = buildInboundDeliveryKey(message);
    if (!deliveryKey) {
      return true;
    }
    if (recentInboundDeliveryAtByKey.has(deliveryKey)) {
      return false;
    }
    // Bugfix: 飞书 WebSocket 可能重投同一条 im.message.receive_v1，微信/Telegram 也可能在重试后重放同一 message id。
    // 普通消息有创建/发送任务的副作用，必须在进入业务处理前按 provider message id 幂等，避免同一句 hello 被执行两轮。
    recentInboundDeliveryAtByKey.set(deliveryKey, now);
    return true;
  }

  async function sendTyping(bot: BotConfig, actor: BotActor): Promise<void> {
    const adapter = providers[bot.provider];
    const targetId = actor.chatId ?? actor.providerUserId;
    if (!adapter?.sendTyping || !targetId) {
      return;
    }
    await adapter
      .sendTyping(bot, {
        providerUserId: targetId,
        providerMessageId: actor.providerMessageId,
        providerContextToken: actor.providerContextToken,
      })
      .catch(() => undefined);
  }

  async function stopInboundTyping(bot: BotConfig, actor: BotActor): Promise<void> {
    const adapter = providers[bot.provider];
    const targetId = actor.chatId ?? actor.providerUserId;
    if (!adapter?.stopTyping || !targetId || !actor.providerMessageId) {
      return;
    }
    const isLongRunningTyping = Array.from(typingTargets.values()).some(
      (typing) =>
        typing.bot.id === bot.id && typing.target.providerMessageId === actor.providerMessageId,
    );
    if (isLongRunningTyping) {
      return;
    }
    // Bugfix: 飞书 sendTyping 只负责给本次入站消息加 Typing reaction。
    // 短命令回复发送完成后必须按同一 messageId 显式删除，避免依赖定时兜底或等下一条命令清理。
    await adapter
      .stopTyping(bot, {
        providerUserId: targetId,
        providerMessageId: actor.providerMessageId,
        providerContextToken: actor.providerContextToken,
      })
      .catch(() => undefined);
  }

  function startTyping(bot: BotConfig, actor: BotActor, taskId: string): void {
    const adapter = providers[bot.provider];
    const targetId = actor.chatId ?? actor.providerUserId;
    if (!adapter || !targetId || typingTargets.has(taskId) || typingIntervals.has(taskId)) {
      return;
    }
    const target: BotTypingTarget = {
      providerUserId: targetId,
      providerMessageId: actor.providerMessageId,
      providerContextToken: actor.providerContextToken,
    };
    if (adapter.startTyping) {
      typingTargets.set(taskId, { bot, target });
      void adapter.startTyping(bot, target).catch(() => undefined);
      return;
    }
    if (adapter.sendTyping) {
      void adapter.sendTyping(bot, target).catch(() => undefined);
      typingIntervals.set(
        taskId,
        setInterval(() => {
          void adapter.sendTyping?.(bot, target).catch(() => undefined);
        }, BOT_TYPING_INTERVAL_MS),
      );
    }
  }

  function stopTyping(taskId: string): void {
    const activeTyping = typingTargets.get(taskId);
    if (activeTyping) {
      typingTargets.delete(taskId);
      const adapter = providers[activeTyping.bot.provider];
      void adapter?.stopTyping?.(activeTyping.bot, activeTyping.target).catch(() => undefined);
    }
    const intervalId = typingIntervals.get(taskId);
    if (!intervalId) {
      return;
    }
    clearInterval(intervalId);
    typingIntervals.delete(taskId);
  }

  function updateLiveStatusProgress(event: ZCodeStreamEvent): void {
    if (event.type === "agent_message_chunk" || event.type === "agent_thought_chunk") {
      const text = normalizeStatusProgressText(event.content);
      if (!text) {
        return;
      }
      const kind = event.type === "agent_message_chunk" ? "message" : "thought";
      const previous = liveStatusProgressByTaskId.get(event.taskId);
      liveStatusProgressByTaskId.set(event.taskId, {
        kind,
        text: truncateLiveStatusProgressText(
          previous?.kind === kind ? `${previous.text}${text}` : text,
        ),
      });
      return;
    }
    if (event.type === "tool_call" || event.type === "tool_call_update") {
      const text = formatStatusStreamToolProgress(event);
      if (text) {
        liveStatusProgressByTaskId.set(event.taskId, { kind: "tool", text });
      }
    }
  }

  async function broadcastTaskListChange(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity" | "hostId">,
    taskId: string,
    event: BotTaskBroadcastPayload["event"],
    extras: Partial<
      Pick<
        BotTaskBroadcastPayload,
        | "task"
        | "provider"
        | "configOptions"
        | "prompt"
        | "permissionRequest"
        | "elicitationRequest"
        | "requestId"
        | "error"
      >
    > = {},
  ): Promise<void> {
    await deps.broadcastService
      ?.send({
        channel: BOT_TASK_BROADCAST_CHANNEL,
        payload: {
          workspacePath: context.workspacePath,
          workspaceIdentity: context.workspaceIdentity,
          taskId,
          event,
          updatedAt: Date.now(),
          ...extras,
        },
      })
      .catch(() => undefined);
  }

  async function broadcastTaskStreamEvent(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity" | "hostId">,
    event: ZCodeStreamEvent,
  ): Promise<void> {
    const payload: BotTaskStreamBroadcastPayload = {
      workspacePath: context.workspacePath,
      workspaceIdentity: context.workspaceIdentity,
      taskId: event.taskId,
      event,
      updatedAt: Date.now(),
    };
    await deps.broadcastService
      ?.send({
        channel: BOT_TASK_STREAM_BROADCAST_CHANNEL,
        payload,
      })
      .catch(() => undefined);
  }

  async function normalizeWorkspaceRef(workspace: BotWorkspaceRef): Promise<BotWorkspaceRef> {
    if (!workspace.workspaceIdentity || !deps.remoteWorkspaceService?.resolveWorkspace)
      return workspace;
    const resolved = await deps.remoteWorkspaceService.resolveWorkspace({
      workspacePath: workspace.workspacePath,
      workspaceIdentity: workspace.workspaceIdentity,
    });
    if (
      !resolved ||
      (resolved.workspacePath === workspace.workspacePath &&
        resolved.workspaceIdentity === workspace.workspaceIdentity)
    )
      return workspace;
    return createWorkspaceRef(resolved.workspacePath, resolved.workspaceIdentity);
  }

  async function normalizeBotWorkspaceIdentities(bot: BotConfig): Promise<BotConfig> {
    // 只迁移 Host 已证明的远端 alias；未知 key 原样保留，绝不按相同路径扩大授权。
    const allowedWorkspaces = await Promise.all(
      bot.allowedWorkspaces.map(async (key) => {
        const parsed = parseRemoteWorkspaceIdentity(key);
        if (!parsed) return key;
        return (await normalizeWorkspaceRef(createWorkspaceRef(parsed.workspacePath, key))).id;
      }),
    );
    return { ...bot, allowedWorkspaces };
  }

  async function listWorkspaceRefs(
    _params: BotListWorkspaceRefsParams = {},
  ): Promise<BotWorkspaceRef[]> {
    return workspaceRefsFromCatalog(await readProjectCatalog(deps));
  }

  function workspaceRefsFromCatalog(catalog: ProjectCatalogSnapshot): BotWorkspaceRef[] {
    const foreign = new Set(catalog.directory.hosts.map((host) => host.id));
    return catalog.projects.map((project) => {
      const workspacePath =
        project.roots.find((root) => root.isPrimary)?.rootPath ?? project.roots[0]?.rootPath ?? "";
      return {
        id: projectSelectionId(project),
        label: project.name,
        projectId: project.id,
        hostId: project.hostId,
        workspacePath,
        rootPaths: project.roots.map((root) => root.rootPath),
        ...(foreign.has(project.hostId) && workspacePath
          ? { workspaceIdentity: buildRemoteHostWorkspaceIdentity(project.hostId, workspacePath) }
          : {}),
      };
    });
  }

  async function bindProject(
    workspace: BotWorkspaceRef,
  ): Promise<
    Pick<
      BotContextState,
      | "projectId"
      | "hostId"
      | "workspacePath"
      | "workspaceIdentity"
      | "workspaceId"
      | "additionalDirectories"
    >
  > {
    // 菜单只是展示快照。重新读取仍保留的项目，再由 owner 解析，迟到点击不能复活入口。
    const before = await readProjectCatalog(deps);
    const current = workspaceRefsFromCatalog(before).find((item) => item.id === workspace.id);
    if (!current?.projectId || !current.hostId)
      throw new Error("Bot project is no longer available");
    const execution = await deps.projectService.prepareSession({
      projectId: current.projectId,
      hostId: current.hostId,
    });
    const after = await readProjectCatalog(deps);
    const host = before.directory.hosts.find((item) => item.id === current.hostId);
    const retainedEntries = before.directory.entries.filter(
      (entry) =>
        entry.hostId === current.hostId &&
        (entry.projectId === current.projectId ||
          (entry.projectId === null &&
            entry.legacyWorkspace &&
            current.rootPaths?.includes(entry.legacyWorkspace.workspacePath))),
    );
    // 同一 ID 移除再添加也是新 admission；不能将旧 owner 的 prepare 结果保存为新绑定。
    if (
      !workspaceRefsFromCatalog(after).some((item) => item.id === current.id) ||
      (host &&
        (!after.directory.hosts.some(
          (item) => item.id === host.id && item.membershipId === host.membershipId,
        ) ||
          !retainedEntries.some((entry) =>
            after.directory.entries.some((item) => item.id === entry.id),
          )))
    )
      throw new Error("Bot project was removed during binding");
    return { ...execution, hostId: current.hostId, workspaceId: current.id };
  }

  function upgradeLegacyContext(
    context: BotContextState,
    catalog: ProjectCatalogSnapshot,
  ): BotContextState {
    const workspaces = workspaceRefsFromCatalog(catalog);
    const identity = context.workspaceIdentity;
    // 历史 canonical key 是执行身份，不能直接当作新 Source 的持库 host ID。
    const legacyHostId = catalog.directory.entries.find(
      (entry) =>
        entry.legacyWorkspace?.workspaceIdentity === identity &&
        entry.legacyWorkspace?.workspacePath === context.workspacePath,
    )?.hostId;
    const hostId = identity
      ? (legacyHostId ?? remoteHostIdFromWorkspaceIdentity(identity))
      : (deps.ownerHostId ?? "local");
    const candidates = workspaces.filter(
      (workspace) =>
        workspace.rootPaths?.includes(context.workspacePath) &&
        (identity
          ? workspace.hostId === hostId || workspace.workspaceIdentity === identity
          : !workspace.workspaceIdentity),
    );
    // 旧 path-only 远端只在唯一候选时补身份；已有 cwd 永远不跟随项目主要目录。
    const legacyRemote =
      !identity && candidates.length === 0
        ? workspaces.filter((workspace) => workspace.rootPaths?.includes(context.workspacePath))
        : [];
    const selected =
      candidates.length === 1
        ? candidates[0]
        : legacyRemote.length === 1
          ? legacyRemote[0]
          : undefined;
    const resolvedHostId = selected?.hostId ?? hostId ?? deps.ownerHostId ?? "local";
    const workspaceIdentity =
      identity ??
      (selected?.workspaceIdentity && selected.hostId
        ? buildRemoteHostWorkspaceIdentity(selected.hostId, context.workspacePath)
        : undefined);
    return {
      ...context,
      projectId: selected?.projectId ?? null,
      hostId: resolvedHostId,
      workspaceIdentity,
      workspaceId:
        selected?.id ??
        context.workspaceId ??
        getWorkspaceKey(context.workspacePath, workspaceIdentity),
      additionalDirectories: [],
    };
  }

  async function normalizeBotWorkspaceConfig(
    config: BotsConfigFile,
    bot: BotConfig,
    currentWorkspace?: BotWorkspaceRef,
  ): Promise<{
    config: BotsConfigFile;
    bot: BotConfig;
    user: BotConfig;
    workspaces: BotWorkspaceRef[];
  }> {
    const workspaces = await listWorkspaceRefs({ currentWorkspace });
    const nextAllowedWorkspaces = normalizeConfiguredAllowedWorkspaces(
      (await normalizeBotWorkspaceIdentities(bot)).allowedWorkspaces,
      workspaces,
    );
    const nextBot: BotConfig = {
      ...bot,
      // 旧路径授权只在项目候选唯一时交接；同 cwd 多项目不能扩大权限。
      allowedWorkspaces: nextAllowedWorkspaces,
    };
    const nextConfig: BotsConfigFile = {
      ...config,
      bots: config.bots.map((item) => (item.id === bot.id ? nextBot : item)),
    };
    const shouldWrite = nextBot.allowedWorkspaces.join("\n") !== bot.allowedWorkspaces.join("\n");
    if (shouldWrite) {
      await writeBotConfig(nextConfig);
    }
    return { config: nextConfig, bot: nextBot, user: nextBot, workspaces };
  }

  async function readTaskMeta(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity" | "hostId">,
    taskId: string,
  ): Promise<ZCodeTaskMeta | null> {
    const zcodeTaskService = await resolveZCodeTaskServiceForContext(context);
    const tasks = await zcodeTaskService.listTasks({
      workspacePath: context.workspacePath,
      workspaceIdentity: context.workspaceIdentity,
    });
    return tasks.find((task) => task.taskId === taskId) ?? null;
  }

  async function listContextTaskSelectionEntries(
    context: BotContextState,
    user: BotConfig,
  ): Promise<BotTaskSelectionEntry[]> {
    if (context.workspaceId && !isWorkspaceAllowed(context.workspaceId, user.allowedWorkspaces))
      return [];
    const tree = await deps.projectService.readTree({ hostId: context.hostId });
    const key = getWorkspaceKey(context.workspacePath, context.workspaceIdentity);
    return tree.tasks
      .filter(
        (task) =>
          task.projectId === (context.projectId ?? null) &&
          getWorkspaceKey(task.workspacePath, task.workspaceIdentity) === key,
      )
      .filter((task) => !context.group || context.group.taskIds.includes(task.taskId))
      .map((task) => ({
        task,
        workspacePath: context.workspacePath,
        workspaceIdentity: context.workspaceIdentity,
      }));
  }

  function resolvePendingTaskSelectionEntry(
    actor: BotActor,
    value: string,
  ): BotTaskSelectionEntry | null {
    const actorContextKey = getActorContextKey(actor);
    const directEntry = pendingTaskSelectionsByContext.get(actorContextKey)?.get(value.trim());
    if (directEntry) {
      return directEntry;
    }
    const option = resolvePendingSelectionOption(actor, "task.set", value);
    if (!option) {
      return null;
    }
    return pendingTaskSelectionsByContext.get(actorContextKey)?.get(option.id) ?? null;
  }

  function resolvePendingWorkspaceSelectionEntry(
    actor: BotActor,
    value: string,
  ): BotWorkspaceSelectionEntry | null {
    const actorContextKey = getActorContextKey(actor);
    const directEntry = pendingWorkspaceSelectionsByContext.get(actorContextKey)?.get(value.trim());
    if (directEntry) {
      return directEntry;
    }
    const option = resolvePendingSelectionOption(actor, "workspace.set", value);
    if (!option) {
      return null;
    }
    return pendingWorkspaceSelectionsByContext.get(actorContextKey)?.get(option.id) ?? null;
  }

  function createCurrentWorkspaceRef(context: BotContextState): BotWorkspaceRef {
    return {
      ...createWorkspaceRef(context.workspacePath, context.workspaceIdentity),
      id: context.workspaceId ?? getWorkspaceKey(context.workspacePath, context.workspaceIdentity),
      projectId: context.projectId ?? undefined,
      hostId: context.hostId,
    };
  }

  async function readContextActiveTaskMeta(
    context: BotContextState,
  ): Promise<ZCodeTaskMeta | null> {
    if (!context.activeTaskId) {
      return null;
    }
    const listedTask = await readTaskMeta(context, context.activeTaskId).catch(() => null);
    if (listedTask) {
      return listedTask;
    }
    return (
      (
        await (
          await resolveZCodeTaskServiceForContext(context)
        )
          .getTaskSnapshot({
            taskId: context.activeTaskId,
            workspacePath: context.workspacePath,
            workspaceIdentity: context.workspaceIdentity,
          })
          .catch(() => null)
      )?.meta ?? null
    );
  }

  async function requireActiveTask(
    message: BotInboundMessage,
    auth: {
      context: BotContextState;
      locale: Locale | undefined;
    },
  ): Promise<
    | {
        ok: true;
        taskId: string;
        task: ZCodeTaskMeta;
        configOptions: ZCodeConfigOption[];
      }
    | { ok: false; reply: BotOutboundMessage[] }
  > {
    if (!auth.context.activeTaskId) {
      return {
        ok: false,
        reply: [createOutbound(message.actor, msg(auth.locale, "noActiveTask"))],
      };
    }
    const task = await readContextActiveTaskMeta(auth.context);
    if (!task) {
      return {
        ok: false,
        reply: [createOutbound(message.actor, msg(auth.locale, "noActiveTask"))],
      };
    }
    const configOptions = await listActiveTaskConfigOptions(
      auth.context,
      auth.context.activeTaskId,
    );
    return {
      ok: true,
      taskId: auth.context.activeTaskId,
      task,
      configOptions,
    };
  }

  async function broadcastTaskConfigSync(params: {
    context: BotContextState;
    taskId: string;
    task?: ZCodeTaskMeta | null;
    provider?: ZCodeProvider;
    configOptions?: ZCodeConfigOption[];
  }): Promise<void> {
    await broadcastTaskListChange(params.context, params.taskId, "updated", {
      ...(params.task ? { task: params.task } : {}),
      ...(params.provider ? { provider: params.provider } : {}),
      ...(params.configOptions ? { configOptions: params.configOptions } : {}),
    });
  }

  function isTerminalTaskMeta(
    task: ZCodeTaskMeta | null,
    eventType: "task_complete" | "task_error",
  ): boolean {
    if (!task) {
      return false;
    }
    if (eventType === "task_error") {
      return task.status === "error";
    }
    return task.status === "completed";
  }

  async function readTerminalTaskMeta(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity" | "hostId">,
    taskId: string,
    eventType: "task_complete" | "task_error",
  ): Promise<ZCodeTaskMeta | null> {
    let latestTask = await readTaskMeta(context, taskId).catch(() => null);
    if (isTerminalTaskMeta(latestTask, eventType)) {
      return latestTask;
    }

    for (const retryDelayMs of BOT_TASK_META_RETRY_DELAYS_MS) {
      await delay(retryDelayMs);
      latestTask = await readTaskMeta(context, taskId).catch(() => latestTask);
      if (isTerminalTaskMeta(latestTask, eventType)) {
        return latestTask;
      }
    }

    return latestTask;
  }

  async function processProviderCallback(
    provider: BotProvider,
    payload: unknown,
  ): Promise<BotProviderCallbackResult> {
    const adapter = providers[provider];
    if (!adapter) {
      return { ok: false, replies: [], status: 400 };
    }
    const locale = await readMessageLocale();
    const config = await repo.readConfig();
    const callbackBot = findCallbackBot(config, provider, payload);
    // 在读取引用附件和处理退群事件之前验证回调，避免未验证事件产生读写副作用。
    if (callbackBot && isFeishuBotProvider(provider) && callbackBot.webhookSecretRef) {
      const expectedToken = await deps.credentialService.load(callbackBot.webhookSecretRef);
      const header = isRecord(payload) && isRecord(payload.header) ? payload.header : null;
      const inboundToken = isRecord(payload)
        ? (readNestedString(payload, "token") ?? readNestedString(header, "token"))
        : undefined;
      if (!expectedToken || expectedToken !== inboundToken) {
        return {
          ok: false,
          replies: [],
          status: 401,
          responseBody: { error: msg(locale, "webhookSecretInvalid") },
        };
      }
    }
    let materialPayload = payload;
    if (callbackBot && isFeishuBotProvider(provider) && isRecord(payload)) {
      const event = isRecord(payload.event) ? payload.event : payload;
      const native = isRecord(event.message) ? event.message : {};
      const chatId = readNestedString(native, "chat_id");
      const threadId = readNestedString(native, "thread_id");
      const topic =
        chatId && threadId
          ? (await repo.readState()).bots[
              getBotConversationKey({ botId: callbackBot.id, chatType: "group", chatId, threadId })
            ]
          : undefined;
      // 根引用属于首次输入，不属于 active 状态；退出再接入不能重复读取它。
      // 只信服务记录，外部回调不能声称已接收来跳过首次材料准备。
      materialPayload = {
        ...payload,
        zcodeTopicHasAcceptedInput: Object.values(topic?.group?.inputs ?? {}).some(
          (input) => input.admission === "accepted",
        ),
      };
    }
    const preparedPayload = callbackBot
      ? ((await adapter
          .prepareCallbackPayload?.(callbackBot, materialPayload)
          .catch((error: unknown) => ({
            zcodeCallbackPrepareError: error instanceof Error ? error.message : String(error),
          }))) ?? payload)
      : payload;
    if (
      isRecord(preparedPayload) &&
      typeof preparedPayload.zcodeCallbackPrepareError === "string"
    ) {
      return {
        ok: false,
        replies: [],
        responseBody: { error: preparedPayload.zcodeCallbackPrepareError },
        status: 401,
      };
    }
    const callbackResponse = callbackBot
      ? await adapter.handleCallbackResponse?.(callbackBot, preparedPayload)
      : null;
    if (callbackResponse?.responseBody !== undefined) {
      return {
        ok: (callbackResponse.status ?? 200) < 400,
        replies: [],
        responseBody: callbackResponse.responseBody,
        status: callbackResponse.status,
      };
    }
    if (
      callbackBot &&
      isFeishuBotProvider(provider) &&
      isRecord(preparedPayload) &&
      preparedPayload.zcodeBotRemoved === true
    ) {
      const event = isRecord(preparedPayload.event) ? preparedPayload.event : preparedPayload;
      const chatId = readNestedString(event, "chat_id");
      if (chatId) {
        const state = (await repo.readState()).bots[
          getBotConversationKey({ botId: callbackBot.id, chatType: "group", chatId })
        ];
        if (state?.group) {
          await writeContext(
            { ...state, group: { ...state.group, enabled: false, authorizationId: randomUUID() } },
            true,
          );
          await cancelGroupTopicInputs({
            botId: callbackBot.id,
            provider: callbackBot.provider,
            chatType: "group",
            chatId,
            providerUserId: state.group.ownerId,
          });
        }
      }
      return { ok: true, replies: [] };
    }
    let parsePayload =
      isFeishuBotProvider(provider) && isRecord(preparedPayload)
        ? { ...preparedPayload, zcodeProvider: provider }
        : preparedPayload;
    if (callbackBot && isFeishuBotProvider(provider) && isRecord(parsePayload)) {
      const event = isRecord(parsePayload.event) ? parsePayload.event : parsePayload;
      const cardContext = isRecord(event.context) ? event.context : null;
      const cardChatId =
        readNestedString(cardContext, "open_chat_id") ?? readNestedString(cardContext, "chat_id");
      if (cardChatId) {
        const states = await repo.readState();
        const group =
          states.bots[
            getBotConversationKey({ botId: callbackBot.id, chatType: "group", chatId: cardChatId })
          ];
        if (group?.group) parsePayload = { ...parsePayload, zcodeChatType: "group" };
      }
    }
    const parsedInboundMessages = adapter.parseCallback(parsePayload);
    if (isFeishuBotProvider(provider)) {
      // Bugfix: 飞书 WebSocket connected 只代表长连接已建成，不代表事件订阅已经推到本机。
      // 这里记录入口 payload 摘要和解析数量，方便区分“飞书未推事件”和“payload 形状未被解析”。
      botsLogger.debug(
        undefined,
        `provider callback parsed provider=${provider} count=${parsedInboundMessages.length} ${summarizeCallbackPayload(preparedPayload)}`,
      );
    }
    const replies: BotOutboundMessage[] = [];
    let hadBusinessFailure = false;
    const inboundSecret =
      isRecord(preparedPayload) && typeof preparedPayload.webhookSecret === "string"
        ? preparedPayload.webhookSecret
        : undefined;
    for (const inbound of parsedInboundMessages) {
      const bot = findBot(config, inbound.botId);
      if (bot?.provider === "webhook" && bot.webhookSecretRef) {
        const expectedSecret = await deps.credentialService.load(bot.webhookSecretRef);
        if (expectedSecret && expectedSecret !== inboundSecret) {
          replies.push(createOutbound(inbound.actor, msg(locale, "webhookSecretInvalid")));
          continue;
        }
      }
      if (bot && isFeishuBotProvider(bot.provider) && bot.webhookSecretRef) {
        const expectedToken = await deps.credentialService.load(bot.webhookSecretRef);
        const payloadHeader =
          isRecord(preparedPayload) && isRecord(preparedPayload.header)
            ? preparedPayload.header
            : null;
        const inboundToken =
          isRecord(preparedPayload) && typeof preparedPayload.token === "string"
            ? preparedPayload.token
            : typeof payloadHeader?.token === "string"
              ? payloadHeader.token
              : undefined;
        if (expectedToken && expectedToken !== inboundToken) {
          replies.push(createOutbound(inbound.actor, msg(locale, "webhookSecretInvalid")));
          continue;
        }
      }
      let inboundMessage = inbound;
      if (bot && !inbound.actor.displayName && adapter.resolveActorDisplayName) {
        try {
          const displayName = await adapter.resolveActorDisplayName(bot, inbound.actor);
          if (displayName?.trim()) {
            inboundMessage = {
              ...inbound,
              actor: {
                ...inbound.actor,
                displayName: displayName.trim(),
              },
            };
          }
        } catch (error) {
          // Bugfix: 飞书 displayName 需要额外通讯录权限，权限缺失时不能阻断消息处理和绑定。
          botsLogger.debug(
            undefined,
            `resolve actor displayName failed provider=${provider} bot=${inbound.botId} user=${inbound.actor.providerUserId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (!markInboundDelivery(inboundMessage)) {
        botsLogger.debug(
          undefined,
          `provider callback duplicated provider=${provider} bot=${inboundMessage.botId} user=${inboundMessage.actor.providerUserId} messageId=${inboundMessage.actor.providerMessageId ?? ""}`,
        );
        continue;
      }
      botsLogger.debug(
        undefined,
        `provider callback provider=${provider} bot=${inboundMessage.botId} messageId=${inboundMessage.actor.providerMessageId ?? ""}`,
      );
      // 回调失败和重连也走相同的话题提醒规则，保留 Provider 核验的提及事实。
      inboundMessage = {
        ...inboundMessage,
        actor: { ...inboundMessage.actor, mentionedBot: inboundMessage.mentionedBot === true },
      };
      let outbound: BotOutboundMessage[];
      let reconnectStartingReply: BotOutboundMessage | null = null;
      let inboundBusinessFailure = false;
      try {
        const command = parseBotCommand(inboundMessage.commandText ?? inboundMessage.text);
        if (bot && inboundMessage.senderType !== "app" && command.type === "reconnect") {
          outbound = await handleReconnect(inboundMessage, {
            onReconnectStart: async (auth) => {
              reconnectStartingReply = createOutbound(
                inboundMessage.actor,
                msg(auth.locale, "remoteReconnectStarting", {
                  workspacePath: auth.context.workspacePath,
                }),
              );
              await sendOutbound(bot, reconnectStartingReply);
            },
          });
        } else {
          outbound = await service.handleInboundMessage(inboundMessage);
        }
      } catch (error) {
        releaseInboundDelivery(inboundMessage);
        hadBusinessFailure = true;
        inboundBusinessFailure = true;
        const message = error instanceof Error ? error.message : String(error);
        const userFacingMessage = formatUserFacingBotError(error, locale);
        botsLogger.warn(
          undefined,
          `provider callback failed provider=${provider} bot=${inboundMessage.botId} user=${inboundMessage.actor.providerUserId}: ${message}`,
        );
        outbound = [
          administratorErrorReply(
            inboundMessage.actor,
            bot,
            error,
            createOutbound(
              inboundMessage.actor,
              isSessionExpiredError(error)
                ? userFacingMessage
                : msg(locale, "callbackFailed", { message: userFacingMessage }),
            ),
          ),
        ];
      }
      if (reconnectStartingReply) {
        replies.push(reconnectStartingReply);
      }
      replies.push(...outbound);
      if (inboundBusinessFailure) {
        // Bugfix：错误提示发送成功不等于业务消息已经消费成功。此处不能执行 callback ACK，
        // 否则飞书会移除按钮；最终 ok=false 也会阻止 Telegram/微信提交外部游标。
        if (bot) {
          for (const outboundMessage of outbound) {
            await sendOutbound(bot, outboundMessage).catch((sendError) => {
              botsLogger.warn(
                undefined,
                `provider callback failure notice failed provider=${provider} bot=${bot.id}: ${sendError instanceof Error ? sendError.message : String(sendError)}`,
              );
            });
          }
          await stopInboundTyping(bot, inboundMessage.actor).catch(() => undefined);
        }
        continue;
      }
      if (bot) {
        const transientCard = transientInteractionCards.get(
          getActorContextKey(inboundMessage.actor),
        );
        const handledByFeishuSynchronousCardAction =
          isFeishuBotProvider(provider) &&
          isRecord(preparedPayload) &&
          ((preparedPayload.zcodeFeishuSynchronousCardAction === true &&
            !(
              isRecord(preparedPayload.zcodeFeishuCardResponseState) &&
              preparedPayload.zcodeFeishuCardResponseState.deferred === true
            ) &&
            Boolean(outbound[0])) ||
            (inboundMessage.groupCardAction === true && outbound[0]?.callbackToastOnly === true));
        // Bugfix: 只做空 ACK 会让 Telegram 顶部 loading 消失但没有任何可见反馈。
        // 这里在业务处理后把结果写进 answerCallbackQuery 的 toast，即使后续 sendMessage 失败，用户也能看到按钮结果。
        const callbackText = outbound[0]?.text ?? msg(locale, "received");
        let acknowledgeResult:
          | Awaited<ReturnType<NonNullable<typeof adapter.acknowledgeCallback>>>
          | undefined;
        const acknowledgeController = new AbortController();
        const acknowledgeTimeout = setTimeout(() => {
          acknowledgeController.abort(
            new Error(
              `Bot provider callback acknowledgement timed out after ${BOT_PROVIDER_CALLBACK_ACK_TIMEOUT_MS}ms.`,
            ),
          );
        }, BOT_PROVIDER_CALLBACK_ACK_TIMEOUT_MS);
        try {
          acknowledgeResult = await Promise.race([
            handledByFeishuSynchronousCardAction || (transientCard && !outbound[0]?.elicitation)
              ? Promise.resolve(undefined)
              : adapter.acknowledgeCallback?.(
                  bot,
                  preparedPayload,
                  callbackText,
                  outbound[0],
                  acknowledgeController.signal,
                ),
            new Promise<never>((_resolve, reject) => {
              acknowledgeController.signal.addEventListener(
                "abort",
                () => reject(acknowledgeController.signal.reason),
                { once: true },
              );
            }),
          ]);
        } catch (error) {
          // 修复原因：飞书第二题原本必须等待 card/update 完成；credential 或 SDK 内部
          // 任一步骤悬挂都会压住 fallback。主流程自己设 deadline，超时后立即另发下一题。
          botsLogger.warn(
            undefined,
            `provider callback acknowledge failed provider=${provider} bot=${bot.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        } finally {
          clearTimeout(acknowledgeTimeout);
        }
        const callbackHandledByCardUpdate =
          handledByFeishuSynchronousCardAction || acknowledgeResult?.handled === true;
        const administratorNotice = outbound.find(
          (reply) => reply.callbackToastOnly && reply.administratorAttention,
        );
        if (callbackHandledByCardUpdate && administratorNotice) {
          await sendOutbound(bot, {
            ...administratorNotice,
            callbackToastOnly: undefined,
            administratorAttention: undefined,
          });
        }
        if (
          !handledByFeishuSynchronousCardAction &&
          callbackHandledByCardUpdate &&
          transientCard &&
          outbound[0]?.elicitation
        ) {
          // 修复原因：真实飞书日志确认 card/update 返回成功后客户端仍可能停在旧题。
          // callback token 负责点击 ACK，随后再 PATCH 同一 message_id 强制刷新可见结构；
          // 两次写入始终指向同一张卡，禁止退回“新建后撤回”的闪烁方案。
          await providers[transientCard.bot.provider]
            ?.updateTransientInteractionCard?.(transientCard.bot, transientCard.handle, outbound[0])
            .catch((error) => {
              // 业务回答已被 Agent 接受且 callback token 已完成 ACK，PATCH 失败不能让
              // Telegram/微信式外部游标重试整次回答，否则会重复提交同一交互。
              botsLogger.warn(
                undefined,
                `refresh transient interaction card failed provider=${provider} bot=${bot.id}: ${error instanceof Error ? error.message : String(error)}`,
              );
            });
        }
        if (
          callbackHandledByCardUpdate &&
          transientCard &&
          !outbound[0]?.callbackToastOnly &&
          outbound[0]?.elicitation?.status !== "pending"
        ) {
          // 修复原因：card_update_token 已把同一消息更新为只读终态，此时只释放内存句柄，
          // 不能再 PATCH、DELETE 或另发结果卡。
          transientInteractionCards.delete(getActorContextKey(inboundMessage.actor));
        }
        // Bugfix: /reconnect 的“正在重连”必须在 ensureConnected 前实时发送。
        // handleReconnect 只返回最终结果，避免重连完成后才把过期的开始状态一起吐给用户。
        try {
          for (const outboundMessage of callbackHandledByCardUpdate ? [] : outbound) {
            if (transientCard && !outboundMessage.callbackToastOnly) {
              if (outboundMessage.selection || outboundMessage.elicitation?.status === "pending") {
                await upsertTransientInteractionCard(
                  bot,
                  inboundMessage.actor,
                  transientCard.taskId,
                  outboundMessage,
                );
                continue;
              }
              if (
                outboundMessage.elicitation ||
                /^\/(?:approve|deny)(?:\s|$)/u.test(inboundMessage.text)
              ) {
                await finalizeTransientInteractionCard(inboundMessage.actor, outboundMessage);
                continue;
              }
            }
            await sendOutbound(bot, outboundMessage);
          }
          await stopInboundTyping(bot, inboundMessage.actor);
        } catch (error) {
          releaseInboundDelivery(inboundMessage);
          throw error;
        }
      }
    }
    return {
      ok: !hadBusinessFailure,
      replies,
      ...(hadBusinessFailure ? { status: 503 } : {}),
    };
  }

  function createAssistantReplyBlocks(
    parts: readonly ZCodeAssistantMessagePart[],
    toolCalls: ReadonlyMap<string, BotReplyToolCallState>,
    mode: BotReplyGranularity | undefined,
    changeSummary: ZCodeTaskMeta["changeSummary"] | null | undefined,
  ): BotAssistantReplyBlock[] {
    const blocks: BotAssistantReplyBlock[] = [];
    const resolvedMode = mode ?? getDefaultBotReplyGranularity();
    const presentation = buildZCodeAssistantPresentation({
      content: "",
      toolCalls: [...toolCalls.values()].map((toolCall) => ({
        ...toolCall,
        kind: toolCall.kind ?? "tool",
        input: toolCall.input,
        status: toolCall.status ?? "pending",
      })),
      parts,
    });

    if (resolvedMode === "summary_changes") {
      if (presentation.latestPart?.content.trim()) {
        blocks.push({
          type: "content",
          content: presentation.latestPart.content,
        });
      }
    } else {
      for (const block of presentation.blocks) {
        if (block.type === "content" && block.content.trim()) {
          blocks.push({ type: "content", content: block.content });
          continue;
        }
        if (resolvedMode !== "assistant_toolcalls_changes" || block.type !== "tool-call") {
          continue;
        }
        const toolCall = toolCalls.get(block.toolCall.toolId);
        if (toolCall) {
          blocks.push({ type: "tool-call", toolCall });
        }
      }
    }

    if (changeSummary && changeSummary.fileCount > 0 && changeSummary.files.length > 0) {
      blocks.push({ type: "change-summary", changeSummary });
    }
    return blocks;
  }

  function normalizeBotElicitationQuestions(
    event: Extract<ZCodeStreamEvent, { type: "elicitation_request" }>,
    locale: Locale | undefined,
  ): ZCodeElicitationQuestion[] {
    const schema = isRecord(event.schema) ? event.schema : null;
    const isPlanApproval = schema?.interaction === "plan_approval";
    if (isPlanApproval) {
      return [
        {
          question: msg(locale, "planApprovalTitle"),
          header: msg(locale, "planApprovalHeader"),
          options: [
            {
              value: "approve",
              label: msg(locale, "planApprovalApprove"),
              description: msg(locale, "planApprovalApproveDescription"),
            },
          ],
        },
      ];
    }
    const sourceQuestions =
      event.questions && event.questions.length > 0
        ? event.questions
        : [
            {
              question: event.message,
              header: event.header ?? event.message,
              options: event.options,
              ...(event.multiSelect ? { multiSelect: true } : {}),
            },
          ];
    return sourceQuestions.map((question) => ({
      question: question.question,
      header: question.header || question.question,
      options: question.options.map((option) => ({
        value: option.value,
        label: option.label || option.value,
        description: option.description,
      })),
      ...(question.multiSelect ? { multiSelect: true } : {}),
    }));
  }

  function readBotElicitationRenderContext(
    event: Extract<ZCodeStreamEvent, { type: "elicitation_request" }>,
  ): BotPendingElicitation["renderContext"] {
    const schema = isRecord(event.schema) ? event.schema : null;
    if (
      schema?.interaction !== "plan_approval" ||
      typeof schema.plan !== "string" ||
      !schema.plan.trim()
    ) {
      return undefined;
    }
    return { kind: "plan_approval", plan: schema.plan.trim() };
  }

  function createPendingElicitationSchema(
    pending: BotPendingElicitation,
  ): Record<string, unknown> | undefined {
    return pending.renderContext?.kind === "plan_approval"
      ? { interaction: "plan_approval", plan: pending.renderContext.plan }
      : undefined;
  }

  function getElicitationAnswerKey(questionIndex: number): string {
    return String(questionIndex);
  }

  function readElicitationAnswerValues(
    pending: BotPendingElicitation,
    questionIndex: number,
  ): string[] {
    return pending.answers[getElicitationAnswerKey(questionIndex)] ?? [];
  }

  function getPendingElicitationSelectionToken(pending: BotPendingElicitation): string {
    return createHash("sha256")
      .update(
        [pending.taskId, pending.runId, pending.requestId, pending.currentQuestionIndex].join("::"),
      )
      .digest("hex")
      .slice(0, 12);
  }

  function getPendingElicitationSkipOptionId(pending: BotPendingElicitation): string {
    return `${BOT_ELICITATION_SKIP_OPTION_ID}:${getPendingElicitationSelectionToken(pending)}`;
  }

  function parseElicitationResponseValue(value: string): {
    token?: string;
    value: string;
  } {
    const trimmed = value.trim();
    const [maybeToken, ...rest] = trimmed.split(/\s+/u);
    if (maybeToken && rest.length > 0 && /^[a-f0-9]{12}$/iu.test(maybeToken)) {
      return { token: maybeToken.toLowerCase(), value: rest.join(" ") };
    }
    return { value: trimmed };
  }

  function parseElicitationFormValues(value: string): string[] | null {
    if (!value.startsWith(BOT_ELICITATION_FORM_VALUE_PREFIX)) {
      return null;
    }
    const encoded = value.slice(BOT_ELICITATION_FORM_VALUE_PREFIX.length);
    try {
      const parsed = JSON.parse(decodeURIComponent(encoded)) as unknown;
      const values = Array.isArray(parsed) ? parsed : [parsed];
      return values.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
    } catch {
      return [];
    }
  }

  function mergeElicitationFormValues(
    question: ZCodeElicitationQuestion,
    selectedValues: readonly string[],
    formValues: readonly string[],
  ): string[] {
    const customValues = formValues.filter(Boolean);
    if (!question.multiSelect) {
      return customValues.length > 0 ? customValues.slice(0, 1) : selectedValues.slice(0, 1);
    }
    const merged: string[] = [];
    for (const value of [...selectedValues, ...customValues]) {
      if (!value || merged.includes(value)) {
        continue;
      }
      merged.push(value);
    }
    return merged;
  }

  function toggleElicitationCustomAnswerExpanded(
    pending: BotPendingElicitation,
  ): BotPendingElicitation {
    const current = new Set(pending.expandedCustomAnswerQuestionIndexes ?? []);
    if (current.has(pending.currentQuestionIndex)) {
      current.delete(pending.currentQuestionIndex);
    } else {
      current.add(pending.currentQuestionIndex);
    }
    return {
      ...pending,
      expandedCustomAnswerQuestionIndexes: [...current].sort((left, right) => left - right),
    };
  }

  function resolveElicitationQuestionValue(
    question: ZCodeElicitationQuestion,
    value: string,
    options: { includeSubmit?: boolean } = {},
  ): string {
    const trimmed = value.trim();
    if (!trimmed) {
      return "";
    }
    const normalized = normalizeText(trimmed);
    if (
      question.multiSelect &&
      options.includeSubmit !== false &&
      ["submit", "done", "完成", "提交", BOT_ELICITATION_SUBMIT_OPTION_ID].includes(normalized)
    ) {
      return BOT_ELICITATION_SUBMIT_OPTION_ID;
    }
    const option = resolveOptionByValue(
      question.options.map((item) => ({ id: item.value, label: item.label })),
      trimmed,
    );
    if (option) {
      return option.id;
    }
    const index = Number.parseInt(trimmed, 10);
    if (
      question.multiSelect &&
      options.includeSubmit !== false &&
      /^[1-9]\d*$/u.test(trimmed) &&
      index === question.options.length + 1
    ) {
      return BOT_ELICITATION_SUBMIT_OPTION_ID;
    }
    return trimmed;
  }

  function isPendingElicitationOwnedByActor(
    pending: BotPendingElicitation,
    actor: BotActor,
  ): boolean {
    return (
      !pending.actorKey ||
      pending.actorKey === getActorContextKey(actor) ||
      (actor.chatType === "group" &&
        pending.actorKey.startsWith(`${actor.botId}::${actor.provider}::${actor.chatId}::`))
    );
  }

  function clearPendingElicitationSelection(pending: BotPendingElicitation): void {
    const token = getPendingElicitationSelectionToken(pending);
    for (const [contextKey, selection] of pendingSelectionsByContext) {
      if (
        selection.action === "elicitation.respond" &&
        (selection.token === token || selection.id.startsWith(`elicitation-${pending.requestId}-`))
      ) {
        pendingSelectionsByContext.delete(contextKey);
      }
    }
  }

  function buildBotElicitationContent(
    pending: BotPendingElicitation,
    answers: BotPendingElicitation["answers"] = pending.answers,
  ): Record<string, unknown> {
    // 修复原因：Bot 与桌面共用“缺少 key 表示跳过”的问答契约；未答题不能写成
    // 空字符串，否则 Agent 会把它误判为用户提供的偏好。
    const answerEntries = pending.questions.flatMap((question, index) => {
      const values = answers[getElicitationAnswerKey(index)] ?? [];
      const text = values.join(", ").trim();
      return text ? [[question.question, text]] : [];
    });
    const content: Record<string, unknown> = {
      answers: Object.fromEntries(answerEntries),
    };
    pending.questions.forEach((question, index) => {
      const values = answers[getElicitationAnswerKey(index)] ?? [];
      if (values.length > 0) {
        content[`answer_${index}`] = question.multiSelect ? values : values[0];
      }
    });
    if (pending.questions.length === 1) {
      const values = answers[getElicitationAnswerKey(0)] ?? [];
      if (values.length > 0) {
        content.answer = pending.questions[0]?.multiSelect ? values : values[0];
      }
    }
    return content;
  }

  function createBotElicitationRequestSnapshot(
    pending: BotPendingElicitation,
  ): ZCodeElicitationRequest {
    const currentQuestion = pending.questions[pending.currentQuestionIndex] ?? pending.questions[0];
    const answerDrafts = Object.fromEntries(
      Object.entries(pending.answers).map(([index, values]) => [`answer_${index}`, values]),
    );
    return {
      type: "elicitation_request",
      taskId: pending.taskId,
      traceId: pending.runId,
      requestId: pending.requestId,
      ...(pending.origin ? { origin: pending.origin } : {}),
      message: currentQuestion?.question ?? "",
      header: currentQuestion?.header,
      options: currentQuestion?.options ?? [],
      ...(currentQuestion?.multiSelect ? { multiSelect: true } : {}),
      questions: pending.questions,
      currentQuestionIndex: pending.currentQuestionIndex,
      answerDrafts,
      ...(createPendingElicitationSchema(pending)
        ? { schema: createPendingElicitationSchema(pending) }
        : {}),
    };
  }

  async function broadcastPendingElicitationProgress(
    context: BotContextState,
    pending: BotPendingElicitation,
  ): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      broadcastTaskListChange(context, pending.taskId, "elicitation_request", {
        elicitationRequest: createBotElicitationRequestSnapshot(pending),
        requestId: pending.requestId,
      }).then(() => "broadcast" as const),
      new Promise<"timeout">((resolve) => {
        timeout = setTimeout(
          () => resolve("timeout"),
          BOT_ELICITATION_PROGRESS_BROADCAST_TIMEOUT_MS,
        );
      }),
    ]);
    if (timeout) {
      clearTimeout(timeout);
    }
    if (outcome === "timeout") {
      // 修复原因：v4/UI 进度广播只是辅助同步。广播 RPC 悬挂时若一直 await，
      // 飞书按钮回调无法生成下一题，也到不了 card/update，用户会永久停在第一题。
      botsLogger.warn(
        undefined,
        `elicitation progress broadcast timed out task=${pending.taskId} request=${pending.requestId}`,
      );
    }
  }

  function formatBotElicitationTitle(
    pending: BotPendingElicitation,
    locale: Locale | undefined,
  ): string {
    const question = pending.questions[pending.currentQuestionIndex];
    if (!question) {
      return pending.requestId;
    }
    const isCustomAnswerExpanded =
      pending.expandedCustomAnswerQuestionIndexes?.includes(pending.currentQuestionIndex) === true;
    if (pending.renderContext?.kind === "plan_approval") {
      // Bugfix: Feishu 卡片能直接消费 schema.plan，但 Telegram/微信只渲染 message.text。
      // 在共享出站标题中投影完整计划，确保所有纯文本渠道都保留审批上下文。
      return [
        pending.renderContext.plan,
        "------",
        msg(locale, "planApprovalTitle"),
        isCustomAnswerExpanded ? msg(locale, "elicitationCustomPlaceholder") : null,
      ]
        .filter((part): part is string => typeof part === "string" && part.length > 0)
        .join("\n\n");
    }
    const parts = [
      pending.questions.length > 1
        ? `${pending.currentQuestionIndex + 1}/${pending.questions.length}`
        : null,
      question.header && question.header !== question.question ? question.header : null,
      question.question,
      question.multiSelect ? msg(locale, "elicitationMultiSelectHint") : null,
      isCustomAnswerExpanded ? msg(locale, "elicitationCustomPlaceholder") : null,
      msg(locale, "elicitationTextHint"),
    ].filter((part): part is string => typeof part === "string" && part.length > 0);
    return parts.join("\n");
  }

  function createBotElicitationSelection(
    pending: BotPendingElicitation,
    locale: Locale | undefined,
  ): SelectionPrompt {
    const question = pending.questions[pending.currentQuestionIndex];
    const selectedValues = new Set(
      readElicitationAnswerValues(pending, pending.currentQuestionIndex),
    );
    const options: SelectionPrompt["options"] =
      question?.options.map((option) => ({
        id: option.value,
        label: question.multiSelect
          ? `${selectedValues.has(option.value) ? "[x]" : "[ ]"} ${option.label}`
          : option.label,
        // Plan approval 的说明属于语义元数据；纯文本渠道只展示批准/自定义两个动作，
        // 避免把“退出计划模式”展开成额外正文，保持与 Feishu 卡片一致。
        description:
          pending.renderContext?.kind === "plan_approval" ? undefined : option.description,
      })) ?? [];
    if (pending.renderContext?.kind === "plan_approval") {
      // Bugfix: Feishu provider 会自行补自定义回答表单，但 Telegram/微信依赖共享 selection。
      // Plan approval 必须在这里补入口，避免非卡片渠道只能批准、无法提交修改意见。
      options.push({
        id: BOT_ELICITATION_CUSTOM_OPTION_ID,
        label: msg(locale, "elicitationCustomOption"),
      });
    }
    if (question?.multiSelect) {
      options.push({
        id: BOT_ELICITATION_SUBMIT_OPTION_ID,
        label: msg(locale, "elicitationSubmitOption"),
      });
    } else if (question) {
      options.push({
        id: getPendingElicitationSkipOptionId(pending),
        label: msg(locale, "elicitationSkipOption"),
      });
    }
    return {
      id: `elicitation-${pending.requestId}-${pending.currentQuestionIndex}`,
      token: getPendingElicitationSelectionToken(pending),
      title: formatBotElicitationTitle(pending, locale),
      action: "elicitation.respond",
      options,
    };
  }

  async function createElicitationReply(
    actor: BotActor,
    pending: BotPendingElicitation,
    locale: Locale | undefined,
    status: NonNullable<BotOutboundMessage["elicitation"]>["status"] = "pending",
  ): Promise<BotOutboundMessage[]> {
    const currentQuestionIndex =
      status === "pending"
        ? pending.currentQuestionIndex
        : Math.max(0, pending.questions.length - 1);
    return createSelectionReply(actor, createBotElicitationSelection(pending, locale), locale, {
      locale,
      elicitation: {
        requestId: pending.requestId,
        taskId: pending.taskId,
        runId: pending.runId,
        currentQuestionIndex,
        questions: pending.questions,
        answers: pending.answers,
        status,
        ...(pending.expandedCustomAnswerQuestionIndexes?.length
          ? {
              expandedCustomAnswerQuestionIndexes: pending.expandedCustomAnswerQuestionIndexes,
            }
          : {}),
        ...(createPendingElicitationSchema(pending)
          ? { schema: createPendingElicitationSchema(pending) }
          : {}),
      },
    });
  }

  function createCompletedElicitationOutbound(
    actor: BotActor,
    pending: BotPendingElicitation,
    locale: Locale | undefined,
    action: "accept" | "decline" | "cancel",
  ): BotOutboundMessage {
    const status = action === "cancel" ? "cancelled" : "completed";
    return createOutbound(
      actor,
      msg(locale, action === "accept" ? "elicitationSubmitted" : "elicitationCancelled"),
      undefined,
      {
        locale,
        elicitation: {
          requestId: pending.requestId,
          taskId: pending.taskId,
          runId: pending.runId,
          currentQuestionIndex: Math.max(0, pending.questions.length - 1),
          questions: pending.questions,
          answers: pending.answers,
          status,
          ...(createPendingElicitationSchema(pending)
            ? { schema: createPendingElicitationSchema(pending) }
            : {}),
        },
      },
    );
  }

  async function clearPendingElicitationForRequest(
    context: BotContextState,
    requestId: string,
  ): Promise<void> {
    if (context.pendingElicitation?.requestId !== requestId) {
      return;
    }
    clearPendingElicitationSelection(context.pendingElicitation);
    await writeContext({ ...context, pendingElicitation: undefined }, false, context.activeTaskId);
  }

  async function submitPendingElicitation(
    auth: {
      bot: BotConfig;
      context: BotContextState;
      locale: Locale | undefined;
    },
    actor: BotActor,
    pending: BotPendingElicitation,
    action: "accept" | "decline" | "cancel",
    content?: Record<string, unknown>,
  ): Promise<BotOutboundMessage[]> {
    if (!isPendingElicitationOwnedByActor(pending, actor)) {
      return [createOutbound(actor, msg(auth.locale, "elicitationExpired"))];
    }
    if (pending.handledAt) {
      return [createOutbound(actor, msg(auth.locale, "elicitationHandled"))];
    }
    const zcodeTaskService = await resolveZCodeTaskServiceForContext(auth.context);
    const submitted = await zcodeTaskService.respondElicitation({
      taskId: pending.taskId,
      workspacePath: auth.context.workspacePath,
      workspaceIdentity: auth.context.workspaceIdentity,
      runId: pending.runId,
      requestId: pending.requestId,
      action,
      content,
    });
    // 修复原因：v4 resolveInteraction 才是业务确认点。若在 ACK 前写 handledAt，
    // 瞬时失败后的同一按钮重试会被误判为已处理，Agent 将永久停在等待用户输入。
    const handledAt = Date.now();
    await writeContext({
      ...auth.context,
      pendingElicitation: { ...pending, handledAt },
    });
    clearPendingElicitationSelection(pending);
    await writeContext({ ...auth.context, pendingElicitation: undefined });
    await broadcastTaskListChange(auth.context, pending.taskId, "elicitation_resolved", {
      requestId: pending.requestId,
    });
    if (!submitted) {
      return [createOutbound(actor, msg(auth.locale, "elicitationHandled"))];
    }
    if (action === "accept") {
      startTyping(auth.bot, actor, pending.taskId);
      // Bugfix: AskUserQuestion 只是在回复问题，不属于命令配置成功；这里保留原问答提交文案，避免误回 /status。
      return [createCompletedElicitationOutbound(actor, pending, auth.locale, action)];
    }
    // Bugfix: 取消/拒绝问答也应使用问答自己的结果文案，避免第三方 Bot 里出现无关的任务状态。
    return [createCompletedElicitationOutbound(actor, pending, auth.locale, action)];
  }

  async function advancePendingElicitation(
    auth: {
      bot: BotConfig;
      context: BotContextState;
      locale: Locale | undefined;
    },
    actor: BotActor,
    pending: BotPendingElicitation,
    answers: BotPendingElicitation["answers"],
  ): Promise<BotOutboundMessage[]> {
    if (pending.currentQuestionIndex >= pending.questions.length - 1) {
      return submitPendingElicitation(
        auth,
        actor,
        { ...pending, answers },
        "accept",
        buildBotElicitationContent(pending, answers),
      );
    }
    const nextPending: BotPendingElicitation = {
      ...pending,
      currentQuestionIndex: pending.currentQuestionIndex + 1,
      answers,
    };
    await writeContext({ ...auth.context, pendingElicitation: nextPending });
    // Bugfix: Bot 侧代选 AskUserQuestion 后，UI 只收到最终响应会停留在旧本地草稿。
    // 每次推进题号都同步当前题号和已选答案，让桌面/移动 Web 能保持同一选中态。
    await broadcastPendingElicitationProgress(auth.context, nextPending);
    return createElicitationReply(actor, nextPending, auth.locale);
  }

  async function handlePendingElicitationValue(
    auth: {
      bot: BotConfig;
      context: BotContextState;
      locale: Locale | undefined;
    },
    actor: BotActor,
    value: string,
  ): Promise<BotOutboundMessage[]> {
    const pending = auth.context.pendingElicitation;
    if (!pending || pending.taskId !== auth.context.activeTaskId) {
      return [createOutbound(actor, msg(auth.locale, "elicitationExpired"))];
    }
    if (!isPendingElicitationOwnedByActor(pending, actor)) {
      return [createOutbound(actor, msg(auth.locale, "elicitationExpired"))];
    }
    const question = pending.questions[pending.currentQuestionIndex];
    if (!question) {
      return [createOutbound(actor, msg(auth.locale, "elicitationExpired"))];
    }
    const parsedValue = parseElicitationResponseValue(value);
    if (actor.provider !== "weixin") {
      const expectedToken = getPendingElicitationSelectionToken(pending);
      if (!parsedValue.token || parsedValue.token !== expectedToken) {
        // Bugfix: Telegram/飞书/Webhook 的旧按钮可能在新一轮 AskUserQuestion 后才送达。
        // 非微信通道必须带本轮短 token，避免把上一轮按钮编号误当成当前问题的答案。
        return [createOutbound(actor, msg(auth.locale, "elicitationExpired"))];
      }
    }
    if (parsedValue.value === getPendingElicitationSkipOptionId(pending)) {
      return advancePendingElicitation(auth, actor, pending, pending.answers);
    }
    const formValues = parseElicitationFormValues(parsedValue.value);
    if (formValues) {
      const answerKey = getElicitationAnswerKey(pending.currentQuestionIndex);
      const nextValues = mergeElicitationFormValues(
        question,
        readElicitationAnswerValues(pending, pending.currentQuestionIndex),
        formValues,
      );
      if (nextValues.length === 0) {
        return createElicitationReply(actor, pending, auth.locale);
      }
      // Bugfix: 飞书/Lark 平铺选项由按钮维护草稿，表单只负责提交和自定义输入。
      // 提交时需要合并当前 radio/checkbox 草稿和自定义输入，避免空表单把已选项覆盖掉。
      return advancePendingElicitation(auth, actor, pending, {
        ...pending.answers,
        [answerKey]: nextValues,
      });
    }
    const selectionOption = resolvePendingSelectionOption(
      actor,
      "elicitation.respond",
      parsedValue.value,
    );
    if (selectionOption?.id === getPendingElicitationSkipOptionId(pending)) {
      return advancePendingElicitation(auth, actor, pending, pending.answers);
    }
    const selectedValue = resolveElicitationQuestionValue(
      question,
      selectionOption?.id ?? parsedValue.value,
    );
    if (!selectedValue) {
      return createElicitationReply(actor, pending, auth.locale);
    }
    if (selectedValue === BOT_ELICITATION_SUBMIT_OPTION_ID) {
      return advancePendingElicitation(auth, actor, pending, pending.answers);
    }
    if (selectedValue === BOT_ELICITATION_CUSTOM_OPTION_ID) {
      const nextPending = toggleElicitationCustomAnswerExpanded(pending);
      await writeContext({ ...auth.context, pendingElicitation: nextPending });
      await broadcastPendingElicitationProgress(auth.context, nextPending);
      return createElicitationReply(actor, nextPending, auth.locale);
    }
    const answerKey = getElicitationAnswerKey(pending.currentQuestionIndex);
    if (question.multiSelect) {
      const currentValues = readElicitationAnswerValues(pending, pending.currentQuestionIndex);
      const nextValues = currentValues.includes(selectedValue)
        ? currentValues.filter((item) => item !== selectedValue)
        : [...currentValues, selectedValue];
      const nextPending = {
        ...pending,
        answers: { ...pending.answers, [answerKey]: nextValues },
      };
      await writeContext({ ...auth.context, pendingElicitation: nextPending });
      // Bugfix: 多选题在 Bot 里 toggle 后不会触发 ZCode Agent response，必须主动同步草稿给 UI。
      await broadcastPendingElicitationProgress(auth.context, nextPending);
      return createElicitationReply(actor, nextPending, auth.locale);
    }
    return advancePendingElicitation(auth, actor, pending, {
      ...pending.answers,
      [answerKey]: [selectedValue],
    });
  }

  async function handlePendingElicitationText(
    auth: {
      bot: BotConfig;
      context: BotContextState;
      locale: Locale | undefined;
    },
    actor: BotActor,
    text: string,
  ): Promise<BotOutboundMessage[] | null> {
    const pending = auth.context.pendingElicitation;
    if (!pending || pending.taskId !== auth.context.activeTaskId) {
      return null;
    }
    if (!isPendingElicitationOwnedByActor(pending, actor)) {
      return null;
    }
    const value = text.trim();
    if (!value) {
      return createElicitationReply(actor, pending, auth.locale);
    }
    if (value === getPendingElicitationSkipOptionId(pending)) {
      return advancePendingElicitation(auth, actor, pending, pending.answers);
    }
    const answerKey = getElicitationAnswerKey(pending.currentQuestionIndex);
    const question = pending.questions[pending.currentQuestionIndex];
    if (!question) {
      return [createOutbound(actor, msg(auth.locale, "elicitationExpired"))];
    }
    if (
      !question.multiSelect &&
      /^[1-9]\d*$/u.test(value) &&
      Number.parseInt(value, 10) === question.options.length + 1
    ) {
      // 修复原因：自由文本必须保留为用户数据；只有菜单显示的额外序号才是跳过，
      // 避免吞掉名为 skip/next/跳过/__skip__ 的合法选项或自定义答案。
      return advancePendingElicitation(auth, actor, pending, pending.answers);
    }
    const values = question?.multiSelect
      ? value
          .split(/[,\n，、]/u)
          .map((item) => item.trim())
          .filter(Boolean)
          .map((item) =>
            resolveElicitationQuestionValue(question, item, {
              includeSubmit: false,
            }),
          )
      : [resolveElicitationQuestionValue(question, value, { includeSubmit: false })];
    return advancePendingElicitation(auth, actor, pending, {
      ...pending.answers,
      [answerKey]: values,
    });
  }

  async function handleStructuredElicitationResponse(
    message: BotInboundMessage,
    response: BotStructuredElicitationResponse,
  ): Promise<BotOutboundMessage[]> {
    const auth = await withAuthorizedContext(message, "message");
    if (!auth.ok) return auth.reply;
    const pending = auth.context.pendingElicitation;
    if (!pending || pending.requestId !== response.requestId) {
      return [createOutbound(message.actor, msg(auth.locale, "elicitationExpired"))];
    }
    if (!isPendingElicitationOwnedByActor(pending, message.actor)) {
      return [createOutbound(message.actor, msg(auth.locale, "elicitationExpired"))];
    }
    return submitPendingElicitation(
      auth,
      message.actor,
      pending,
      response.action,
      response.content,
    );
  }

  async function handleElicitationRequest(
    bot: BotConfig,
    user: BotConfig,
    actor: BotActor,
    context: BotContextState,
    event: Extract<ZCodeStreamEvent, { type: "elicitation_request" }>,
    mentionedUserIds?: string[],
  ): Promise<void> {
    const locale = await readMessageLocale();
    stopTyping(event.taskId);
    const pendingElicitation: BotPendingElicitation = {
      taskId: event.taskId,
      requestId: event.requestId,
      runId: event.traceId,
      // Bugfix：subagent 发起的 elicitation 必须保留 origin；否则 Bot 广播和后续响应
      // 无法还原请求归属，rebase 后只剩顶层 stream event 带 origin。
      ...(event.origin ? { origin: event.origin } : {}),
      actorKey: getActorContextKey(actor),
      currentQuestionIndex: 0,
      // 修复原因：ExitPlanMode 的协议问题和选项使用稳定英文；如果直接复用，中文 Bot 卡片会中英混杂。
      // Bot 在出站边界按 App locale 本地化整组审批文案，普通 AskUserQuestion 保持模型原文。
      questions: normalizeBotElicitationQuestions(event, locale),
      answers: {},
      // 修复原因：Feishu/Lark 会在自定义回答、完成和重启恢复时重建原卡片；
      // 只把 schema 作为首次发送参数会让后续更新丢失 plan 并退回通用 Question 卡片。
      ...(readBotElicitationRenderContext(event)
        ? { renderContext: readBotElicitationRenderContext(event) }
        : {}),
    };
    // Bugfix: Bot 原先只消费 permission_request，没有把 ZCode Agent 的
    // AskUserQuestion/elicitation_request 转成第三方可回答消息，任务会一直卡在等待用户输入。
    if (context.pendingElicitation) {
      clearPendingElicitationSelection(context.pendingElicitation);
    }
    Object.assign(context, { pendingElicitation });
    await writeContext({ ...context, pendingElicitation }, false, context.activeTaskId);
    await broadcastPendingElicitationProgress(context, pendingElicitation);
    for (const reply of await createElicitationReply(actor, pendingElicitation, locale)) {
      // 原因：临时交互卡绕过普通出站分支，曾丢失群任务和授权版本；选择传输方式前统一附加。
      const scopedReply = context.group
        ? {
            ...reply,
            mentionedUserIds:
              pendingElicitation.renderContext?.kind === "plan_approval"
                ? adminAttention.mention(
                    actor,
                    bot.providerUserId,
                    `plan:${event.taskId}:${event.requestId}`,
                  )
                : mentionedUserIds,
            groupTaskId: context.activeTaskId!,
            groupCard: groupCardFor(actor, context),
          }
        : reply;
      if (shouldUseTransientInteractionCard(bot, user)) {
        await upsertTransientInteractionCard(bot, actor, event.taskId, scopedReply);
      } else {
        await sendOutbound(bot, scopedReply);
      }
    }
  }

  async function watchTaskStream(
    bot: BotConfig,
    actor: BotActor,
    context: BotContextState,
    user: BotConfig,
    automation: boolean | string = false,
  ): Promise<void> {
    const key = taskStreamKey(context, actor);
    const previous = watchStarts.get(key) ?? Promise.resolve();
    const pending = previous
      .catch(() => undefined)
      .then(() => startTaskStream(bot, actor, context, user, automation));
    watchStarts.set(key, pending);
    try {
      await pending;
    } finally {
      if (watchStarts.get(key) === pending) watchStarts.delete(key);
    }
  }

  async function startTaskStream(
    bot: BotConfig,
    actor: BotActor,
    context: BotContextState,
    user: BotConfig,
    automation: boolean | string = false,
  ): Promise<void> {
    if (!context.activeTaskId) {
      return;
    }
    for (const [inputId, input] of Object.entries(context.group?.inputs ?? {})) {
      if (
        input.taskId !== context.activeTaskId ||
        !input.progress?.cardMessageId ||
        input.progress.cardStatus === input.progress.status
      )
        continue;
      await queueCards
        .update(
          JSON.stringify([
            bot.id,
            context.group!.chatId,
            context.activeTaskId,
            context.group!.authorizationId,
            inputId,
            context.group!.threadId,
          ]),
          input.progress.status,
        )
        .catch((error) => {
          botsLogger.warn(
            undefined,
            `restore queue card state failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    }
    const streamSubscriptionKey = taskStreamKey(context, actor);
    const existingSubscription = streamSubscriptions.get(streamSubscriptionKey);
    if (existingSubscription) {
      if (automation)
        existingSubscription.automation(typeof automation === "string" ? automation : undefined);
      return;
    }
    const persistentPrivate = !context.group && !automation && privateSyncSupported(bot);
    const bindingId = context.privateBindingId;
    let automationPending = automation === true;
    let automationRun = Boolean(automation);
    const automationRuns = new Set<string>(typeof automation === "string" ? [automation] : []);
    let imInteractionRun = !persistentPrivate;
    let privateDeliveryFailed = false;
    let privateCardDeliveryUnknown = false;
    const isPrivateAuthorized = async (): Promise<boolean> => {
      if (!persistentPrivate) {
        if (context.group) return true;
        const currentBot = findBot(await repo.readConfig(), bot.id);
        return Boolean(
          currentBot?.enabled &&
          currentBot.provider === bot.provider &&
          currentBot.providerUserId === bot.providerUserId &&
          currentBot.credentialRef === bot.credentialRef,
        );
      }
      const currentBot = findBot(await repo.readConfig(), bot.id);
      const latest = (await repo.readState()).bots[bot.id];
      const recipient =
        currentBot?.provider === "weixin" ? latest?.privateRecipientId : currentBot?.providerUserId;
      return Boolean(
        currentBot?.enabled &&
        currentBot.provider === bot.provider &&
        recipient === actor.providerUserId &&
        latest &&
        latest.privateBindingId === bindingId &&
        isWorkspaceAllowed(
          latest.workspaceId ?? getWorkspaceKey(latest.workspacePath, latest.workspaceIdentity),
          currentBot.allowedWorkspaces,
        ) &&
        latest?.activeTaskId === context.activeTaskId &&
        getWorkspaceKey(latest.workspacePath, latest.workspaceIdentity) ===
          getWorkspaceKey(context.workspacePath, context.workspaceIdentity),
      );
    };
    const zcodeTaskService = await resolveZCodeTaskServiceForContext(context);
    if (context.group) {
      // Bug 原因：旧会话尚未冷恢复时建立结果订阅会耗尽重试；先读取权威状态，
      // 再监听未来事件，避免新请求执行结束后无人消费结果。这里不提交历史输入。
      await zcodeTaskService.getBotGroupTaskBlockReason?.({
        taskId: context.activeTaskId,
        workspacePath: context.workspacePath,
        workspaceIdentity: context.workspaceIdentity,
      });
      // 启动恢复与首条输入可能并发，等待期间另一路已建立订阅时直接复用。
      if (streamSubscriptions.has(streamSubscriptionKey)) return;
    }
    const automationGroupKey =
      actor.chatType === "group" && !context.group ? getBotConversationKey(actor) : null;
    const automationAuthorizationId = automationGroupKey
      ? (await repo.readState()).bots[automationGroupKey]?.group?.authorizationId
      : undefined;
    let disposed = false;
    let resultRunId = "";
    let resultSourceCommandId: string | undefined;
    let resultInputOrigin: "desktop" | "mobile" = "desktop";
    let resultPart = 0;
    let resultMentionedUserIds: string[] | undefined;
    const terminalRuns = new Set<string>();
    const sendTaskOutbound = async (
      targetBot: BotConfig,
      message: BotOutboundMessage,
    ): Promise<void> => {
      if (disposed && (context.group || persistentPrivate)) return;
      if (!(await isPrivateAuthorized())) return;
      if (privateDeliveryFailed) return;
      if (
        persistentPrivate &&
        bot.provider === "weixin" &&
        !imInteractionRun &&
        !(await deps.credentialService.load(weixinContextKey(bot, actor.providerUserId)))
      ) {
        privateDeliveryFailed = true;
        const locale = await readMessageLocale();
        onDeliveryResult(
          bot,
          locale === "en-US"
            ? "Send a message to the bot in Weixin, then retry."
            : "请在微信给机器人发一条消息后重试。",
        );
        return;
      }
      if (automationGroupKey) {
        const current = (await repo.readState()).bots[automationGroupKey]?.group;
        const currentBot = findBot(await repo.readConfig(), bot.id);
        if (
          !current?.enabled ||
          !currentBot?.enabled ||
          current.ownerId !== currentBot.providerUserId ||
          current.authorizationId !== automationAuthorizationId
        )
          return;
      }
      try {
        await sendOutbound(
          targetBot,
          context.group
            ? {
                ...message,
                groupTaskId: context.activeTaskId!,
                threadId: actor.threadId ?? context.group.threadId,
                rootMessageId: actor.rootMessageId ?? context.group.rootMessageId,
                conversationThreadId: actor.conversationThreadId,
                groupSourceCommandId: resultSourceCommandId,
                groupCard: groupCardFor(actor, context),
                replyToMessageId: actor.providerMessageId,
                mentionedUserIds:
                  message.mentionedUserIds ??
                  (message.selection || resultPart === 0 ? resultMentionedUserIds : undefined),
                ...(!message.selection && resultRunId
                  ? {
                      deliveryId: createHash("sha256")
                        .update(
                          JSON.stringify([
                            bot.id,
                            context.group.chatId,
                            context.activeTaskId,
                            resultRunId,
                            resultPart++,
                          ]),
                        )
                        .digest("hex"),
                    }
                  : {}),
                // 来源保留在关联元数据中；拼进正文会产生多余的 Desktop／Mobile Web 标签。
                text: message.text,
              }
            : message,
          automationGroupKey
            ? async () => {
                const current = (await repo.readState()).bots[automationGroupKey]?.group;
                const currentBot = findBot(await repo.readConfig(), bot.id);
                return Boolean(
                  current?.enabled &&
                  currentBot?.enabled &&
                  current.ownerId === currentBot.providerUserId &&
                  current.authorizationId === automationAuthorizationId,
                );
              }
            : undefined,
        );
      } catch (error) {
        if (!persistentPrivate) throw error;
        privateDeliveryFailed = true;
      }
    };
    let assistantParts: ZCodeAssistantMessagePart[] = [];
    let assistantReplyBuffer = "";
    let sentAnyAssistantReply = false;
    const assistantPartToolIds = new Set<string>();
    const toolCalls = new Map<string, BotReplyToolCallState>();
    const sentToolCallReplyIds = new Set<string>();
    const getMode = () =>
      context.group || automationRun
        ? "summary_changes"
        : normalizeBotReplyGranularity(bot.provider, user.replyMode);
    let streamingCardHandle: BotStreamingReplyCardHandle | null = null;
    let streamingCardSegmentIndex = 0;
    const streamingCardBlocks: StreamingCardTimelineBlock[] = [];
    let streamingCardStatus: "running" | "sealed" | "completed" | "error" = "running";
    let streamingCardLastUpdateAt = 0;
    let streamingCardConsecutiveFailures = 0;
    let streamingCardNextAttemptAt = 0;
    let streamingCardCircuitOpen = false;
    let streamingCardQueue: Promise<void> = Promise.resolve();
    const supportsStreamingCardReply = () => {
      const adapter = providers[bot.provider];
      return (
        getMode() === "streaming_card" &&
        isFeishuBotProvider(bot.provider) &&
        Boolean(adapter?.createStreamingReplyCard) &&
        Boolean(adapter?.updateStreamingReplyCard)
      );
    };
    const buildStreamingToolSummaryTitle = (locale: Locale | undefined): string =>
      msg(locale, "streamingToolSummaries");
    const appendStreamingCardMessageChunk = (content: string): void => {
      if (!content) {
        return;
      }
      const lastBlock = streamingCardBlocks.at(-1);
      if (lastBlock?.type === "message") {
        lastBlock.text += content;
        return;
      }
      streamingCardBlocks.push({ type: "message", text: content });
    };
    const appendStreamingCardMessages = (messages: readonly string[]): void => {
      for (const message of messages.map((item) => item.trim()).filter(Boolean)) {
        const lastBlock = streamingCardBlocks.at(-1);
        if (lastBlock?.type === "message" && lastBlock.text.trim()) {
          lastBlock.text = `${lastBlock.text.trim()}\n\n${message}`;
        } else {
          streamingCardBlocks.push({ type: "message", text: message });
        }
      }
    };
    const hasStreamingCardMessageText = (): boolean =>
      streamingCardBlocks.some((block) => block.type === "message" && block.text.trim().length > 0);
    const appendStreamingCardTool = (toolId: string): void => {
      const existingBlock = streamingCardBlocks.find(
        (block) => block.type === "tools" && block.toolIds.includes(toolId),
      );
      if (existingBlock) {
        return;
      }
      const lastBlock = streamingCardBlocks.at(-1);
      if (lastBlock?.type === "tools") {
        lastBlock.toolIds.push(toolId);
        return;
      }
      streamingCardBlocks.push({ type: "tools", toolIds: [toolId] });
    };
    const buildStreamingCardBlocks = (locale: Locale | undefined): BotStreamingReplyCardBlock[] => {
      const toolSummaryTitle = buildStreamingToolSummaryTitle(locale);
      const latestToolBlockIndex = streamingCardBlocks.reduce(
        (latestIndex, block, index) => (block.type === "tools" ? index : latestIndex),
        -1,
      );
      const blocks: BotStreamingReplyCardBlock[] = [];
      for (const [index, block] of streamingCardBlocks.entries()) {
        if (block.type === "message") {
          const text = block.text.trim();
          if (text) {
            blocks.push({ type: "message", text });
          }
          continue;
        }
        const summaries = block.toolIds
          .map((toolId) => toolCalls.get(toolId))
          .filter((toolCall): toolCall is BotReplyToolCallState => Boolean(toolCall))
          .map((toolCall) =>
            formatBotToolCallSummaryLine(toolCall, {
              workspacePath: context.workspacePath,
              locale,
            }),
          );
        if (summaries.length === 0) {
          continue;
        }
        blocks.push({
          type: "tools",
          title: toolSummaryTitle,
          summaries,
          expanded: streamingCardStatus === "running" && index === latestToolBlockIndex,
        });
      }
      if (blocks.length === 0) {
        blocks.push({
          type: "message",
          text: msg(locale, "streamingWorking"),
        });
      }
      return blocks;
    };
    const syncStreamingCardReply = async (trigger: string, force = false): Promise<void> => {
      if (!supportsStreamingCardReply() || (persistentPrivate && privateCardDeliveryUnknown)) {
        return;
      }
      const now = Date.now();
      // Bugfix：旧实现只在成功后更新时间基准，Feishu 失败时每个 stream event 都会真实发请求；
      // force 路径还会绕过普通节流。失败退避和熔断必须先于 force 判断，避免单次 400 被放大成风暴。
      if (streamingCardCircuitOpen || now < streamingCardNextAttemptAt) {
        return;
      }
      if (
        streamingCardHandle &&
        !force &&
        now - streamingCardLastUpdateAt < FEISHU_STREAMING_CARD_MIN_UPDATE_INTERVAL_MS
      ) {
        return;
      }
      const adapter = providers[bot.provider];
      const locale = await readMessageLocale();
      const state = {
        providerUserId: actor.providerUserId,
        locale,
        blocks: buildStreamingCardBlocks(locale),
        status: streamingCardStatus,
      };
      const states = adapter?.splitStreamingReplyCardStates?.(state) ?? [state];
      streamingCardQueue = streamingCardQueue
        .catch(() => undefined)
        .then(async () => {
          if (disposed || !(await isPrivateAuthorized())) return;
          let operation = streamingCardHandle ? "update" : "create";
          const requestController = new AbortController();
          streamingCardRequestControllers.add(requestController);
          const timeoutId = setTimeout(() => {
            requestController.abort(new Error("Feishu streaming card request timed out."));
          }, FEISHU_STREAMING_CARD_REQUEST_TIMEOUT_MS);
          try {
            for (
              let index = Math.min(streamingCardSegmentIndex, states.length - 1);
              index < states.length;
              index += 1
            ) {
              if (disposed || !(await isPrivateAuthorized())) return;
              const segmentState = states[index]!;
              operation = streamingCardHandle ? "update" : "create";
              const request = !streamingCardHandle
                ? adapter?.createStreamingReplyCard?.(bot, segmentState, requestController.signal)
                : adapter?.updateStreamingReplyCard?.(
                    bot,
                    streamingCardHandle,
                    segmentState,
                    requestController.signal,
                  );
              const result = await Promise.race([
                request,
                new Promise<never>((_, reject) => {
                  requestController.signal.addEventListener(
                    "abort",
                    () => reject(requestController.signal.reason),
                    { once: true },
                  );
                }),
              ]);
              if (!streamingCardHandle) {
                streamingCardHandle = result ?? null;
                if (!streamingCardHandle) {
                  // Bug 根因：飞书创建接口可能 code=0 却不返回 message_id。若把这种静默失败
                  // 当成成功推进 segmentIndex，未投递的中间段会被永久跳过；必须统一进入退避重试。
                  throw new Error("Feishu create streaming card returned no message_id.");
                }
              }
              if (index < states.length - 1) {
                // 修复原因：当前卡片达到飞书元素预算后必须保留为 sealed 历史段，
                // 后续 block 只写入新卡片，不能把已展示内容再次发送或继续更新旧 message_id。
                streamingCardSegmentIndex = index + 1;
                streamingCardHandle = null;
              }
            }
            if (persistentPrivate) privateDeliveryFailed = false;
            streamingCardLastUpdateAt = Date.now();
            streamingCardConsecutiveFailures = 0;
            streamingCardNextAttemptAt = 0;
          } catch (error) {
            // Bugfix: 第三方卡片只是 best-effort 展示，超时/失败不能阻塞 task_complete、
            // task_error 或 typing 清理等生命周期事件。
            if (persistentPrivate) {
              privateDeliveryFailed = true;
              privateCardDeliveryUnknown = !isRecord(error) || error.deliveryRejected !== true;
            }
            streamingCardConsecutiveFailures += 1;
            const errorMessage = error instanceof Error ? error.message : String(error);
            onDeliveryResult(bot, errorMessage);
            if (
              streamingCardConsecutiveFailures >= FEISHU_STREAMING_CARD_FAILURE_CIRCUIT_THRESHOLD
            ) {
              streamingCardCircuitOpen = true;
              botsLogger.warn(
                undefined,
                `Feishu streaming card circuit opened task=${context.activeTaskId} trigger=${trigger} operation=${operation} failures=${streamingCardConsecutiveFailures}: ${errorMessage}`,
              );
            } else {
              const retryDelayMs =
                FEISHU_STREAMING_CARD_FAILURE_BACKOFF_BASE_MS *
                2 ** (streamingCardConsecutiveFailures - 1);
              streamingCardNextAttemptAt = Date.now() + retryDelayMs;
              botsLogger.warn(
                undefined,
                `Feishu streaming card sync failed task=${context.activeTaskId} trigger=${trigger} operation=${operation} failures=${streamingCardConsecutiveFailures} retryDelayMs=${retryDelayMs}: ${errorMessage}`,
              );
            }
          } finally {
            clearTimeout(timeoutId);
            streamingCardRequestControllers.delete(requestController);
          }
        });
      await streamingCardQueue;
    };
    const sealStreamingCardReply = async (): Promise<void> => {
      if (!streamingCardHandle) {
        return;
      }
      // 修复原因：阻塞交互前的 Agent 输出与交互后的 continuation 属于两个可读段落。
      // 旧实现继续复用同一 message_id，导致问题/Plan 卡夹在中间但后续正文回写到旧卡。
      streamingCardStatus = "sealed";
      await syncStreamingCardReply("seal", true);
      streamingCardHandle = null;
      streamingCardSegmentIndex = 0;
      streamingCardBlocks.length = 0;
      streamingCardStatus = "running";
      streamingCardLastUpdateAt = 0;
    };
    const flushAssistantReplyBuffer = async (force = false) => {
      if (
        getMode() === "summary_changes" ||
        supportsStreamingCardReply() ||
        !assistantReplyBuffer
      ) {
        return;
      }
      const extracted = extractBotAssistantResponseMessages(assistantReplyBuffer, force);
      assistantReplyBuffer = extracted.rest;
      for (const text of extracted.messages) {
        sentAnyAssistantReply = true;
        await sendTaskOutbound(bot, createOutbound(actor, text));
      }
    };
    const handleStreamEventImpl = async (
      event: ZCodeStreamEvent | TaskStreamMirrorableEvent,
      shouldBroadcast = true,
    ): Promise<void> => {
      if (disposed) return;
      if (event.type === "task_stream_mirror_batch") {
        if (shouldBroadcast) {
          await broadcastTaskStreamEvent(context, event);
        }
        // Bugfix: 共享 host / 远控下 UI 收到的是 workspace 级 mirror batch。
        // 旧逻辑只识别裸 stream event，导致 UI 正常流式显示但 Bot channel 没有任何可发送回复。
        for (const op of event.ops) {
          if (op.kind === "stream_event") {
            await handleStreamEvent(op.event, false);
          }
        }
        return;
      }
      if (
        typeof automation === "string" &&
        !persistentPrivate &&
        event.traceId !== automation &&
        event.inputId !== automation
      )
        return;
      if (persistentPrivate) {
        if (!(await isPrivateAuthorized())) return;
        const runId = event.inputId ?? event.traceId;
        if (event.type === "task_run_started") {
          if (runId && (terminalRuns.has(runId) || resultRunId === runId)) return;
          resultRunId = runId ?? "";
          privateDeliveryFailed = false;
          privateCardDeliveryUnknown = false;
          user = findBot(await repo.readConfig(), bot.id) ?? user;
          resultSourceCommandId = event.inputId;
          automationRun =
            automationRuns.delete(runId ?? "") ||
            automationRuns.delete(event.traceId) ||
            automationPending;
          automationPending = false;
          // 桌面/手机轮次只能同步输出，不能凭常驻订阅增加 IM 审批入口。
          imInteractionRun = privateImTraces.has(
            JSON.stringify([streamSubscriptionKey, event.traceId]),
          );
          assistantParts = [];
          assistantReplyBuffer = "";
          sentAnyAssistantReply = false;
          assistantPartToolIds.clear();
          toolCalls.clear();
          sentToolCallReplyIds.clear();
          streamingCardHandle = null;
          streamingCardBlocks.length = 0;
          streamingCardSegmentIndex = 0;
          streamingCardStatus = "running";
          streamingCardLastUpdateAt = 0;
          streamingCardConsecutiveFailures = 0;
          streamingCardNextAttemptAt = 0;
          streamingCardCircuitOpen = false;
        } else {
          if (runId && terminalRuns.has(runId)) return;
          if (!resultRunId && runId) resultRunId = runId;
          if (resultSourceCommandId && event.inputId && resultSourceCommandId !== event.inputId)
            return;
        }
        if (event.type === "task_complete" || event.type === "task_error") {
          if (runId) terminalRuns.add(runId);
          // continuous 不重放旧轮；有界保留重复终态保护。
          if (terminalRuns.size > 128) terminalRuns.delete(terminalRuns.values().next().value!);
        }
        if (
          !imInteractionRun &&
          (event.type === "permission_request" || event.type === "elicitation_request")
        )
          return;
      }
      if (context.group) {
        const latest = (await repo.readState()).bots[getBotStateKey(context)];
        const currentBot = findBot(await repo.readConfig(), bot.id);
        if (
          !latest?.group?.enabled ||
          latest.activeTaskId !== context.activeTaskId ||
          latest.group.ownerId !== currentBot?.providerUserId ||
          !currentBot.enabled
        )
          return;
        // 停止续接后旧输入可能迟到；不能用它覆盖新轮的缓存、表情或投递目标。
        if (
          latest.group.threadId &&
          resultSourceCommandId &&
          event.inputId &&
          event.type !== "task_run_started" &&
          event.inputId !== resultSourceCommandId
        )
          return;
        if (event.type === "task_complete" || event.type === "task_error") {
          const terminalKey = event.inputId ?? event.traceId ?? resultRunId;
          if (terminalKey && terminalRuns.has(terminalKey)) return;
          if (terminalKey) terminalRuns.add(terminalKey);
        }
        if (event.type === "turn_steer_status" && event.status !== "drained") {
          for (const id of event.pendingInputIds ?? []) {
            const input = latest.group.inputs?.[id];
            if (!input || input.taskId !== context.activeTaskId) continue;
            await updateGroupInputReaction(
              bot,
              context,
              input.source.messageId,
              event.reason === "session_resumed" ? "discarded" : "cancelled",
            );
            // 话题不再提供排队/Steer 交互；旧运行丢弃事件只更新原输入状态与表情。
            if (latest.group.threadId) continue;
            const locale = await readMessageLocale();
            const text =
              event.reason === "session_resumed"
                ? locale === "en-US"
                  ? "Queued input was discarded after runtime restart; it was not executed."
                  : "排队输入已在运行时重启后丢弃，未执行。"
                : locale === "en-US"
                  ? "Queued input was removed or rejected; it will not execute."
                  : "排队输入已删除或被拒绝，不会执行。";
            const inputActor: BotActor = {
              ...actor,
              providerUserId: input.source.senderId,
              providerMessageId: input.source.messageId,
              mentionedBot: input.source.mentionedBot,
              threadId: input.source.threadId ?? context.group.threadId,
              rootMessageId: input.source.rootMessageId ?? context.group.rootMessageId,
              conversationThreadId: context.group.threadId ?? null,
            };
            await sendOutbound(bot, {
              ...createOutbound(inputActor, text),
              groupTaskId: context.activeTaskId!,
              groupCard: groupCardFor(inputActor, context),
              replyToMessageId: input.source.messageId,
              deliveryId: createHash("sha256")
                .update(`${id}:${event.status}:${event.reason}`)
                .digest("hex"),
            });
          }
          return;
        }
        if (event.type === "task_run_started") resultInputOrigin = event.inputOrigin ?? "desktop";
        if (event.type === "task_run_started" || event.inputId) {
          const source = event.inputId ? latest.group.inputs?.[event.inputId]?.source : undefined;
          // 按本轮可信输入解析，不能把无来源的桌面结果或重试归给群 owner/最近发言者。
          const isTopicReply = !!(source?.threadId ?? latest.group.threadId);
          resultMentionedUserIds = source
            ? [
                ...new Set(
                  (source.messages ?? [source])
                    .filter((item) => !isTopicReply || item.mentionedBot === true)
                    .map((item) => item.senderId),
                ),
              ]
            : undefined;
          if (!resultMentionedUserIds?.length) resultMentionedUserIds = undefined;
          actor = {
            ...actor,
            providerUserId: source?.senderId ?? latest.group.ownerId,
            displayName:
              source?.senderName ?? (resultInputOrigin === "mobile" ? "Mobile Web" : "Desktop"),
            providerMessageId: source?.messageId,
            mentionedBot: source?.mentionedBot,
            threadId: source?.threadId ?? latest.group.threadId,
            rootMessageId: source?.rootMessageId ?? latest.group.rootMessageId,
            conversationThreadId:
              source?.threadId && source.threadId !== latest.group.threadId
                ? (latest.group.threadId ?? null)
                : undefined,
          };
          context.group = { ...latest.group, initiatorId: source?.senderId };
        }
        if (event.type === "task_run_started") {
          await updateGroupInputReaction(bot, context, actor.providerMessageId, "working");
          resultRunId = event.inputId ?? event.traceId;
          resultSourceCommandId = event.inputId;
          resultPart = 0;
          assistantParts = [];
          assistantReplyBuffer = "";
          sentAnyAssistantReply = false;
          assistantPartToolIds.clear();
          toolCalls.clear();
          sentToolCallReplyIds.clear();
          await writeContext(context, false, context.activeTaskId);
        }
      }
      if (context.group && !resultRunId) {
        resultRunId = event.inputId ?? event.traceId;
        resultSourceCommandId = event.inputId;
      }
      if (shouldBroadcast) {
        await broadcastTaskStreamEvent(context, event);
      }
      // Bugfix: 第三方默认回复需要随 AssistantMessageResponse 流式发送；
      // 但 /status Progress 仍然要独立缓存，避免受发送颗粒度影响。
      updateLiveStatusProgress(event);
      if (event.type === "agent_message_chunk") {
        assistantParts = appendAssistantMessagePart(assistantParts, {
          type: "content",
          content: event.content,
        });
        if (supportsStreamingCardReply()) {
          appendStreamingCardMessageChunk(event.content);
          await syncStreamingCardReply(event.type, false);
          return;
        }
        if (getMode() !== "summary_changes") {
          assistantReplyBuffer += event.content;
          // 第三方平台消息是离散气泡；formatter 负责把当前 buffer 按长度约束拆成可发送消息。
          await flushAssistantReplyBuffer(false);
        }
        return;
      }
      if (event.type === "agent_thought_chunk") {
        assistantParts = appendAssistantMessagePart(assistantParts, {
          type: "thought",
          content: event.content,
        });
      }
      if (event.type === "tool_call" || event.type === "tool_call_update") {
        if (supportsStreamingCardReply()) {
          appendStreamingCardTool(event.toolId);
        }
        if (!supportsStreamingCardReply()) {
          await flushAssistantReplyBuffer(true);
        }
        // Bugfix: summary_changes 完成消息需要参考 UI latestPart。
        // tool_call_update 可能在缺少 tool_call 首帧时先到，需像 UI 一样补一个 tool-call part 边界。
        if (!assistantPartToolIds.has(event.toolId)) {
          assistantPartToolIds.add(event.toolId);
          assistantParts = appendAssistantMessagePart(assistantParts, {
            type: "tool-call",
            toolId: event.toolId,
          });
        }
      }
      updateBotReplyToolCalls(toolCalls, event);
      if (event.type === "tool_call" && supportsStreamingCardReply()) {
        await syncStreamingCardReply(event.type, true);
      }
      if (event.type === "tool_call_update" && supportsStreamingCardReply()) {
        await syncStreamingCardReply(event.type, isBotToolCallReplyTerminal(event.status));
      }
      if (
        event.type === "tool_call_update" &&
        getMode() === "assistant_toolcalls_changes" &&
        isBotToolCallReplyTerminal(event.status) &&
        !sentToolCallReplyIds.has(event.toolId)
      ) {
        const toolCall = toolCalls.get(event.toolId);
        if (toolCall) {
          sentToolCallReplyIds.add(event.toolId);
          sentAnyAssistantReply = true;
          await sendTaskOutbound(
            bot,
            createOutbound(
              actor,
              formatBotToolCallReply(toolCall, {
                workspacePath: context.workspacePath,
                locale: await readMessageLocale(),
              }),
            ),
          );
        }
      }
      if (event.type === "permission_request") {
        const locale = await readMessageLocale();
        stopTyping(event.taskId);
        await sealStreamingCardReply();
        await broadcastTaskListChange(context, event.taskId, "permission_request", {
          permissionRequest: event,
        });
        // Bugfix: UI 会把 ZCode Agent 原始权限选项规整成“允许/始终允许/拒绝”的固定顺序和文案；
        // 机器人之前直接展示 provider 原始英文 name，还额外加取消按钮，导致同一个权限请求在飞书和 UI 看起来不一致。
        const permissionOptions = sortBotPermissionOptions(event.options);
        const permissionSelection: SelectionPrompt = {
          id: `permission-${event.requestId}`,
          title: formatBotPermissionRequestSummary(event, {
            locale,
            workspacePath: context.workspacePath,
          }),
          action: "permission.respond",
          showCancel: false,
          options: permissionOptions.map((option) => {
            const isDenyOption = isBotPermissionRejectOption(option);
            return {
              id: isDenyOption
                ? `/deny ${event.requestId}`
                : `/approve ${event.requestId} ${option.optionId}`,
              label: formatBotPermissionOptionLabel(option, locale),
              description: formatBotPermissionOptionDescription(option, event, locale),
            };
          }),
        };
        // Bugfix: Telegram callback_data 只有 64 字节，真实 toolCallId/requestId 可能过长。
        // 因此按钮只回传短序号，真实 requestId/optionId 暂存在当前 bot context 中再解析。
        const pendingPermissionOptions = permissionOptions.map((option) => {
          const isDenyCommand = isBotPermissionRejectOption(option);
          return {
            requestId: event.requestId,
            optionId: option.optionId,
            command: isDenyCommand ? ("deny" as const) : ("approve" as const),
            label: formatBotPermissionOptionLabel(option, locale),
            response: option.response,
          };
        });
        Object.assign(context, { pendingPermissionOptions });
        await writeContext({ ...context, pendingPermissionOptions }, false, context.activeTaskId);
        const [permissionReply] = await createSelectionReply(
          actor,
          permissionSelection,
          await readMessageLocale(),
        );
        if (permissionReply) {
          if (shouldUseTransientInteractionCard(bot, user)) {
            // 原因：Feishu 群配置归一化后也会走临时卡分支，不能因此跳过群卡授权字段。
            await upsertTransientInteractionCard(
              bot,
              actor,
              event.taskId,
              context.group
                ? {
                    ...permissionReply,
                    mentionedUserIds: adminAttention.mention(
                      actor,
                      bot.providerUserId,
                      `permission:${event.taskId}:${event.requestId}`,
                    ),
                    groupTaskId: context.activeTaskId!,
                    groupCard: groupCardFor(actor, context),
                  }
                : permissionReply,
            );
          } else {
            await sendTaskOutbound(
              bot,
              context.group
                ? administratorReply(
                    actor,
                    bot,
                    `permission:${event.taskId}:${event.requestId}`,
                    permissionReply,
                  )
                : permissionReply,
            );
          }
        }
        return;
      }
      if (event.type === "elicitation_request") {
        await sealStreamingCardReply();
        await handleElicitationRequest(bot, user, actor, context, event, resultMentionedUserIds);
        return;
      }
      if (event.type === "elicitation_response") {
        await clearPendingElicitationForRequest(context, event.requestId);
        await broadcastTaskListChange(context, event.taskId, "elicitation_resolved", {
          requestId: event.requestId,
        });
        return;
      }
      if (event.type === "task_complete" || event.type === "task_error") {
        if (context.group) {
          await updateGroupInputReaction(
            bot,
            context,
            actor.providerMessageId,
            event.type === "task_error"
              ? "failed"
              : /stop|cancel|interrupt|abort/iu.test(event.stopReason)
                ? "stopped"
                : "done",
          );
        }
        privateImTraces.delete(JSON.stringify([streamSubscriptionKey, event.traceId]));
        runningTasks.delete(event.taskId);
        liveStatusProgressByTaskId.delete(event.taskId);
        stopTyping(event.taskId);
        if (context.pendingElicitation?.taskId === event.taskId) {
          clearPendingElicitationSelection(context.pendingElicitation);
          await writeContext(
            { ...context, pendingElicitation: undefined },
            false,
            context.activeTaskId,
          );
        }
        const transientCard = transientInteractionCards.get(getActorContextKey(actor));
        if (transientCard?.taskId === event.taskId) {
          const pendingElicitation = context.pendingElicitation;
          await finalizeTransientInteractionCard(
            actor,
            pendingElicitation
              ? createCompletedElicitationOutbound(
                  actor,
                  pendingElicitation,
                  await readMessageLocale(),
                  "cancel",
                )
              : createOutbound(
                  actor,
                  event.type === "task_error"
                    ? msg(await readMessageLocale(), "taskFailed", {
                        message: event.error,
                      })
                    : msg(await readMessageLocale(), "received"),
                ),
          );
        }
        // Bugfix: ZCode Agent 终态事件可能先于 task index/meta 落盘广播到 Bots。
        // 如果这里立刻用旧 meta 更新 sidebar，随后列表再刷新到终态 meta，会出现状态/摘要跳一下。
        // 因此终态广播前短重试读取一次稳定 meta，尽量用同一帧完成 UI 增量更新。
        const completedTask = await readTerminalTaskMeta(context, event.taskId, event.type).catch(
          () => null,
        );
        await broadcastTaskListChange(
          context,
          event.taskId,
          event.type === "task_error" ? "error" : "completed",
          {
            ...(completedTask ? { task: completedTask } : {}),
            ...(event.type === "task_error" ? { error: event.error } : {}),
          },
        );
        if (!context.group && !persistentPrivate) {
          streamSubscriptions.get(streamSubscriptionKey)?.dispose();
          streamSubscriptions.delete(streamSubscriptionKey);
        }
        if (event.type === "task_error") {
          if (supportsStreamingCardReply()) {
            streamingCardStatus = "error";
            if (!hasStreamingCardMessageText()) {
              appendStreamingCardMessages([
                msg(await readMessageLocale(), "taskFailed", {
                  message: event.error,
                }),
              ]);
            }
            await syncStreamingCardReply(event.type, true);
            return;
          }
          await sendTaskOutbound(
            bot,
            createOutbound(
              actor,
              msg(await readMessageLocale(), "taskFailed", {
                message: event.error,
              }),
            ),
          );
          return;
        }

        if (context.group && /stop|cancel|interrupt|abort/iu.test(event.stopReason)) {
          // 停止通知会触发群内其他机器人继续回复；主聊天与话题统一静默，前面的状态清理仍保留。
          return;
        }
        const mode = getMode();
        const locale = await readMessageLocale();
        const completedSnapshot = await zcodeTaskService
          .getTaskSnapshot({
            taskId: event.taskId,
            workspacePath: context.workspacePath,
            workspaceIdentity: context.workspaceIdentity,
          })
          .catch(() => null);
        const latestTurnChangeSummary = readLatestAssistantTurnChangeSummary(completedSnapshot);
        if (supportsStreamingCardReply()) {
          const changeSummaryMessages = formatBotAssistantReplyBlocks(
            createAssistantReplyBlocks([], new Map(), mode, latestTurnChangeSummary),
            {
              workspacePath: context.workspacePath,
              locale,
            },
          );
          if (changeSummaryMessages.length > 0) {
            appendStreamingCardMessages(changeSummaryMessages);
          }
          streamingCardStatus = "completed";
          await syncStreamingCardReply(event.type, true);
          sentAnyAssistantReply = true;
          return;
        }
        let replyMessages: string[] = [];
        if (mode === "summary_changes") {
          const replyBlocks = createAssistantReplyBlocks(
            assistantParts,
            toolCalls,
            mode,
            latestTurnChangeSummary,
          );
          replyMessages = formatBotAssistantReplyBlocks(replyBlocks, {
            workspacePath: context.workspacePath,
            locale,
          });
        } else {
          await flushAssistantReplyBuffer(true);
          const changeSummaryBlocks = createAssistantReplyBlocks(
            [],
            new Map(),
            mode,
            latestTurnChangeSummary,
          );
          replyMessages = formatBotAssistantReplyBlocks(changeSummaryBlocks, {
            workspacePath: context.workspacePath,
            locale,
          });
        }
        if (replyMessages.length === 0 && !sentAnyAssistantReply) {
          const source = resultSourceCommandId
            ? context.group?.inputs?.[resultSourceCommandId]?.source
            : undefined;
          // 无 @ 续聊允许模型不参与，空输出不能再被“任务已完成”兜底变成抢答。
          if (
            context.group?.threadId &&
            source?.botIdentity &&
            source.mentionedBot === false &&
            !source.messages?.some((message) => message.mentionedBot === true)
          )
            return;
          await sendTaskOutbound(
            bot,
            createOutbound(actor, locale === "en-US" ? "Task completed." : "任务已完成。"),
          );
          return;
        }
        for (const text of replyMessages) {
          sentAnyAssistantReply = true;
          await sendTaskOutbound(bot, createOutbound(actor, text));
        }
      }
    };
    const handleStreamEvent = async (
      event: ZCodeStreamEvent | TaskStreamMirrorableEvent,
      shouldBroadcast = true,
    ): Promise<void> => {
      try {
        await handleStreamEventImpl(event, shouldBroadcast);
      } finally {
        if (
          persistentPrivate &&
          privateDeliveryFailed &&
          (event.type === "task_complete" || event.type === "task_error") &&
          (await isPrivateAuthorized())
        ) {
          const locale = await readMessageLocale();
          const texts = formatBotAssistantReplyBlocks(
            createAssistantReplyBlocks(assistantParts, toolCalls, "assistant_changes", undefined),
            { workspacePath: context.workspacePath, locale },
          );
          const text =
            texts.join("\n\n") ||
            (event.type === "task_error" ? event.error : msg(locale, "received"));
          const id = randomUUID();
          privateDeliveryFailed = false;
          failedPrivateDeliveries.set(bot.id, {
            id,
            bindingId,
            taskId: context.activeTaskId!,
            message: createOutbound(actor, text),
            sending: false,
          });
          const runtime = runtimeByBotId.get(bot.id);
          setRuntimeStatus({
            botId: bot.id,
            provider: bot.provider,
            status: runtime?.status ?? "idle",
            deliveryRetryId: id,
          });
        }
      }
    };
    let streamEventQueue: Promise<void> = Promise.resolve();
    const enqueueStreamEvent = (
      event: ZCodeStreamEvent | TaskStreamMirrorableEvent,
    ): Promise<void> => {
      const shouldBroadcast = !forwardedTaskEvents.has(event);
      forwardedTaskEvents.add(event);
      const nextStreamEvent = streamEventQueue.then(() =>
        handleStreamEvent(event, shouldBroadcast),
      );
      // Bugfix: ZCode Agent 事件分发不保证等待 async listener。微信这类离散消息如果并发发送，
      // task_complete 的 Change summary 可能抢在前面正文 flush 之前到达客户端，所以这里按任务串行消费。
      streamEventQueue = nextStreamEvent.catch((error: unknown) => {
        botsLogger.warn(
          event.traceId,
          `bot task stream event failed task=${event.taskId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
      return streamEventQueue;
    };
    const dynamicTaskEvent = (
      zcodeTaskService as Partial<Pick<IZCodeTaskService, "onDynamicTaskEvent">>
    ).onDynamicTaskEvent;
    // Bugfix: 远控/共享 host 场景会通过 workspace+task mirror 分发流事件。
    // 这里优先订阅 workspace 级事件，避免只监听本地 taskId relay 时漏掉 channel 回复。
    const streamDisposable = taskStreamHub.add(
      JSON.stringify([
        getWorkspaceKey(context.workspacePath, context.workspaceIdentity),
        context.activeTaskId,
      ]),
      streamSubscriptionKey,
      (receive) =>
        dynamicTaskEvent
          ? dynamicTaskEvent({
              workspacePath: context.workspacePath,
              workspaceIdentity: context.workspaceIdentity,
              taskId: context.activeTaskId!,
              // Bugfix: Bot channel 使用 direct stream 语义。
              // 手机远控 replayable 的 mirror replay / snapshot gap recovery 会改变 bot 回复边界，
              // 这里使用 bot 专属 continuous 订阅，避免远控恢复逻辑影响飞书/微信等 channel。
              deliveryKind: "bot-channel-continuous",
            })(receive)
          : zcodeTaskService.onDynamicStreamEvent(context.activeTaskId!)(receive),
      enqueueStreamEvent,
    );
    streamSubscriptions.set(streamSubscriptionKey, {
      imInput() {
        if (!resultRunId) imInteractionRun = true;
      },
      automation(runId) {
        if (runId) automationRuns.add(runId);
        else {
          automationPending = true;
          if (!resultRunId) automationRun = true;
        }
      },
      dispose() {
        disposed = true;
        streamDisposable.dispose();
      },
    });
    if (!context.group && !persistentPrivate) startTyping(bot, actor, context.activeTaskId);
  }

  async function createSelectionReply(
    actor: BotActor,
    selection: SelectionPrompt,
    locale?: Locale,
    extras: Pick<BotOutboundMessage, "elicitation" | "locale"> = {},
  ): Promise<BotOutboundMessage[]> {
    const markedSelection = markCurrentSelection(selection, locale);
    // Bugfix: 微信没有原生选项卡能力，只能走纯文本编号选项。
    // 之前纯文本 fallback 会同时展示标题里的“当前”和选项上的“当前”标记，
    // 微信回复看起来像重复状态文案；这里让标题负责说明当前状态，列表只保留可回复的编号。
    const supportsStructuredSelection = actor.provider !== "weixin";
    // Bugfix: 微信 /model 第一层选择的是供应商，之前复用 description 把模型列表也拼进同一行，
    // 导致用户还没选供应商就看到两层信息。纯文本通道先只展示供应商，模型放到下一层再展示。
    const textSelection = stripModelProviderDescriptionsForTextSelection(selection);
    const displaySelection = supportsStructuredSelection
      ? markedSelection
      : { ...textSelection, cancelLabel: markedSelection.cancelLabel };
    pendingSelectionsByContext.set(getActorContextKey(actor), displaySelection);
    // 其他 provider 保留 selection，让 Telegram/飞书/Lark 渲染原生选项，也让 Webhook 接收结构化选项。
    const text = supportsStructuredSelection
      ? displaySelection.title
      : formatSelectionFallback(displaySelection, locale);
    return [
      createOutbound(actor, text, supportsStructuredSelection ? displaySelection : undefined, {
        ...extras,
        locale,
      }),
    ];
  }

  async function handleSelectionCancel(message: BotInboundMessage): Promise<BotOutboundMessage[]> {
    const locale = await readMessageLocale();
    const actorContextKey = getActorContextKey(message.actor);
    const pendingSelection = pendingSelectionsByContext.get(actorContextKey);
    if (message.actor.chatType === "group") {
      const auth = await withAuthorizedContext(message, "message");
      if (!auth.ok) return auth.reply;
      clearPendingSelection(message.actor);
      return createStatusReply(message.actor, auth.context, locale);
    }
    if (pendingSelection?.action === "elicitation.respond") {
      const auth = await withAuthorizedContext(message, "message");
      if (!auth.ok) return auth.reply;
      const pending = auth.context.pendingElicitation;
      if (!pending) {
        clearPendingSelection(message.actor);
        return [createOutbound(message.actor, msg(auth.locale, "elicitationExpired"))];
      }
      clearPendingSelection(message.actor);
      return submitPendingElicitation(auth, message.actor, pending, "cancel");
    }
    if (!pendingSelectionsByContext.has(actorContextKey)) {
      const auth = await withAuthorizedContext(message, "message");
      if (auth.ok && auth.context.pendingElicitation) {
        return submitPendingElicitation(
          auth,
          message.actor,
          auth.context.pendingElicitation,
          "cancel",
        );
      }
      return [createOutbound(message.actor, msg(locale, "unknownCommand", { command: "0" }))];
    }
    clearPendingSelection(message.actor);
    const auth = await withAuthorizedContext(message, "message");
    if (!auth.ok) return auth.reply;
    return createStatusReply(message.actor, auth.context, auth.locale);
  }

  function buildRemoteReconnectCommandKey(
    actor: BotActor,
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity" | "hostId">,
  ): string {
    return [
      actor.botId,
      actor.provider,
      actor.chatId ?? actor.providerUserId,
      getWorkspaceKey(context.workspacePath, context.workspaceIdentity),
    ].join("::");
  }

  function buildRemoteReconnectDeliveryKey(message: BotInboundMessage): string | null {
    const providerMessageId = message.actor.providerMessageId?.trim();
    if (!providerMessageId) {
      return null;
    }
    return [
      message.actor.botId,
      message.actor.provider,
      message.actor.chatId ?? message.actor.providerUserId,
      providerMessageId,
    ].join("::");
  }

  function pruneRecentRemoteReconnectDeliveryDedupe(now: number): void {
    for (const [key, at] of recentRemoteReconnectDeliveryAtByKey) {
      if (now - at >= REMOTE_RECONNECT_DELIVERY_DEDUPE_TTL_MS) {
        recentRemoteReconnectDeliveryAtByKey.delete(key);
      }
    }
  }

  async function performRemoteReconnect(
    message: BotInboundMessage,
    auth: Extract<Awaited<ReturnType<typeof withAuthorizedContext>>, { ok: true }>,
  ): Promise<BotOutboundMessage[]> {
    let result: BotRemoteWorkspaceReconnectResult;
    try {
      result = await reconnectRemoteWorkspaceForBot(auth.context);
    } catch (error) {
      result = {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
    if (!result.ok) {
      return [
        administratorReply(
          message.actor,
          auth.bot,
          "remote",
          createOutbound(
            message.actor,
            msg(auth.locale, "remoteReconnectFailed", {
              workspacePath: auth.context.workspacePath,
              message: result.message ?? "unknown",
            }),
          ),
        ),
      ];
    }
    adminAttention.clear(message.actor, auth.bot.providerUserId, "remote");
    if (auth.context.mode === "draft" || !auth.context.activeTaskId) {
      const draftOptions = await buildInitializedDraftOptions(auth.context);
      await writeContext({ ...auth.context, draftOptions });
    }
    await reconcilePrivateSynchronization(auth.context.botId);
    // 成功重连后统一回完整状态，避免命令完成文案和 /status 内容分裂。
    return createStatusReply(message.actor, auth.context, auth.locale);
  }

  async function handleReconnect(
    message: BotInboundMessage,
    options: {
      onReconnectStart?: (
        auth: Extract<Awaited<ReturnType<typeof withAuthorizedContext>>, { ok: true }>,
      ) => Promise<void>;
    } = {},
  ): Promise<BotOutboundMessage[]> {
    const auth = await withAuthorizedContext(message, "workspace");
    if (!auth.ok) return auth.reply;
    if (!auth.context.workspaceIdentity) {
      return [createOutbound(message.actor, msg(auth.locale, "remoteReconnectLocal"))];
    }
    if (!deps.remoteWorkspaceService) {
      return [
        createOutbound(
          message.actor,
          msg(auth.locale, "remoteReconnectUnavailable", {
            workspacePath: auth.context.workspacePath,
          }),
        ),
      ];
    }

    const now = Date.now();
    pruneRecentRemoteReconnectDeliveryDedupe(now);
    const deliveryKey = buildRemoteReconnectDeliveryKey(message);
    if (deliveryKey && recentRemoteReconnectDeliveryAtByKey.has(deliveryKey)) {
      return [];
    }
    if (deliveryKey) {
      // Bugfix: 飞书/微信/Telegram 都可能重投同一条 provider message。
      // /reconnect 有副作用，必须在真正执行前就按 provider message id 幂等，
      // 否则重投会再次命中“已连接”分支，用户会看到重复的成功提示。
      recentRemoteReconnectDeliveryAtByKey.set(deliveryKey, now);
    }

    const reconnectKey = buildRemoteReconnectCommandKey(message.actor, auth.context);
    const pendingReconnect = pendingRemoteReconnectsByKey.get(reconnectKey);
    if (pendingReconnect) {
      await pendingReconnect.catch(() => []);
      return [];
    }
    const recentReconnectAt = recentRemoteReconnectAtByKey.get(reconnectKey);
    if (
      recentReconnectAt !== undefined &&
      now - recentReconnectAt < REMOTE_RECONNECT_DEDUPE_TTL_MS
    ) {
      return [];
    }
    if (await isRemoteWorkspaceConnected(auth.context)) {
      return createStatusReply(message.actor, auth.context, auth.locale);
    }

    // Bugfix: Feishu/Lark/Webhook 这类 provider 可能把同一条 /reconnect 在短时间内重复投递。
    // /reconnect 本身有副作用，必须按 bot+用户+workspace 做幂等，否则会同时出现“已连接”和“正在重连”等互相打架的状态。
    const reconnectPromise = (async () => {
      if (options.onReconnectStart) {
        try {
          await options.onReconnectStart(auth);
        } catch (error) {
          // Bugfix: “正在重连”只是即时状态提示，发送失败不能中断真正的远端重连。
          botsLogger.warn(
            undefined,
            `send reconnect starting failed provider=${message.actor.provider} bot=${message.botId} user=${message.actor.providerUserId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return performRemoteReconnect(message, auth);
    })();
    pendingRemoteReconnectsByKey.set(reconnectKey, reconnectPromise);
    try {
      const replies = await reconnectPromise;
      recentRemoteReconnectAtByKey.set(reconnectKey, Date.now());
      return replies;
    } finally {
      pendingRemoteReconnectsByKey.delete(reconnectKey);
    }
  }

  async function withAuthorizedContext(
    message: BotInboundMessage,
    requestedCommand: BotAuthorizedCommand,
  ): Promise<
    | {
        ok: true;
        config: BotsConfigFile;
        bot: BotConfig;
        user: BotConfig;
        context: BotContextState;
        locale: Locale | undefined;
      }
    | { ok: false; reply: BotOutboundMessage[] }
  > {
    const locale = await readMessageLocale();
    const config = await repo.readConfig();
    const bot = findAuthorizedBot(config, message.actor);
    if (!bot || bot.id !== message.botId) {
      return {
        ok: false,
        reply: [createOutbound(message.actor, msg(locale, "botDisabled"))],
      };
    }
    if (message.actor.chatType !== "private" && !isFeishuBotProvider(bot.provider)) {
      return {
        ok: false,
        reply: [createOutbound(message.actor, msg(locale, "privateChatOnly"))],
      };
    }
    const groupContext =
      message.actor.chatType === "group" ? await readContext(message.actor, bot) : null;
    if (message.actor.chatType === "group") {
      if (!groupContext?.group?.enabled || groupContext.group.ownerId !== bot.providerUserId) {
        return {
          ok: false,
          reply: [
            {
              ...administratorReply(
                message.actor,
                bot,
                "group-disabled",
                createOutbound(message.actor, msg(locale, "groupNotEnabled")),
              ),
              callbackToastOnly: true,
            },
          ],
        };
      }
      if (message.groupCard || message.groupCardAction) {
        const card = message.groupCard;
        if (
          !card ||
          card.chatId !== groupContext.group.chatId ||
          card.threadId !== message.actor.threadId ||
          getBotConversationKey({ botId: bot.id, chatType: "group", ...card }) !==
            getBotStateKey(groupContext) ||
          card.taskId !== groupContext.activeTaskId ||
          card.authorizationId !== groupContext.group.authorizationId
        ) {
          return {
            ok: false,
            reply: [
              {
                ...createOutbound(message.actor, msg(locale, "elicitationExpired")),
                callbackToastOnly: true,
              },
            ],
          };
        }
      }
      adminAttention.clear(message.actor, bot.providerUserId, "group-disabled");
      if (
        requestedCommand === "reply" ||
        (isGroupOwnerCommand(requestedCommand) &&
          message.actor.providerUserId !== bot.providerUserId)
      ) {
        return {
          ok: false,
          reply: [
            {
              ...(requestedCommand === "reply"
                ? createOutbound(message.actor, msg(locale, "groupOwnerOnly"))
                : administratorReply(
                    message.actor,
                    bot,
                    requestedCommand === "approve" && groupContext.pendingPermissionOptions?.[0]
                      ? `permission:${groupContext.activeTaskId}:${groupContext.pendingPermissionOptions[0].requestId}`
                      : "owner-command",
                    createOutbound(message.actor, msg(locale, "groupOwnerOnly")),
                  )),
              callbackToastOnly: true,
            },
          ],
        };
      }
    }
    if (
      groupContext &&
      message.actor.providerUserId === bot.providerUserId &&
      isGroupOwnerCommand(requestedCommand)
    ) {
      adminAttention.clear(message.actor, bot.providerUserId, "owner-command");
    }
    const user = groupContext
      ? {
          ...bot,
          currentOptions: groupContext.group!.currentOptions,
          replyMode: "summary_changes" as const,
        }
      : findBoundUser(bot, message.actor);
    if (!user) {
      return {
        ok: false,
        reply: [createOutbound(message.actor, msg(locale, "userNotBound"))],
      };
    }
    if (!isUserCommandAllowed(user, requestedCommand)) {
      return {
        ok: false,
        reply: [createOutbound(message.actor, msg(locale, "commandNotAllowed"))],
      };
    }
    if (groupContext?.group) {
      const parsed = parseBotCommand(message.commandText ?? message.text);
      const isAnswer =
        message.senderType !== "app" &&
        (Boolean(message.elicitationResponse) ||
          parsed.type === "elicitation.respond" ||
          parsed.type === "elicitation.submit");
      if (
        isAnswer &&
        !canAnswerGroupQuestion(
          message.actor.providerUserId,
          groupContext.group.ownerId,
          groupContext.group.initiatorId,
          groupContext.pendingElicitation?.renderContext?.kind === "plan_approval",
        )
      ) {
        return {
          ok: false,
          reply: [
            {
              ...(groupContext.pendingElicitation?.renderContext?.kind === "plan_approval"
                ? administratorReply(
                    message.actor,
                    bot,
                    `plan:${groupContext.activeTaskId}:${groupContext.pendingElicitation.requestId}`,
                    createOutbound(message.actor, msg(locale, "groupOwnerOnly")),
                  )
                : createOutbound(message.actor, msg(locale, "groupOwnerOnly"))),
              callbackToastOnly: true,
            },
          ],
        };
      }
    }
    const context = groupContext ?? (await readContext(message.actor, bot));
    if (!context) {
      return {
        ok: false,
        reply: [
          administratorReply(
            message.actor,
            bot,
            "workspace",
            createOutbound(message.actor, msg(locale, "noWorkspaceAllowed")),
          ),
        ],
      };
    }
    const synced = context.group
      ? { config, bot, user }
      : await normalizeBotWorkspaceConfig(config, bot, {
          id:
            context.workspaceId ??
            getWorkspaceKey(context.workspacePath, context.workspaceIdentity),
          label: getWorkspaceLabel(context.workspacePath),
          workspacePath: context.workspacePath,
          workspaceIdentity: context.workspaceIdentity,
        });
    if (
      context.workspaceId &&
      !isWorkspaceAllowed(context.workspaceId, synced.user.allowedWorkspaces)
    ) {
      return {
        ok: false,
        reply: [
          administratorReply(
            message.actor,
            bot,
            "workspace",
            createOutbound(message.actor, msg(locale, "workspaceOutOfScope")),
          ),
        ],
      };
    }
    const remoteDisconnectedReply = await blockDisconnectedRemoteWorkspace({
      message,
      context,
      locale,
      requestedCommand,
    });
    if (remoteDisconnectedReply) {
      return { ok: false, reply: remoteDisconnectedReply };
    }
    if (isFeishuBotProvider(bot.provider) && !context.group) {
      // Bugfix: 飞书短命令 typing 现在由同步回复完成后显式删除。
      // 这里必须等 reaction 创建完成，否则 stopInboundTyping 可能先执行，最终留下无法清理的 Typing reaction。
      await sendTyping(bot, message.actor);
    } else if (!context.group) {
      void sendTyping(bot, message.actor);
    }
    return {
      ok: true,
      config: synced.config,
      bot: synced.bot,
      user: groupContext ? user : synced.user,
      context,
      locale,
    };
  }

  async function handleBind(
    message: BotInboundMessage,
    code: string,
  ): Promise<BotOutboundMessage[]> {
    const locale = await readMessageLocale();
    if (message.actor.chatType !== "private") {
      return [createOutbound(message.actor, msg(locale, "bindPrivateOnly"))];
    }
    const record = bindCodes.get(code.trim().toUpperCase());
    if (!record || record.expiresAt <= Date.now() || record.botId !== message.botId) {
      return [createOutbound(message.actor, msg(locale, "bindCodeInvalid"))];
    }
    const config = await repo.readConfig();
    const bot = findBot(config, record.botId);
    if (!bot) {
      return [createOutbound(message.actor, msg(locale, "bindBotMissing"))];
    }
    // Bot 配置化后 /bind 只绑定当前 bot，不再向 bot 追加 allowedUsers。
    // 重新绑定会覆盖旧 providerUserId，保证一个 bot 同一时间只有一个沟通对象。
    const nextBot: BotConfig = {
      ...bot,
      providerUserId: message.actor.providerUserId,
      displayName: message.actor.displayName,
      allowedWorkspaces: normalizeAllowedWorkspaces(record.allowedWorkspaces),
      allowedCommands: normalizeBotCommandPolicy(bot.allowedCommands),
      replyMode: normalizeBotReplyGranularity(bot.provider, bot.replyMode),
    };
    validateBotConfig(config, nextBot);
    await writeBotConfig({
      ...config,
      bots: config.bots.map((item) => (item.id === nextBot.id ? nextBot : item)),
    });
    bindCodes.delete(record.code);
    return [
      createOutbound(
        message.actor,
        [msg(locale, "bindSuccess"), buildHelpText(locale, nextBot)].join("\n\n"),
      ),
    ];
  }

  async function handleStatus(message: BotInboundMessage): Promise<BotOutboundMessage[]> {
    const auth = await withAuthorizedContext(message, "status");
    if (!auth.ok) {
      return auth.reply;
    }
    // 群内 /status 与配置后的状态回复共用脱敏入口，避免单独分支泄露绝对路径。
    return createStatusReply(message.actor, auth.context, auth.locale);
  }

  async function createStatusReply(
    actor: BotActor,
    context: BotContextState,
    locale: Locale | undefined,
  ): Promise<BotOutboundMessage[]> {
    return [
      createOutbound(
        actor,
        context.group
          ? (await buildStatusText(context, locale))
              .split(context.workspacePath)
              .join(getWorkspaceLabel(context.workspacePath))
          : await buildStatusText(context, locale),
        undefined,
        {
          locale,
        },
      ),
    ];
  }

  function formatStatusLine(
    locale: Locale | undefined,
    labelId: BotMessageId,
    value: string,
  ): string {
    // Bugfix: /status 文案由服务层拼接，标签和值都要跟随 bot 当前 locale。
    return `${msg(locale, labelId)}: ${value}`;
  }

  function formatStatusStateValue(locale: Locale | undefined, state: string): string {
    if (locale === "en-US") {
      return state;
    }
    switch (state) {
      case "draft":
        return msg(locale, "statusDraft");
      case "remote disconnected":
        return msg(locale, "statusRemoteDisconnected");
      case "running":
        return msg(locale, "streamingStatusRunning");
      case "completed":
        return msg(locale, "streamingStatusCompleted");
      case "error":
      case "failed":
        return msg(locale, "streamingStatusFailed");
      case "cancelled":
        return msg(locale, "statusCancelled");
      case "stopped":
        return msg(locale, "statusStopped");
      default:
        return state;
    }
  }

  async function buildStatusText(
    context: BotContextState,
    locale: Locale | undefined,
  ): Promise<string> {
    const workspace = (await listWorkspaceRefs()).find((item) => item.id === context.workspaceId);
    if (!(await isRemoteWorkspaceConnected(context))) {
      const draftOptions = context.draftOptions;
      return [
        formatStatusLine(locale, "statusWorkspace", workspace?.label ?? context.workspacePath),
        formatStatusLine(
          locale,
          "statusModel",
          await formatStatusModelLabel(
            formatBotModelSelectionValue(draftOptions?.modelSelection),
            context,
          ),
        ),
        "------",
        formatStatusLine(locale, "statusTask", context.activeTaskId ?? msg(locale, "statusDraft")),
        formatStatusLine(
          locale,
          "statusState",
          formatStatusStateValue(locale, "remote disconnected"),
        ),
        msg(locale, "remoteDisconnectedStatus", {
          workspacePath: context.workspacePath,
        }),
      ].join("\n");
    }
    const zcodeTaskService = await resolveZCodeTaskServiceForContext(context);
    const tasks = await zcodeTaskService.listTasks({
      workspacePath: context.workspacePath,
      workspaceIdentity: context.workspaceIdentity,
    });
    const activeTask = context.activeTaskId
      ? tasks.find((task) => task.taskId === context.activeTaskId)
      : null;
    const activeTaskSnapshot = context.activeTaskId
      ? await zcodeTaskService
          .getTaskSnapshot({
            taskId: context.activeTaskId,
            workspacePath: context.workspacePath,
            workspaceIdentity: context.workspaceIdentity,
          })
          .catch(() => null)
      : null;
    // Bugfix: activeTaskId 来自 bot context，不应依赖 listTasks 必然返回同一条任务。
    // 某些筛选/索引时序下 listTasks 找不到 active task，之前会跳过 snapshot，导致 Progress 永远缺失。
    const statusTask = activeTask ?? activeTaskSnapshot?.meta ?? null;
    // Bugfix: 任务结束后 /status 只保留最终状态，避免把最后一次工具/思考进度误看成仍在执行。
    const latestProgress =
      context.activeTaskId && (!statusTask || taskStatus(statusTask) === "running")
        ? (liveStatusProgressByTaskId.get(context.activeTaskId)?.text ??
          readLatestTaskProgress(activeTaskSnapshot))
        : null;
    const workedDurationMs = statusTask
      ? readTaskWorkedDurationMs(activeTaskSnapshot, statusTask)
      : null;
    const activeTaskConfigOptions = context.activeTaskId
      ? await listActiveTaskConfigOptions(context, context.activeTaskId)
      : [];
    const isDraftStatus = context.mode === "draft" || !context.activeTaskId;
    const draftOptions = !statusTask && isDraftStatus ? await ensureDraftOptions(context) : null;
    // Bot Draft 属于 Select：未显式固定模型时只展示目标 Host 当前首选，不把默认值写回配置。
    const draftView = draftOptions
      ? await readModelSelectionView(context, draftOptions.modelSelection)
      : null;
    const draftEffectiveSelection = draftOptions?.modelSelection
      ? draftView?.effectiveSelection
      : draftView?.preferredSelection;
    const statusModel =
      readConfigSelectCurrentValue(activeTaskConfigOptions, "model") ??
      statusTask?.model ??
      formatBotModelSelectionValue(draftEffectiveSelection ?? undefined) ??
      "-";
    const statusModelLabel = await formatStatusModelLabel(statusModel, context);
    return (
      [
        formatStatusLine(locale, "statusWorkspace", workspace?.label ?? context.workspacePath),
        // Bugfix: active task 显示真实 task 状态；草稿态显示 draftOptions。
        // /new 后草稿继承自当前 task，继续显示 "-" 会让用户误以为继承失败。
        formatStatusLine(locale, "statusModel", statusModelLabel),
        "------",
        statusTask
          ? formatStatusTaskLine(statusTask, msg(locale, "statusTask"))
          : formatStatusLine(locale, "statusTask", msg(locale, "statusDraft")),
        formatStatusLine(
          locale,
          "statusState",
          formatStatusStateValue(locale, statusTask ? taskStatus(statusTask) : "draft"),
        ),
        workedDurationMs !== null
          ? formatStatusLine(locale, "statusWorked", formatTaskRunningDuration(workedDurationMs))
          : null,
        latestProgress ? formatStatusLine(locale, "statusProgress", latestProgress) : null,
      ].filter(Boolean) as string[]
    ).join("\n");
  }

  async function handleHelp(message: BotInboundMessage): Promise<BotOutboundMessage[]> {
    const auth = await withAuthorizedContext(message, "help");
    if (!auth.ok) {
      return auth.reply;
    }
    return [
      createOutbound(
        message.actor,
        buildHelpText(
          auth.locale,
          auth.bot,
          auth.context.group
            ? message.actor.providerUserId === auth.context.group.ownerId
              ? "owner"
              : "member"
            : undefined,
        ),
      ),
    ];
  }

  function buildHelpText(
    locale: Locale | undefined,
    bot: Pick<BotConfig, "allowedCommands">,
    groupRole?: "owner" | "member",
  ): string {
    const lines = [msg(locale, "helpTitle")];
    if (groupRole) {
      lines.push(
        locale === "en-US"
          ? "Mention this bot to submit a request. /answer answers your active question."
          : "@当前机器人提交需求；/answer 回答自己发起请求中的问题。",
      );
      if (groupRole === "owner") {
        lines.push("/enable · /disable · /task · /stop · /approve · /deny · /reconnect");
        if (bot.allowedCommands.workspace !== false) lines.push("/history on|off");
      }
    }
    for (const command of BOT_MENU_COMMAND_ORDER) {
      if (
        groupRole &&
        (command === "bind" ||
          command === "reply" ||
          (groupRole === "member" && command !== "help" && command !== "status"))
      )
        continue;
      if (command === "help" || command === "bind") {
        lines.push(msg(locale, helpMessageByCommand[command]));
        continue;
      }
      if (bot.allowedCommands[command] === false) {
        continue;
      }
      lines.push(msg(locale, helpMessageByCommand[command]));
    }
    return lines.join("\n");
  }

  function historyGeneration(context: BotContextState): string {
    const groupKey = JSON.stringify([context.botId, context.group?.chatId]);
    return `${botHistoryEpoch.get(context.botId) ?? 0}:${groupHistoryEpoch.get(groupKey) ?? 0}:${context.group?.backgroundHistory?.revision ?? ""}`;
  }

  async function prepareGroupTopicHistory(
    bot: BotConfig,
    message: BotInboundMessage,
    context: BotContextState,
  ) {
    const messageId = message.actor.providerMessageId!;
    if (!context.group) return {};
    let topicContext: import("@zcode/shared").BotTopicHistoryBatch | undefined;
    let historyError: unknown;

    const generation = historyGeneration(context);
    // 在异步读历史之前固定 revision，不能把等待期间的新背景误当成本轮已读。
    const backgroundRevision = context.group.backgroundHistory?.revision;
    let historyDisabled = false;
    const inputThreadId = message.actor.threadId ?? context.group.threadId;
    const inputRootMessageId = message.actor.rootMessageId ?? context.group.rootMessageId;
    if (inputThreadId) {
      const parent = (await repo.readState()).bots[
        getBotConversationKey({
          botId: bot.id,
          chatType: "group",
          chatId: context.group.chatId,
        })
      ];
      historyDisabled = parent?.group?.historyEnabled === false;
      if (!historyDisabled && topicHistoryReady.get(getBotStateKey(context)) !== generation) {
        const accepted = Object.values(context.group.inputs ?? {}).filter(
          (input) => input.admission === "accepted" && input.source.threadId === inputThreadId,
        );
        const checkpoint = context.group.backgroundHistory
          ? context.group.backgroundHistory.checkpoint
          : accepted.at(-1)?.source.messageId;
        try {
          const reader = providers[bot.provider]?.readTopicHistory;
          if (!reader || !inputRootMessageId) throw new Error("Topic history reader unavailable");
          topicContext = await reader(bot, {
            chatId: context.group.chatId,
            threadId: inputThreadId,
            rootMessageId: inputRootMessageId,
            messageId,
            checkpoint,
          });
          const ingested = new Set(
            accepted.flatMap(
              (input) =>
                input.source.messages?.map((original) => original.messageId) ?? [
                  input.source.messageId,
                ],
            ),
          );
          topicContext.messages = topicContext.messages.filter(
            (item) => !ingested.has(item.id) && item.id !== message.referencedMessage?.messageId,
          );
        } catch (error) {
          botsLogger.warn(
            undefined,
            `topic history preparation failed bot=${bot.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
          // 读取失败必须阻止提交，不能用缺口附件替代必需历史后启动任务。
          topicContext = undefined;
          historyError = error || new Error("Topic history unavailable");
        }
      }
    }
    return {
      topicContext,
      historyError,
      historyDisabled,
      generation,
      backgroundRevision,
    };
  }

  async function submitGroupMessage(
    bot: BotConfig,
    message: BotInboundMessage,
    context: BotContextState,
    prepared: PreparedBotMessageContent,
    locale: Locale | undefined,
    history: Awaited<ReturnType<typeof prepareGroupTopicHistory>>,
    topicBatch?: PreparedTopicMessage[],
    isCurrent = () => true,
  ): Promise<BotOutboundMessage[]> {
    if (!context.group || !context.activeTaskId || !isFeishuBotProvider(bot.provider))
      throw new Error("Group context is missing");
    const service = await resolveZCodeTaskServiceForContext(context);
    if (!service.submitBotGroupInput)
      throw new Error("Runtime does not support group input admission");
    const messageId = message.actor.providerMessageId;
    if (!messageId) throw new Error("Group message ID is required");
    const commandId = botGroupCommandId(bot.id, context.group.chatId, messageId);
    const { topicContext } = history;
    const inputThreadId = message.actor.threadId ?? context.group.threadId;
    const inputRootMessageId = message.actor.rootMessageId ?? context.group.rootMessageId;
    // 历史/附件准备期间控制通道可以停用群；不能用准备前的授权继续提交。
    const admissionContext = (await repo.readState()).bots[getBotStateKey(context)];
    const admissionBot = findBot(await repo.readConfig(), bot.id);
    if (
      !admissionContext?.group?.enabled ||
      !admissionBot?.enabled ||
      admissionContext.group.ownerId !== admissionBot.providerUserId ||
      admissionContext.group.authorizationId !== context.group.authorizationId ||
      admissionContext.activeTaskId !== context.activeTaskId
    )
      throw new Error("Group authorization changed before input admission");
    let attachmentOffset = 0;
    const admittedAttachments: ZCodePromptAttachment[] = [];
    // 多个回调可能在首次接收前已各自准备根引用；提交时再按权威记录去重。
    let rootIncluded = Object.values(admissionContext.group.inputs ?? {}).some(
      (input) => input.admission === "accepted",
    );
    const messages = topicBatch?.map(({ message: original, prepared: material }) => {
      const quote = original.referencedMessage;
      const isRoot = !!inputRootMessageId && quote?.messageId === inputRootMessageId;
      const includeQuote = quote && !(isRoot && rootIncluded);
      const attachmentIndexes: number[] = [];
      let hasRootAttachment = false;
      material.zcodeAttachments.forEach((attachment, index) => {
        const resourceMessageId =
          original.attachments?.[index]?.providerMetadata?.resourceMessageId;
        const rootAttachment = !!inputRootMessageId && resourceMessageId === inputRootMessageId;
        hasRootAttachment ||= rootAttachment;
        // 根引用可能在上一轮接收前就已下载；提交时同时去重资源，不能只隐藏引用正文。
        if (rootAttachment && rootIncluded) return;
        attachmentIndexes.push(admittedAttachments.length);
        admittedAttachments.push(attachment);
      });
      attachmentOffset += material.zcodeAttachments.length;
      if ((isRoot && includeQuote) || hasRootAttachment) rootIncluded = true;
      return {
        messageId: original.actor.providerMessageId!,
        senderId: original.actor.providerUserId,
        mentionedBot: original.mentionedBot === true,
        contentParts: original.contentParts,
        senderName: original.actor.displayName ?? original.actor.providerUserId,
        text: original.text,
        ...(includeQuote ? { conversationQuotes: [quote] } : {}),
        attachmentIndexes,
      };
    });
    // 历史文本附件在各条原始附件之后追加，保留它且不归给后续消息。
    if (topicBatch) admittedAttachments.push(...prepared.zcodeAttachments.slice(attachmentOffset));
    const source = {
      authorizationId: context.group.authorizationId,
      botIdentity: { name: bot.name, ...(message.botOpenId ? { openId: message.botOpenId } : {}) },
      provider: bot.provider,
      botId: bot.id,
      chatId: context.group.chatId,
      threadId: inputThreadId,
      rootMessageId: inputRootMessageId,
      appId: bot.feishuAppId,
      contentParts: message.contentParts,
      senderId: message.actor.providerUserId,
      mentionedBot: message.mentionedBot === true,
      senderName: message.actor.displayName ?? message.actor.providerUserId,
      messageId,
      ...(messages ? { messages } : {}),
      ...(topicContext ? { topicContext } : {}),
    };
    const isFirstTaskInput = !Object.values(context.group.inputs ?? {}).some(
      (input) => input.taskId === context.activeTaskId,
    );
    context.group = {
      ...context.group,
      inputs: {
        ...context.group.inputs,
        [commandId]: { taskId: context.activeTaskId, source, admission: "pending" },
      },
    };
    await writeContext(context);
    await watchTaskStream(bot, message.actor, context, { ...bot, replyMode: "summary_changes" });
    // 原文已经寄存为文本附件；不能再通过来源元信息把整份历史塞进 command frame。
    const { topicContext: archive, ...runtimeSource } = source;
    if (!isCurrent()) return [];
    const ack = await service.submitBotGroupInput({
      taskId: context.activeTaskId,
      commandId,
      content: prepared.content,
      ...(topicBatch
        ? {
            conversationQuotes: messages?.flatMap((entry) => entry.conversationQuotes ?? []) ?? [],
          }
        : message.referencedMessage
          ? { conversationQuotes: [message.referencedMessage] }
          : {}),
      attachments: topicBatch ? admittedAttachments : prepared.zcodeAttachments,
      source: {
        ...runtimeSource,
        ...(archive
          ? {
              topicHistory: {
                checkpoint: archive.checkpoint,
                hasGap: archive.hasGap,
                messageCount: archive.messages.length,
                resourceMessages: archive.messages
                  .filter((record) => record.attachments?.length)
                  .map((record) => ({ messageId: record.id, count: record.attachments!.length })),
              },
            }
          : {}),
      },
    });
    if (ack.status !== "accepted" && ack.status !== "duplicate") {
      context.group.inputs![commandId]!.admission = "rejected";
      await writeContext(context, false, context.activeTaskId);
      throw new Error(ack.message ?? ack.reasonCode ?? "Input rejected");
    }
    if (ack.result?.type !== "inputAccepted") throw new Error("Input admission outcome is unknown");
    adminAttention.clear(message.actor, bot.providerUserId);
    context.group.inputs![commandId]!.admission = "accepted";
    if (context.group.threadId) context.group.topicActive = true;
    await writeContext(context, false, context.activeTaskId);
    if (context.group.threadId && isCurrent() && history.generation) {
      topicHistoryReady.set(getBotStateKey(context), history.generation);
    }
    if (context.group.threadId && isCurrent()) {
      await serializeStateWrite(async () => {
        const state = await repo.readState();
        const current = state.bots[getBotStateKey(context)];
        if (current?.group && isCurrent()) {
          current.group.topicActive = true;
          // 只清除本轮已补读且没有被新背景替换的检查点；准备期间来的背景留给下一轮。
          if (
            history.topicContext &&
            history.backgroundRevision &&
            current.group.backgroundHistory?.revision === history.backgroundRevision
          ) {
            delete current.group.backgroundHistory;
            topicHistoryReady.set(getBotStateKey(current), historyGeneration(current));
          }
        }
        for (const candidate of Object.values(state.bots)) {
          if (candidate.botId === bot.id && candidate.group?.chatId === context.group!.chatId) {
            delete candidate.group.topicAliases?.[context.group!.threadId!];
          }
        }
        await repo.writeState(state);
      });
    }
    if (isFirstTaskInput && service.renameTask) {
      await service
        .renameTask({
          taskId: context.activeTaskId,
          workspacePath: context.workspacePath,
          workspaceIdentity: context.workspaceIdentity,
          title: `${bot.provider === "lark" ? "Lark" : "飞书"} · ${context.group.name}${context.group.threadId ? ` · ${context.group.topicTitle || context.group.threadId}` : ""}`,
        })
        .catch((error: unknown) => {
          // 输入已经被 CLI 接受，标题写入失败不能释放去重并重新执行输入。
          botsLogger.warn(
            undefined,
            `persist group task title failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    }
    await updateGroupInputReaction(
      bot,
      context,
      messageId,
      ack.result.delivery === "queue" ? "waiting" : "working",
    );
    const replies =
      ack.result.delivery === "queue" && !context.group?.threadId
        ? [
            createOutbound(
              message.actor,
              locale === "en-US" ? "Waiting to run" : "等待执行",
              {
                id: `queue-${commandId}`,
                title: locale === "en-US" ? "Queued" : "已排队",
                action: "queue.cancel",
                showCancel: false,
                options: [
                  {
                    id: `/queue-cancel ${commandId}`,
                    label: locale === "en-US" ? "Cancel" : "取消",
                  },
                ],
              },
              { locale, groupSourceCommandId: commandId, groupTaskId: context.activeTaskId },
            ),
          ]
        : [];
    return replies;
  }

  async function updateGroupInputReaction(
    bot: BotConfig,
    context: BotContextState,
    messageId: string | undefined,
    state: BotGroupInputStatus,
  ): Promise<void> {
    if (!messageId) return;
    try {
      const entry = Object.entries(context.group?.inputs ?? {}).find(
        ([, input]) => input.source.messageId === messageId,
      );
      const inputId = entry?.[0];
      if (inputId && context.group) {
        await queueCards
          .update(
            JSON.stringify([
              bot.id,
              context.group.chatId,
              context.activeTaskId,
              context.group.authorizationId,
              inputId,
              context.group.threadId,
            ]),
            state,
          )
          .catch((error) => {
            botsLogger.warn(
              undefined,
              `queue card update failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
      }
      // CLI 终态可能早于 admission ACK；表情必须采用保存后的单向状态。
      if (inputId) {
        const latest = (await repo.readState()).bots[getBotStateKey(context)];
        state = latest?.group?.inputs?.[inputId]?.progress?.status ?? state;
      }
      // 合批只合并执行，表情仍属于每条原消息，不能只更新最后一条。
      const messageIds = entry?.[1].source.messages?.map((message) => message.messageId) ?? [
        messageId,
      ];
      await Promise.all(
        messageIds.map((originalId) =>
          providers[bot.provider]?.updateInputReaction?.(
            bot,
            originalId,
            state === "stopped" || state === "discarded" ? "cancelled" : state,
          ),
        ),
      );
    } catch (error) {
      // 表情只是状态投影；平台失败不能把已接受输入变成失败或触发重跑。
      botsLogger.warn(
        undefined,
        `group input reaction update failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function cancelGroupInput(
    message: BotInboundMessage,
    sourceCommandId: string,
  ): Promise<BotOutboundMessage[]> {
    const auth = await withAuthorizedContext(message, "message");
    if (!auth.ok) return auth.reply;
    const group = auth.context.group;
    const input = group?.inputs?.[sourceCommandId];
    // 旧话题排队卡可能仍留在飞书，不能让它操作新话题的停止续接输入。
    if (group?.threadId) {
      return [
        {
          ...createOutbound(
            message.actor,
            auth.locale === "en-US"
              ? "This topic queue card has expired. Use /stop to stop the topic."
              : "该话题排队卡已失效，请使用 /stop 停止话题。",
          ),
          callbackToastOnly: true,
        },
      ];
    }
    if (
      !group ||
      !input ||
      input.taskId !== auth.context.activeTaskId ||
      (message.actor.providerUserId !== group.ownerId &&
        input.source.senderId !== message.actor.providerUserId)
    ) {
      return [
        {
          ...(group && input && input.taskId === auth.context.activeTaskId
            ? administratorReply(
                message.actor,
                auth.bot,
                `queue-cancel:${sourceCommandId}`,
                createOutbound(message.actor, msg(auth.locale, "groupOwnerOnly")),
              )
            : createOutbound(message.actor, msg(auth.locale, "groupOwnerOnly"))),
          callbackToastOnly: true,
        },
      ];
    }
    const taskService = await resolveZCodeTaskServiceForContext(auth.context);
    if (!taskService.cancelBotGroupInput) throw new Error("Runtime cannot cancel queued input");
    const ack = await taskService.cancelBotGroupInput({
      taskId: input.taskId,
      commandId: `cancel-${sourceCommandId}-${message.actor.providerMessageId}`,
      sourceCommandId,
      actorId: message.actor.providerUserId,
      ownerId: group.ownerId,
      botId: auth.bot.id,
      chatId: group.chatId,
    });
    const accepted = ack.status === "accepted" || ack.status === "duplicate";
    if (accepted)
      await updateGroupInputReaction(auth.bot, auth.context, input.source.messageId, "cancelled");
    return [
      createOutbound(
        message.actor,
        accepted
          ? auth.locale === "en-US"
            ? "Queued input cancelled."
            : "已取消该排队输入。"
          : auth.locale === "en-US"
            ? "Input changed or started; cancellation was not applied."
            : "输入已变化或开始执行，未取消。",
      ),
    ];
  }

  function sendPromptInBackground(
    bot: BotConfig,
    actor: BotActor,
    context: BotContextState,
    taskId: string,
    traceId: string,
    content: string,
    attachments: ZCodePromptAttachment[],
    botDeliveryTarget?: ZCodeAutomationBotDeliveryTarget,
    modelSelection?: ModelSelection,
    modelSelectionBasis?: ModelSelection,
  ): void {
    privateImTraces.add(JSON.stringify([taskStreamKey(context, actor), traceId]));
    streamSubscriptions.get(taskStreamKey(context, actor))?.imInput();
    // 私聊常驻订阅不再随每轮建立；必须在本次输入派发前接管 Typing，
    // 否则回调收尾会将它当作短命令表情立即删除。终态/交互等待沿用原清理路径。
    if (!context.group) startTyping(bot, actor, taskId);
    // Bugfix: Telegram polling 是单循环顺序处理 update。如果这里 await session/prompt，
    // 权限按钮 callback 会一直排队到整轮任务结束，导致用户点 inline keyboard 没反应。
    // 因此 prompt 必须后台跑，polling loop 才能继续接收 /permission 回调。
    void resolveZCodeTaskServiceForContext(context)
      .then((zcodeTaskService) =>
        zcodeTaskService.sendPrompt({
          taskId,
          traceId,
          content,
          attachments: attachments.length > 0 ? attachments : undefined,
          botDeliveryTarget,
          // 与群聊入口（zcodeTaskServiceAdapter 的 bot 群输入）同一契约：formatBotInputClientId。
          // 所有渠道（含 Telegram / Discord / 企业微信这类没有回推目标的）都带，CLI 据此识别 Bot 输入，
          // 不对 IM 用户声明桌面才有的设计模式（Host 的 inputOrigin 对 Bot 也是 desktop）。
          clientId: formatBotInputClientId({
            botId: actor.botId,
            chatId: actor.chatId?.trim() || actor.providerUserId,
            senderId: actor.providerUserId,
          }),
          modelSelection,
          modelSelectionBasis,
        }),
      )
      .then(async (ack) => {
        if (ack?.status !== "duplicate") return;
        await settleDuplicatePrivateInput(context, actor, taskId, traceId).catch((error) => {
          // 收口失败只影响 Typing/运行标记的展示，不能当作输入失败回复给 IM 用户。
          botsLogger.warn(
            traceId,
            `settle duplicate private input failed task=${taskId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      })
      .catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        const locale = await readMessageLocale();
        const userFacingMessage = formatUserFacingBotError(error, locale);
        runningTasks.delete(taskId);
        stopTyping(taskId);
        await broadcastTaskListChange(context, taskId, "error", {
          error: message,
        });
        await sendOutbound(
          bot,
          createOutbound(
            actor,
            isSessionExpiredError(error)
              ? userFacingMessage
              : msg(locale, "taskFailed", { message: userFacingMessage }),
          ),
        ).catch(() => undefined);
      });
  }

  async function settleDuplicatePrivateInput(
    context: BotContextState,
    actor: BotActor,
    taskId: string,
    traceId: string,
  ): Promise<void> {
    // Bugfix：固定 commandId 后，重投得到 duplicate ACK，CLI 不开新一轮，也不会有终态事件。
    // 发送前建立的运行标记、IM trace、Typing 和桌面 streaming 广播原本靠终态收口，
    // 重投后会一直残留（Telegram/微信每 4 秒调一次 typing 接口）。这里按 CLI 快照收口：
    // 与切换任务的空闲判定共用 getContextTaskBlockReason；任务仍在运行或排队时不动，
    // 由那一轮的终态清理，避免误停仍有效的反馈。
    if (await getContextTaskBlockReason({ ...context, activeTaskId: taskId })) return;
    privateImTraces.delete(JSON.stringify([taskStreamKey(context, actor), traceId]));
    runningTasks.delete(taskId);
    stopTyping(taskId);
    await broadcastTaskListChange(context, taskId, "completed");
  }

  async function stopTopicRun(
    context: BotContextState,
    executionId: string,
    sourceCommandId?: string,
  ): Promise<void> {
    const taskId = context.activeTaskId;
    if (!taskId) return;
    const key = JSON.stringify([
      getWorkspaceKey(context.workspacePath, context.workspaceIdentity),
      taskId,
      executionId,
    ]);
    const existing = topicStops.get(key);
    if (existing) return existing;
    const stopping = resolveZCodeTaskServiceForContext(context).then(async (service) => {
      if (!service.stopBotTopicExecution) throw new Error("Topic stop is unavailable");
      await service.stopBotTopicExecution({
        taskId,
        workspacePath: context.workspacePath,
        workspaceIdentity: context.workspaceIdentity,
        executionId,
      });
      if (sourceCommandId)
        await serializeStateWrite(async () => {
          const state = await repo.readState();
          const latest = state.bots[getBotStateKey(context)];
          const input = latest?.group?.inputs?.[sourceCommandId];
          if (
            !input ||
            input.taskId !== taskId ||
            input.progress?.status === "done" ||
            input.progress?.status === "failed"
          )
            return;
          input.progress = {
            ...input.progress,
            status: "stopped",
            interruptionReason: "newMessage",
          };
          await repo.writeState(state);
        });
      if (sourceCommandId)
        await deps.broadcastService?.send({ channel: "bots:group-state", payload: {} });
    });
    topicStops.set(key, stopping);
    const release = () => {
      if (topicStops.get(key) === stopping) topicStops.delete(key);
    };
    void stopping.then(release, release);
    return stopping;
  }

  async function cancelGroupTopicInputs(actor: BotActor): Promise<void> {
    // 群级撤销必须覆盖所有话题，包括尚未创建任务、仍在准备历史的输入。
    const states = (await repo.readState()).bots;
    const keys = new Set([...Object.keys(states), ...topicContinuations.keys()]);
    await Promise.all(
      [...keys].flatMap((key) => {
        if (!key.startsWith("[")) return [];
        const [botId, chatId, threadId] = JSON.parse(key) as string[];
        return botId === actor.botId && chatId === actor.chatId && threadId
          ? [cancelTopicInputs({ ...actor, threadId, conversationThreadId: undefined })]
          : [];
      }),
    );
  }

  async function cancelTopicInputs(actor: BotActor): Promise<void> {
    const key = getBotConversationKey(actor);
    topicPreparation.clear(key);
    topicGenerations.set(key, (topicGenerations.get(key) ?? 0) + 1);
    topicHistoryReady.delete(key);
    topicContinuations.get(key)?.cancel();
    const cancelledIds = [...(topicReplies.get(key)?.keys() ?? [])];
    for (const resolve of topicReplies.get(key)?.values() ?? []) resolve([]);
    topicReplies.get(key)?.clear();
    const context = (await repo.readState()).bots[key];
    const bot = findBot(await repo.readConfig(), actor.botId);
    if (context && bot) {
      await Promise.all(
        cancelledIds.map((id) => updateGroupInputReaction(bot, context, id, "cancelled")),
      );
    }
    if (context?.activeTaskId) {
      const service = await resolveZCodeTaskServiceForContext(context);
      if (!service.invalidateBotTopicInputs)
        throw new Error("Topic preparation cancellation is unavailable");
      await service.invalidateBotTopicInputs({
        taskId: context.activeTaskId,
        workspacePath: context.workspacePath,
        workspaceIdentity: context.workspaceIdentity,
      });
    }
    await publishTopicPreparation();
  }

  async function admitAutoReplyTurn(message: BotInboundMessage): Promise<boolean> {
    if (
      message.actor.chatType !== "group" ||
      message.groupCardAction ||
      message.elicitationResponse
    )
      return true;
    const id = message.actor.providerMessageId;
    if (!id) return message.senderType !== "app";
    let admitted = false;
    // 新消息 ID 去重不足以阻断两台机器人互答。必须在停止/准备前原子占用次数，
    // 与去重一起持久化；准备失败仍占一次，避免重投、并发和重启绕过上限。
    await serializeStateWrite(async () => {
      const state = await repo.readState();
      const context = state.bots[getBotConversationKey(message.actor)];
      const group = context?.group;
      if (!group?.enabled) {
        admitted = message.senderType !== "app";
        return;
      }
      const bot = findBot(await repo.readConfig(), message.botId);
      if (!bot?.enabled || bot.providerUserId !== group.ownerId) return;
      if (
        !group.autoReplyGuard &&
        message.senderType !== "app" &&
        parseBotCommand(message.commandText ?? message.text).type !== "message"
      ) {
        admitted = true;
        return;
      }
      const guard = group.autoReplyGuard ?? { consecutive: 0, messageIds: [] };
      if (
        guard.messageIds.includes(id) ||
        Object.values(group.inputs ?? {}).some(
          (input) =>
            input.source.messageId === id ||
            input.source.messages?.some((original) => original.messageId === id),
        )
      ) {
        // 真人重试仍走原有准备/命令幂等流程，但不能重复恢复机器人额度。
        admitted = message.senderType !== "app";
        return;
      }
      if (
        message.senderType === "app" &&
        (guard.consecutive >= 5 ||
          (message.actor.threadId ? group.topicActive !== true : message.mentionedBot !== true))
      )
        return;
      group.autoReplyGuard = {
        consecutive: message.senderType === "app" ? guard.consecutive + 1 : 0,
        messageIds: [...guard.messageIds, id],
      };
      await repo.writeState(state);
      admitted = true;
    });
    return admitted;
  }

  async function receiveTopicMessage(message: BotInboundMessage): Promise<BotOutboundMessage[]> {
    const key = getBotConversationKey(message.actor);
    const id = message.actor.providerMessageId;
    if (!id) throw new Error("Topic message identity is missing");
    // 去重必须早于停止副作用；重投的已接收事件不能打断正在运行的新轮。
    const stored = (await repo.readState()).bots[key];
    if (
      Object.values(stored?.group?.inputs ?? {}).some(
        (input) =>
          input.source.messageId === id ||
          input.source.messages?.some((original) => original.messageId === id),
      )
    )
      return [];

    let replies = topicReplies.get(key);
    if (!replies) {
      replies = new Map();
      topicReplies.set(key, replies);
    }
    // 持久化接收去重在 handleMessage；这里只合并同时到达的同一事件。
    if (replies.has(id)) return [];
    const pendingReplies = replies;
    const result = new Promise<BotOutboundMessage[]>((resolve) => pendingReplies.set(id, resolve));
    let continuation = topicContinuations.get(key);
    if (!continuation) {
      const continuationGeneration = topicGenerations.get(key) ?? 0;
      const current = async () => (await repo.readState()).bots[key];
      let observedSourceCommandId: string | undefined;
      continuation = createTopicContinuation<PreparedTopicMessage>({
        readRunningRun: async () => {
          const context = await current();
          if (!context?.activeTaskId) return undefined;
          const service = await resolveZCodeTaskServiceForContext(context);
          if (!service.readBotTopicExecution)
            throw new Error("Topic runtime control is unavailable");
          const execution = await service.readBotTopicExecution({
            taskId: context.activeTaskId,
            workspacePath: context.workspacePath,
            workspaceIdentity: context.workspaceIdentity,
          });
          observedSourceCommandId = execution?.sourceCommandId;
          return execution?.executionId;
        },
        stopAndWait: async (executionId) => {
          const context = await current();
          if (!context?.activeTaskId) throw new Error("Topic task disappeared during stop");
          topicPreparation.setWaitingStop(key, true);
          await publishTopicPreparation();
          try {
            await stopTopicRun(context, executionId, observedSourceCommandId);
          } finally {
            if (continuationGeneration === (topicGenerations.get(key) ?? 0)) {
              topicPreparation.setWaitingStop(key, false);
              await publishTopicPreparation();
            }
          }
        },
        submit: async (batch) => {
          topicPreparation.update(
            key,
            batch.map((entry) => entry.message.actor.providerMessageId!),
            "preparing",
          );
          await publishTopicPreparation();
          const last = batch.at(-1)!;
          const combined = {
            ...last.message,
            text:
              batch.length === 1
                ? last.message.text
                : batch
                    .map(
                      ({ message: original }) =>
                        `${original.actor.displayName || original.actor.providerUserId}: ${original.text}`,
                    )
                    .join("\n\n"),
          };
          const isCurrent = () =>
            batch.every((entry) => entry.generation === (topicGenerations.get(key) ?? 0));
          const outgoing = await handleMessage(combined, batch, isCurrent);
          const context = await current();
          const accepted = Object.values(context?.group?.inputs ?? {}).some(
            (input) =>
              input.admission === "accepted" &&
              input.source.messageId === last.message.actor.providerMessageId,
          );
          if (isCurrent() && !accepted && context) {
            const bot = findBot(await repo.readConfig(), message.botId);
            if (bot)
              await Promise.all(
                batch.map((entry) =>
                  updateGroupInputReaction(
                    bot,
                    context,
                    entry.message.actor.providerMessageId,
                    "failed",
                  ),
                ),
              );
          }
          const ids = batch.map((entry) => entry.message.actor.providerMessageId!);
          if (isCurrent()) {
            if (accepted) topicPreparation.remove(key, ids);
            else
              topicPreparation.update(
                key,
                ids,
                "failed",
                outgoing.map((reply) => reply.text).join("\n"),
              );
            await publishTopicPreparation();
          }
          for (const entry of batch) {
            const messageId = entry.message.actor.providerMessageId!;
            pendingReplies.get(messageId)?.(entry === last ? outgoing : []);
            pendingReplies.delete(messageId);
          }
        },
        failed: async (ids, error) => {
          // 取消后的旧下载/停止异常不得修改新一代消息的状态或表情。
          if (continuationGeneration !== (topicGenerations.get(key) ?? 0)) return;
          topicPreparation.update(
            key,
            ids,
            "failed",
            error instanceof Error ? error.message : String(error),
          );
          await publishTopicPreparation();
          const context = await current();
          const bot = findBot(await repo.readConfig(), message.botId);
          if (context && bot)
            await Promise.all(
              ids.map((id) => updateGroupInputReaction(bot, context, id, "failed")),
            );
          for (const messageId of ids) {
            pendingReplies.get(messageId)?.(
              error instanceof BotReplyError
                ? error.replies
                : [
                    administratorErrorReply(
                      message.actor,
                      bot,
                      error,
                      createOutbound(
                        message.actor,
                        error instanceof Error ? error.message : String(error),
                      ),
                    ),
                  ],
            );
            pendingReplies.delete(messageId);
          }
        },
      });
      topicContinuations.set(key, continuation);
    }
    const generation = topicGenerations.get(key) ?? 0;
    const received = continuation.receive(id, async () => {
      const auth = await withAuthorizedContext(message, "message");
      if (!auth.ok) throw new BotReplyError(auth.reply);
      if (generation !== (topicGenerations.get(key) ?? 0)) throw new Error("Topic input cancelled");
      topicPreparation.add(key, message);
      await publishTopicPreparation();
      await updateGroupInputReaction(auth.bot, auth.context, id, "waiting");
      return {
        message,
        generation,
        prepared: await prepareBotMessageContent(auth.bot, message, auth.locale),
      };
    });
    if (!received) {
      pendingReplies.get(id)?.([]);
      pendingReplies.delete(id);
    }
    const active = continuation;
    void active.settled().finally(() => {
      if (pendingReplies.size === 0 && topicContinuations.get(key) === active) {
        topicContinuations.delete(key);
        topicReplies.delete(key);
      }
    });
    return result;
  }

  async function handleMessage(
    message: BotInboundMessage,
    topicBatch?: PreparedTopicMessage[],
    isCurrent = () => true,
  ): Promise<BotOutboundMessage[]> {
    const auth = await withAuthorizedContext(message, "message");
    if (!auth.ok) {
      return auth.reply;
    }
    const priorInput =
      auth.context.group && message.actor.providerMessageId
        ? Object.values(auth.context.group.inputs ?? {}).find(
            (input) =>
              input.source.messageId === message.actor.providerMessageId ||
              input.source.messages?.some(
                (item) => item.messageId === message.actor.providerMessageId,
              ),
          )
        : undefined;
    if (priorInput && priorInput.taskId !== auth.context.activeTaskId) {
      return [
        createOutbound(
          message.actor,
          auth.locale === "en-US"
            ? "This message belongs to an earlier task and will not be executed again."
            : "这条消息已关联到此前任务，不会在新任务中重复执行。",
        ),
      ];
    }
    // CLI 重启后幂等窗口可能已变化；持久化接收记录不能只依赖内存事件去重。
    if (priorInput) {
      if (priorInput.admission === "accepted") return [];
      return [
        createOutbound(
          message.actor,
          auth.locale === "en-US"
            ? "This message already has an admission record. Check the task before submitting another request."
            : "这条消息已有接收记录，请先在任务中核对执行状态，不会自动重复提交。",
        ),
      ];
    }
    const history = auth.context.group
      ? await prepareGroupTopicHistory(auth.bot, message, auth.context)
      : {};
    if (history.topicContext && topicBatch) {
      const ids = new Set(topicBatch.map((entry) => entry.message.actor.providerMessageId));
      history.topicContext.messages = history.topicContext.messages.filter(
        (entry) => !ids.has(entry.id),
      );
    }
    if (history.historyDisabled || history.historyError) {
      const en = auth.locale === "en-US";
      const permissionDenied = history.historyError instanceof TopicHistoryPermissionError;
      const platformUrl =
        auth.bot.provider === "lark"
          ? "https://open.larksuite.com/app"
          : "https://open.feishu.cn/app";
      const text = history.historyDisabled
        ? en
          ? "Topic history is disabled. Ask the bound user to enable /history on before using topics."
          : "话题历史已关闭，暂时无法处理话题消息。请绑定用户发送 /history on 后重新 @。"
        : permissionDenied
          ? en
            ? `Topic history permission is missing. No task was submitted. Ask the app administrator to open ${platformUrl}, select this bot app, enable the required application-identity message permissions (including im:message.group_msg), and publish the change. Then mention the bot again.`
            : `机器人缺少话题历史读取权限，未提交任务。请应用管理员打开 ${platformUrl}，选择当前机器人应用，在权限管理中开通应用身份的消息读取权限（包括 im:message.group_msg，获取群组中所有消息），并发布生效后重新 @。无需安装或授权 lark-cli。`
          : en
            ? "Topic history could not be read. No task was submitted. Please retry by mentioning the bot again later."
            : "暂时无法读取话题历史，未提交任务。请稍后重新 @ 重试。";
      return [
        history.historyDisabled
          ? administratorReply(
              message.actor,
              auth.bot,
              "history",
              createOutbound(message.actor, text),
            )
          : createOutbound(message.actor, text),
      ];
    }
    adminAttention.clear(message.actor, auth.bot.providerUserId, "history");
    // commandText 属于单条消息；尾部纯 @ 不能抹掉停止期间批次里其他成员的有效需求。
    const hasRequest = (topicBatch?.map((entry) => entry.message) ?? [message]).some((original) =>
      Boolean(
        (original.commandText ?? original.text).trim() ||
        original.attachments?.length ||
        original.referencedMessage,
      ),
    );
    if (auth.context.group && !hasRequest) {
      const hasBackground = (history.topicContext?.messages.length ?? 0) > 0;
      if (!message.referencedMessage && !hasBackground) {
        return [
          createOutbound(
            message.actor,
            auth.locale === "en-US"
              ? "Please add a request, or reply to the message you want me to handle and mention me."
              : "请补充需求，或回复要处理的消息并 @我。",
          ),
        ];
      }
      // 仅 @ 的输入已有引用或历史附件；补写指令会把系统文案伪装成用户正文。
      // 保留原文中的 @，由标准引用／附件承载材料，不重新解析材料里的命令。
    }
    if (message.referencedMessage) {
      // 原先拼接消息 ID 会诱使模型再次查飞书；标准引用只携带真实原文，并复用 UI 展示。
      const quote = message.referencedMessage.text;
      if (quote.length > CONVERSATION_SELECTION_MAX_TEXT_LENGTH) {
        return [
          createOutbound(
            message.actor,
            auth.locale === "en-US"
              ? "The quoted text is too long. Please quote a shorter passage or attach it as a file."
              : "引用文字过长，请缩小引用范围或作为文件提交。",
          ),
        ];
      }
    }
    let deletedTaskId: string | undefined;
    if (auth.context.mode === "task" && auth.context.activeTaskId) {
      const taskService = await resolveZCodeTaskServiceForContext(auth.context);
      const deletedTaskIds = await taskService.listDeletedTaskIds({
        workspacePath: auth.context.workspacePath,
        workspaceIdentity: auth.context.workspaceIdentity,
      });
      if (deletedTaskIds.includes(auth.context.activeTaskId)) {
        // 桌面软删除只留下 tombstone，CLI 仍可恢复旧 session。
        // Bot 不能只凭 activeTaskId 续跑隐藏任务；先清旧交互，再复用当前草稿有效选择和 V4 首发。
        // 仅以删除记录为准，不能把列表过滤、归档或查询失败当成删除。
        deletedTaskId = auth.context.activeTaskId;
        auth.context = await writeDraftContext(auth.context);
      }
    }
    const elicitationReply = auth.context.group
      ? null
      : await handlePendingElicitationText(auth, message.actor, message.text);
    if (elicitationReply) {
      return elicitationReply;
    }
    if (
      !auth.context.group &&
      auth.context.mode === "task" &&
      auth.context.activeTaskId &&
      (await getContextTaskBlockReason(auth.context))
    ) {
      return [createOutbound(message.actor, msg(auth.locale, "taskRunning"))];
    }
    let preparedMessage: PreparedBotMessageContent;
    try {
      preparedMessage = topicBatch
        ? {
            content: message.text,
            zcodeAttachments: topicBatch.flatMap((entry) => entry.prepared.zcodeAttachments),
          }
        : await prepareBotMessageContent(auth.bot, message, auth.locale);
      const historyMaterial = history.topicContext;
      if (auth.context.group && historyMaterial) {
        const attachment = createTopicHistoryAttachment(
          historyMaterial,
          botGroupCommandId(
            auth.bot.id,
            auth.context.group.chatId,
            message.actor.providerMessageId!,
          ),
          auth.context.group.topicTitle || auth.context.group.name,
        );
        if (attachment) preparedMessage.zcodeAttachments.push(attachment);
      }
    } catch (error) {
      return [
        createOutbound(
          message.actor,
          msg(auth.locale, "attachmentRejected", {
            message: formatAttachmentRejectedReason(error, auth.locale),
          }),
        ),
      ];
    }
    if (!isCurrent()) return [];
    if (auth.context.mode === "draft" || !auth.context.activeTaskId) {
      const draftOptions =
        auth.context.draftOptions ?? (await buildInitializedDraftOptions(auth.context));
      // 原因：直接提交旧账号身份会绕过统一解析。只在首次创建前解析原意图；
      // 后续创建、配置和首发固定这份结果；绑定后以 Session 原选择解析下一次新输入。
      const selectionView = await readModelSelectionView(auth.context, draftOptions.modelSelection);
      const submissionModelSelection = draftOptions.modelSelection
        ? selectionView?.effectiveSelection
        : selectionView?.preferredSelection;
      if (
        !submissionModelSelection ||
        (draftOptions.modelSelection && selectionView?.selectionIssue)
      ) {
        throw new BotAdminRequiredError("model", "Bot 无法从目标 Host 解析 Submission 模型");
      }
      const submissionDraftOptions: BotDraftOptions = {
        ...draftOptions,
        modelSelection: {
          providerId: submissionModelSelection.providerId,
          modelId: submissionModelSelection.modelId,
          ...(submissionModelSelection.options
            ? { options: { ...submissionModelSelection.options } }
            : {}),
        },
      };
      const zcodeTaskService = await resolveZCodeTaskServiceForContext(auth.context);
      const task = await zcodeTaskService.createTask({
        workspacePath: auth.context.workspacePath,
        workspaceIdentity: auth.context.workspaceIdentity,
        projectId: auth.context.projectId ?? null,
        additionalDirectories: auth.context.additionalDirectories ?? [],
        provider: draftOptions.provider,
        modelSelection: submissionDraftOptions.modelSelection,
        // 修复原因：Bot 旧 createTask 走 legacy session/create，却紧接着用 v4 sendText，
        // 内存标志与 v4 draft 持久化边界不一致，session_input 会触发 FK。改为先创建
        // v4 draft，再沿既有能力校验应用配置，最后通过 v4 sendText 首发。
        v4Create: true,
        ...(auth.context.group ? { permissionScope: "session" as const } : {}),
      });
      const taskTitle = auth.context.group
        ? [
            auth.bot.provider === "lark" ? "Lark" : "飞书",
            auth.context.group.name,
            ...(auth.context.group.threadId
              ? [auth.context.group.topicTitle || auth.context.group.threadId]
              : []),
          ].join(" · ")
        : deriveTaskTitle(preparedMessage.content, preparedMessage.zcodeAttachments);
      const broadcastTask = taskTitle ? { ...task, title: taskTitle } : task;
      const traceId = createInputTraceId(
        message,
        task.taskId,
        preparedMessage.zcodeAttachments.length > 0,
      );
      try {
        await applyDraftConfigOptions(
          { ...auth.context, draftOptions: submissionDraftOptions },
          task.taskId,
          traceId,
        );
      } catch (error) {
        // Bugfix: 初始配置失败时旧流程已把 context 切到 task，留下无法继续的空任务。
        // 在持久化 Bot task 状态前完成配置，并删除临时 task，让用户修正配置后可以直接重试。
        await zcodeTaskService
          .deleteTask({
            taskId: task.taskId,
            workspacePath: auth.context.workspacePath,
            workspaceIdentity: auth.context.workspaceIdentity,
          })
          .catch(() => undefined);
        throw error;
      }
      const context = {
        ...auth.context,
        mode: "task" as const,
        activeTaskId: task.taskId,
        draftOptions: undefined,
      };
      await writeContext(context);
      // Bugfix: Bot 首发不经过 UI 本地 deriveTaskTitle/optimistic cache。
      // 如果 created 广播继续携带 createTask 的空标题，侧栏会一直显示 New task，直到整表刷新。
      await broadcastTaskListChange(context, task.taskId, "created", {
        task: broadcastTask,
      });
      if (deletedTaskId) {
        botsLogger.info(
          undefined,
          `replaced deleted Bot task bot=${auth.bot.id} oldTask=${deletedTaskId} newTask=${task.taskId} workspace=${getWorkspaceKey(context.workspacePath, context.workspaceIdentity)}`,
        );
        // 切换已经持久化；通知失败不能让 callback 释放去重记录并重跑原消息。
        await sendOutbound(
          auth.bot,
          createOutbound(message.actor, msg(auth.locale, "deletedTaskReplaced")),
        ).catch((error: unknown) => {
          botsLogger.warn(
            undefined,
            `deleted task replacement notice failed bot=${auth.bot.id} task=${task.taskId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
      if (context.group)
        return submitGroupMessage(
          auth.bot,
          message,
          context,
          preparedMessage,
          auth.locale,
          history,
          topicBatch,
          isCurrent,
        );
      runningTasks.add(task.taskId);
      await watchTaskStream(auth.bot, message.actor, context, auth.user);
      await broadcastTaskListChange(context, task.taskId, "prompt_sent", {
        task: broadcastTask,
        prompt: {
          content: preparedMessage.content,
          attachments:
            preparedMessage.zcodeAttachments.length > 0
              ? preparedMessage.zcodeAttachments
              : undefined,
          messageId: `bot-${traceId}`,
          sentAt: Date.now(),
        },
      });
      sendPromptInBackground(
        auth.bot,
        message.actor,
        context,
        task.taskId,
        traceId,
        preparedMessage.content,
        preparedMessage.zcodeAttachments,
        resolveAutomationBotDeliveryTarget(message.actor),
        submissionDraftOptions.modelSelection,
      );
      return [];
    }
    if (auth.context.group)
      return submitGroupMessage(
        auth.bot,
        message,
        auth.context,
        preparedMessage,
        auth.locale,
        history,
        topicBatch,
        isCurrent,
      );
    const zcodeTaskService = await resolveZCodeTaskServiceForContext(auth.context);
    await zcodeTaskService.resumeTask({
      taskId: auth.context.activeTaskId,
      workspacePath: auth.context.workspacePath,
      workspaceIdentity: auth.context.workspaceIdentity,
    });
    // Bot 只是同一 Session 的输入端。菜单可能过滤无效值，不能拿它反推原选择，
    // 更不能重新套用 Bot 创建默认值。解析只确定本次输入，不在此改写 Session。
    const originalSelection = await zcodeTaskService.getTaskModelSelection({
      taskId: auth.context.activeTaskId,
    });
    const selectionView = originalSelection
      ? await readModelSelectionView(auth.context, originalSelection)
      : null;
    const effectiveSelection = selectionView?.effectiveSelection;
    if (!effectiveSelection || selectionView?.selectionIssue) {
      throw new Error(msg(auth.locale, "sessionModelUnavailable"));
    }
    await broadcastTaskListChange(auth.context, auth.context.activeTaskId, "resumed");
    runningTasks.add(auth.context.activeTaskId);
    await watchTaskStream(auth.bot, message.actor, auth.context, auth.user);
    const traceId = createInputTraceId(
      message,
      auth.context.activeTaskId,
      preparedMessage.zcodeAttachments.length > 0,
    );
    await broadcastTaskListChange(auth.context, auth.context.activeTaskId, "prompt_sent", {
      prompt: {
        content: preparedMessage.content,
        attachments:
          preparedMessage.zcodeAttachments.length > 0
            ? preparedMessage.zcodeAttachments
            : undefined,
        messageId: `bot-${traceId}`,
        sentAt: Date.now(),
      },
    });
    sendPromptInBackground(
      auth.bot,
      message.actor,
      auth.context,
      auth.context.activeTaskId,
      traceId,
      preparedMessage.content,
      preparedMessage.zcodeAttachments,
      resolveAutomationBotDeliveryTarget(message.actor),
      effectiveSelection,
      originalSelection ?? undefined,
    );
    return [];
  }

  async function handleTaskList(message: BotInboundMessage): Promise<BotOutboundMessage[]> {
    const auth = await withAuthorizedContext(message, "task");
    if (!auth.ok) {
      return auth.reply;
    }
    if (message.actor.threadId) return createStatusReply(message.actor, auth.context, auth.locale);
    const blockReason = await getContextTaskBlockReason(auth.context);
    if (blockReason) {
      // Bugfix: 运行中展示 /task 列表会让用户继续点选其它 task，
      // 即使后续切换被拒绝，也会留下误导性的 pending selection。
      return [createOutbound(message.actor, msg(auth.locale, blockReason))];
    }
    const taskEntries = (await listContextTaskSelectionEntries(auth.context, auth.user)).slice(
      0,
      10,
    );
    const tasks = taskEntries.map((entry) => entry.task);
    const activeTask = auth.context.activeTaskId
      ? tasks.find((task) => task.taskId === auth.context.activeTaskId)
      : null;
    const selection: SelectionPrompt = {
      id: `task-${Date.now()}`,
      title: msg(auth.locale, "taskSelectTitle", {
        task: activeTask ? `${activeTask.title} (${activeTask.taskId})` : "draft",
      }),
      currentId: auth.context.activeTaskId ?? undefined,
      action: "task.set",
      options: taskEntries.map((entry) => ({
        id: entry.task.taskId,
        label: entry.task.title,
        description: taskStatus(entry.task),
      })),
    };
    if (taskEntries.length > 0) {
      // Bugfix: 远端 task 展示时必须把 workspaceIdentity 一起缓存。
      // 否则点击 /task 的序号后只剩 taskId，后续二次查询会退回 path-only 语义并提示 Task not found。
      pendingTaskSelectionsByContext.set(
        getActorContextKey(message.actor),
        new Map(taskEntries.map((entry) => [entry.task.taskId, entry])),
      );
    } else {
      pendingTaskSelectionsByContext.delete(getActorContextKey(message.actor));
    }
    return tasks.length > 0
      ? createSelectionReply(message.actor, selection, auth.locale)
      : [createOutbound(message.actor, msg(auth.locale, "noHistoryTasks"))];
  }

  async function resolveTaskSelectionEntry(
    message: BotInboundMessage,
    context: BotContextState,
    user: BotConfig,
    value: string,
  ): Promise<BotTaskSelectionEntry | null> {
    const entries = await listContextTaskSelectionEntries(context, user);
    // 旧菜单只解析 taskId，实际归属必须重读；snapshot 不得绕过项目与固定 cwd 边界。
    const pending = resolvePendingTaskSelectionEntry(message.actor, value);
    return (
      resolveOptionByValue(
        entries.map((entry) => ({ id: entry.task.taskId, label: entry.task.title, entry })),
        pending?.task.taskId ?? value,
      )?.entry ?? null
    );
  }

  async function getContextTaskBlockReason(
    context: BotContextState,
  ): Promise<
    "taskRunning" | "groupTaskQueued" | "groupTaskInteraction" | "groupTaskDisconnected" | null
  > {
    if (!context.activeTaskId) {
      return null;
    }
    if (context.group) {
      if (context.workspaceIdentity && !(await isRemoteWorkspaceConnected(context)))
        return "groupTaskDisconnected";
      const taskService = await resolveZCodeTaskServiceForContext(context);
      if (!taskService.getBotGroupTaskBlockReason)
        throw new Error("Runtime cannot verify group queue state");
      const reason = await taskService.getBotGroupTaskBlockReason({
        taskId: context.activeTaskId,
        workspacePath: context.workspacePath,
        workspaceIdentity: context.workspaceIdentity,
      });
      botsLogger.debug(
        undefined,
        `group task switch check task=${context.activeTaskId} reason=${reason ?? "idle"}`,
      );
      if (reason)
        return reason === "queued"
          ? "groupTaskQueued"
          : reason === "interaction"
            ? "groupTaskInteraction"
            : "taskRunning";
      // 停止或在 Desktop 处理审批后，Bot 卡片缓存可能仍残留；不能让缓存否决 CLI 空闲状态。
      if (context.pendingElicitation || context.pendingPermissionOptions?.length) {
        if (context.pendingElicitation)
          clearPendingElicitationSelection(context.pendingElicitation);
        context.pendingElicitation = undefined;
        context.pendingPermissionOptions = undefined;
        await writeContext(context, false, context.activeTaskId);
        botsLogger.info(
          undefined,
          `cleared stale group interaction cache task=${context.activeTaskId}`,
        );
      }
      return null;
    }
    if (!runningTasks.has(context.activeTaskId)) {
      return null;
    }
    if (context.workspaceIdentity && !(await isRemoteWorkspaceConnected(context))) {
      // Bugfix: /workspace 这类本地命令只是在切换上下文，不能为了确认旧任务状态而创建远端 runtime。
      // 断连时把内存 running 状态视为不可确认，交给显式 /reconnect 后再恢复查询。
      return null;
    }
    const zcodeTaskService = await resolveZCodeTaskServiceForContext(context);
    const activeTaskSnapshot = await zcodeTaskService
      .getTaskSnapshot({
        taskId: context.activeTaskId,
        workspacePath: context.workspacePath,
        workspaceIdentity: context.workspaceIdentity,
      })
      .catch(() => null);
    if (
      activeTaskSnapshot?.meta.status === "completed" ||
      activeTaskSnapshot?.meta.status === "error"
    ) {
      // Bugfix: Bots 进程内 runningTasks 可能因重启/流式终态事件丢失而和持久化状态不一致。
      // ZCode Agent 历史任务的 status 为空也可能只是旧数据，不代表 UI 仍在运行；只有本进程确实发起
      // 且尚未观察到终态的 task 才阻止 /task、/new 等上下文切换。
      runningTasks.delete(context.activeTaskId);
      stopTyping(context.activeTaskId);
      return null;
    }
    return "taskRunning";
  }

  function warnAutomationDeliveryOnce(params: {
    target: ZCodeAutomationBotDeliveryTarget;
    reason: string;
  }): void {
    const key = `${params.target.provider}:${params.target.botId}:${params.reason}`;
    const now = Date.now();
    const previousAt = automationDeliveryWarningAtByKey.get(key) ?? 0;
    if (now - previousAt < BOT_AUTOMATION_DELIVERY_WARNING_TTL_MS) return;
    automationDeliveryWarningAtByKey.set(key, now);
    botsLogger.warn(
      undefined,
      `automation Bot delivery skipped provider=${params.target.provider} bot=${params.target.botId} reason=${params.reason}`,
    );
  }

  async function watchAutomationRun(params: BotAutomationRunWatchParams): Promise<void> {
    const config = await repo.readConfig();
    const bot = findBot(config, params.target.botId);
    if (!bot) {
      warnAutomationDeliveryOnce({ target: params.target, reason: "bot_missing" });
      return;
    }
    if (!bot.enabled) {
      warnAutomationDeliveryOnce({ target: params.target, reason: "bot_disabled" });
      return;
    }
    if (bot.provider !== params.target.provider) {
      warnAutomationDeliveryOnce({ target: params.target, reason: "provider_mismatch" });
      return;
    }
    if (params.target.chatType === "private") await reconcilePrivateSynchronization(bot.id);
    let conversationThreadId: string | null | undefined;
    if (params.target.chatType === "group") {
      const states = (await repo.readState()).bots;
      const state =
        states[
          getBotConversationKey({
            botId: bot.id,
            chatType: "group",
            chatId: params.target.providerUserId,
            threadId: params.target.threadId,
          })
        ];
      if (!state?.group?.enabled || state.group.ownerId !== bot.providerUserId) {
        warnAutomationDeliveryOnce({ target: params.target, reason: "group_not_authorized" });
        return;
      }
      // 旧 alias 不能继续回退到默认任务；话题投递必须存在独立的授权会话。
      conversationThreadId = state.group.threadId ?? null;
    }
    const actor: BotActor = {
      provider: params.target.provider,
      botId: params.target.botId,
      providerUserId: params.target.providerUserId,
      chatType: params.target.chatType,
      threadId: params.target.threadId,
      conversationThreadId,
      rootMessageId: params.target.rootMessageId,
      ...(params.target.chatType === "group" ? { chatId: params.target.providerUserId } : {}),
    };
    const context: BotContextState = {
      botId: bot.id,
      workspacePath: params.workspacePath,
      ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
      mode: "task",
      activeTaskId: params.taskId,
      updatedAt: Date.now(),
    };
    // Automation 回推固定为终态摘要；不能复用用户当前 replyMode，否则 streaming/card
    // 会在后台任务执行过程中向原会话持续发送中间过程。
    await watchTaskStream(
      bot,
      actor,
      context,
      {
        ...bot,
        replyMode: "summary_changes",
      },
      params.runId ?? true,
    );
  }

  service = {
    async syncAppRuntimePreferences(preferences) {
      await deps.remoteWorkspaceService?.syncAppRuntimePreferences?.(preferences);
    },
    async getStatus() {
      const config = await repo.readConfig();
      const state = await repo.readState();
      return {
        botsCount: config.bots.length,
        enabledBotsCount: config.bots.filter((bot) => bot.enabled).length,
        contextsCount: Object.keys(state.bots).length,
        botRuntime: config.bots.map((bot) => {
          const runtime = runtimeByBotId.get(bot.id);
          return (
            runtime ?? {
              botId: bot.id,
              provider: bot.provider,
              status: bot.enabled ? "idle" : "disabled",
              message: bot.enabled ? "Bot is configured." : "Bot is disabled.",
              offset: state.bots[bot.id]?.telegramOffset,
            }
          );
        }),
      };
    },
    getConfig: () => repo.readConfig(),
    listWorkspaceRefs,
    getUserConfigOptions: listUserConfigOptions,
    beginFeishuRegistration(params) {
      return beginFeishuAppRegistration(params?.domain);
    },
    pollFeishuRegistration(params) {
      return pollFeishuAppRegistration(params);
    },
    beginWeixinRegistration() {
      return beginWeixinQrRegistration();
    },
    pollWeixinRegistration(params) {
      return pollWeixinQrRegistration(params);
    },
    async saveConfig(config) {
      const savedConfig = await writeBotConfig(normalizeConfigBots(config));
      telegramRuntime.scheduleRefresh(savedConfig);
      weixinRuntime.scheduleRefresh(savedConfig);
      feishuRuntime.scheduleRefresh(savedConfig);
      return savedConfig;
    },
    async listBots() {
      return (await repo.readConfig()).bots;
    },
    async saveBot(params: BotSaveBotParams) {
      const config = await repo.readConfig();
      let bot: BotConfig = {
        ...params.bot,
        id: params.bot.id.trim(),
        name: params.bot.name.trim(),
        allowedWorkspaces: normalizeAllowedWorkspaces(params.bot.allowedWorkspaces),
        allowedCommands: normalizeBotCommandPolicy(params.bot.allowedCommands),
        currentOptions: normalizeBotCurrentOptions(params.bot.currentOptions),
        replyMode: normalizeBotReplyGranularity(params.bot.provider, params.bot.replyMode),
      };
      if (params.credentialValue?.trim()) {
        const key = buildBotCredentialKey(bot.id);
        await deps.credentialService.save(key, params.credentialValue.trim());
        bot = { ...bot, credentialRef: key };
      }
      if (params.webhookSecretValue?.trim()) {
        const key = buildBotWebhookSecretKey(bot.id);
        await deps.credentialService.save(key, params.webhookSecretValue.trim());
        bot = { ...bot, webhookSecretRef: key };
      }
      if (params.credentialValue?.trim() || !bot.name.trim()) {
        const adapter = providers[bot.provider];
        const resolveRetryDelaysMs = isFeishuBotProvider(bot.provider) ? [0, 800, 1_800] : [0];
        let resolvedName: string | null | undefined = null;
        let lastResolveNameError: unknown;
        for (const retryDelayMs of resolveRetryDelaysMs) {
          if (retryDelayMs > 0) {
            // Bugfix: 飞书 / Lark 扫码创建应用后，应用信息接口可能短暂不可读；重试后再回填 Bot 名称。
            await delay(retryDelayMs);
          }
          try {
            resolvedName = await adapter?.resolveName?.(bot);
            if (resolvedName?.trim()) {
              break;
            }
          } catch (error) {
            lastResolveNameError = error;
          }
        }
        if (resolvedName?.trim()) {
          bot = { ...bot, name: resolvedName.trim() };
        } else if (lastResolveNameError) {
          botsLogger.warn(
            undefined,
            `resolve bot name failed bot=${bot.id}: ${lastResolveNameError instanceof Error ? lastResolveNameError.message : String(lastResolveNameError)}`,
          );
        }
      }
      bot = normalizeBotConfig(bot);
      validateBotConfig(config, bot);
      const bots = config.bots.filter((item) => item.id !== bot.id);
      bots.push(bot);
      const savedConfig = await writeBotConfig({ ...config, bots });
      telegramRuntime.scheduleRefresh(savedConfig);
      weixinRuntime.scheduleRefresh(savedConfig);
      feishuRuntime.scheduleRefresh(savedConfig);
      return bot;
    },
    async removeBotSecret(botId: string) {
      const config = await repo.readConfig();
      const bot = findBot(config, botId);
      if (!bot) {
        throw new Error(`Bot not found: ${botId}`);
      }
      if (bot.provider === "telegram") {
        void telegramRuntime.syncCommands({ ...bot, enabled: false });
      }
      if (isFeishuBotProvider(bot.provider)) {
        feishuRuntime.stopWebSocket(bot.id);
      }
      if (bot.provider === "weixin") {
        weixinRuntime.stopPolling(bot.id);
      }
      // Bugfix: 只移除密钥时如果保留旧绑定身份，UI 会显示“已连通”，但运行时已经没有 token 可用。
      // 这里同步清理绑定状态，让 Bot token 行回到可重新添加的状态。
      const nextBot = normalizeBotConfig({
        ...bot,
        credentialRef: undefined,
        webhookSecretRef: undefined,
        providerUserId: undefined,
        displayName: undefined,
        feishuAppId: isFeishuBotProvider(bot.provider) ? undefined : bot.feishuAppId,
      });
      const savedConfig = await writeBotConfig({
        ...config,
        bots: config.bots.map((item) => (item.id === bot.id ? nextBot : item)),
      });
      await repo.updateContext(bot.id, () => undefined);
      telegramRuntime.scheduleRefresh(savedConfig);
      weixinRuntime.scheduleRefresh(savedConfig);
      feishuRuntime.scheduleRefresh(savedConfig);
      if (bot.credentialRef) {
        await deps.credentialService.delete(bot.credentialRef);
      }
      if (bot.webhookSecretRef) {
        await deps.credentialService.delete(bot.webhookSecretRef);
      }
      return nextBot;
    },
    async deleteBot(botId: string) {
      const config = await repo.readConfig();
      const bot = findBot(config, botId);
      if (bot?.provider === "telegram") {
        void telegramRuntime.syncCommands({ ...bot, enabled: false });
      }
      if (bot && isFeishuBotProvider(bot.provider)) {
        feishuRuntime.stopWebSocket(bot.id);
      }
      if (bot?.provider === "weixin") {
        weixinRuntime.stopPolling(bot.id);
      }
      await writeBotConfig({
        ...config,
        bots: config.bots.filter((item) => item.id !== botId),
      });
      telegramRuntime.scheduleRefresh();
      weixinRuntime.scheduleRefresh();
      await repo.updateContext(botId, () => undefined);
      if (bot?.credentialRef) {
        await deps.credentialService.delete(bot.credentialRef);
      }
      if (bot?.webhookSecretRef) {
        await deps.credentialService.delete(bot.webhookSecretRef);
      }
    },
    async testBot(botId: string): Promise<BotTestResult> {
      const config = await repo.readConfig();
      const bot = findBot(config, botId);
      if (!bot) {
        return { ok: false, message: "Bot not found." };
      }
      const adapter = providers[bot.provider];
      if (!adapter) {
        return {
          ok: false,
          message: `${bot.provider} is reserved for a future version.`,
          provider: bot.provider,
        };
      }
      return { ...(await adapter.test(bot)), provider: bot.provider };
    },
    async createBindCode(params: BotCreateBindCodeParams): Promise<BotBindCodeResult> {
      const config = await repo.readConfig();
      const botId = params.botId ?? params.botId;
      if (!botId) {
        throw new Error("Bot id is required.");
      }
      const bot = findBot(config, botId);
      if (!bot) {
        throw new Error(`Bot not found: ${botId}`);
      }
      const code = createCode();
      const expiresAt = Date.now() + (params.ttlMs ?? BOT_BIND_CODE_TTL_MS);
      const allowedWorkspaces = normalizeAllowedWorkspaces(
        params.allowedWorkspaces ?? [ALL_BOT_WORKSPACES],
      );
      bindCodes.set(code, {
        botId: botId,
        code,
        allowedWorkspaces,
        expiresAt,
      });
      return { code, expiresAt };
    },
    async getGroupMemberNames(params: { botId: string; chatId: string }) {
      const key = getBotConversationKey({ ...params, chatType: "group" });
      const authorize = async () => {
        const bot = findBot(await repo.readConfig(), params.botId);
        const group = (await repo.readState()).bots[key]?.group;
        if (
          !bot?.enabled ||
          !bot.providerUserId ||
          !group?.enabled ||
          group.ownerId !== bot.providerUserId
        )
          throw new Error("Group member names are unavailable for this group");
        return { bot, group };
      };
      const before = await authorize();
      const names =
        (await providers[before.bot.provider]?.getGroupMemberNames?.(before.bot, params.chatId)) ??
        {};
      const after = await authorize();
      // 查询期间停用、重新授权或切换凭据后，旧请求不得将姓名带回新会话。
      if (
        before.group.authorizationId !== after.group.authorizationId ||
        before.bot.providerUserId !== after.bot.providerUserId ||
        before.bot.credentialRef !== after.bot.credentialRef ||
        before.bot.feishuAppId !== after.bot.feishuAppId ||
        before.bot.provider !== after.bot.provider
      )
        throw new Error("Group authorization changed while resolving names");
      return names;
    },
    async validateTopicResource(params) {
      await authorizeTopicResource(params, {
        readState: () => repo.readState(),
        readConfig: () => repo.readConfig(),
      });
    },
    async readTopicResource(params) {
      botsLogger.debug(
        `topic resource read task=${params.taskId} message=${params.messageId} trace=${params.trace?.traceId ?? "none"}`,
      );
      const result = await readAuthorizedTopicResource(params, {
        readState: () => repo.readState(),
        readConfig: () => repo.readConfig(),
        readMessage: async (bot, target, signal) => {
          const reader = providers[bot.provider]?.readTopicResourceMessage;
          if (!reader) throw new Error("Topic resource provider unavailable");
          return reader(bot, target, signal);
        },
        download: async (bot, attachment, target, signal) => {
          const result = await providers[bot.provider]?.downloadAttachment?.(
            bot,
            attachment,
            {
              botId: bot.id,
              provider: bot.provider,
              chatType: "group",
              chatId: target.chatId,
              threadId: target.threadId,
              providerUserId: bot.providerUserId!,
              providerMessageId: target.messageId,
            },
            signal,
          );
          if (!result) throw new Error("Topic resource download unavailable");
          return result;
        },
      });
      if (result.attachment.kind !== "file" && result.attachment.kind !== "image")
        throw new Error("Topic resource format unsupported");
      return {
        kind: result.attachment.kind,
        filename: result.attachment.filename,
        mimeType: result.attachment.mimeType || "application/octet-stream",
        sizeBytes: result.data.byteLength,
        dataBase64: Buffer.from(result.data).toString("base64"),
      };
    },
    async getTopicDetails(params) {
      const state = await repo.readState();
      const context =
        state.bots[
          getBotConversationKey({
            botId: params.botId,
            chatId: params.chatId,
            chatType: "group",
            threadId: params.threadId,
          })
        ];
      const workspace = context?.group?.taskWorkspaces?.[params.taskId] ?? context;
      if (
        !context?.group?.taskIds.includes(params.taskId) ||
        !workspace ||
        (workspace.workspaceIdentity?.trim() || workspace.workspacePath) !==
          (params.workspaceIdentity?.trim() || params.workspacePath)
      )
        throw new Error("Topic task scope mismatch");
      const bot = findBot(await repo.readConfig(), params.botId);
      if (!bot || context.group.ownerId !== bot.providerUserId)
        throw new Error("Topic owner scope mismatch");
      const batches = Object.values(context.group.inputs ?? {})
        .filter((input) => input.taskId === params.taskId && input.admission === "accepted")
        .flatMap((input) => (input.source.topicContext ? [input.source.topicContext] : []));
      const parent =
        state.bots[
          getBotConversationKey({ botId: params.botId, chatId: params.chatId, chatType: "group" })
        ];
      const service = await resolveZCodeTaskServiceForContext({ ...context, ...workspace });
      const summaries =
        (await service.readBotTopicSummaries?.({
          taskId: params.taskId,
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
        })) ?? [];
      return {
        messageCount: new Set(batches.flatMap((batch) => batch.messages.map((record) => record.id)))
          .size,
        hasGap: batches.some((batch) => batch.hasGap),
        historyEnabled: parent?.group?.historyEnabled !== false,
        summaries,
      };
    },
    async retryTopicPreparation(params) {
      const key = getBotConversationKey({ ...params, chatType: "group" });
      const context = (await repo.readState()).bots[key];
      const bot = findBot(await repo.readConfig(), params.botId);
      if (!bot?.enabled || !context?.group?.enabled || context.group.ownerId !== bot.providerUserId)
        throw new Error("Topic preparation target is no longer authorized");
      if (context.activeTaskId !== params.taskId) throw new Error("Topic preparation task changed");
      if (
        getWorkspaceKey(context.workspacePath, context.workspaceIdentity) !==
        getWorkspaceKey(params.workspacePath, params.workspaceIdentity)
      )
        throw new Error("Topic preparation workspace changed");
      await topicContinuations.get(key)?.settled();
      // 已提交命令只能查询原接收结果；材料重试不能绕过去重，留下永久准备状态。
      const latest = (await repo.readState()).bots[key];
      if (
        Object.values(latest?.group?.inputs ?? {}).some(
          (input) =>
            input.source.messageId === params.messageId ||
            input.source.messages?.some((original) => original.messageId === params.messageId),
        )
      )
        throw new Error("Topic input was already submitted; preparation cannot be retried");
      const message = topicPreparation.retry(key, params.messageId);
      if (!message) throw new Error("Topic preparation is no longer retryable");
      topicPreparation.update(key, [params.messageId], "preparing");
      await publishTopicPreparation();
      const replies = await service.handleInboundMessage(message);
      for (const reply of replies) await sendOutbound(bot, reply);
    },
    async replyToChannel(request) {
      return replyToBotChannel(request, {
        readState: () => repo.readState(),
        readConfig: () => repo.readConfig(),
        listMembers: async (bot, chatId) => {
          const read = providers[bot.provider]?.getGroupMemberNames;
          if (!read) throw new Error("Channel member lookup unavailable");
          return read(bot, chatId);
        },
        deliver: (bot, chatId, threadId, result) =>
          getGroupDeliverySender(bot, chatId, threadId)(result),
      });
    },
    async getBotStates() {
      return Object.entries((await repo.readState()).bots).map(([key, context]) => {
        if (context.group)
          context = {
            ...context,
            group: { ...context.group, preparation: topicPreparation.snapshot(key) },
          };
        const sender = groupDeliverySenders.get(key);
        if (!context.group || !sender) return context;
        return {
          ...context,
          group: {
            ...context.group,
            deliveries: Object.fromEntries(
              Object.entries(context.group.deliveries ?? {}).map(([id, result]) => [
                id,
                sender.project(result),
              ]),
            ),
          },
        };
      });
    },
    async reconcileGroupResult(params: {
      botId: string;
      chatId: string;
      deliveryId: string;
      threadId?: string;
      received: boolean;
    }) {
      const key = getBotConversationKey({
        botId: params.botId,
        chatType: "group",
        chatId: params.chatId,
        threadId: params.threadId,
      });
      let reconciled: BotGroupDelivery | undefined;
      await serializeStateWrite(async () => {
        const bot = findBot(await repo.readConfig(), params.botId);
        const state = await repo.readState();
        const context = state.bots[key];
        const result = context?.group?.deliveries?.[params.deliveryId];
        if (
          !bot?.enabled ||
          !context?.group?.enabled ||
          context.group.ownerId !== bot.providerUserId ||
          !result ||
          result.taskId !== context.activeTaskId ||
          result.status !== "unknown" ||
          groupDeliverySenders.get(key)?.isInFlight(params.deliveryId)
        ) {
          throw new Error("Saved group result cannot be reconciled in the current state");
        }
        reconciled = {
          ...result,
          status: params.received ? "sent" : "failed",
          lastError: undefined,
          updatedAt: Date.now(),
        };
        context.group.deliveries = { ...context.group.deliveries, [result.id]: reconciled };
        await repo.writeState(state);
      });
      await deps.broadcastService
        ?.send({
          channel: "bots:group-state",
          payload: { botId: params.botId, chatId: params.chatId },
        })
        .catch(() => undefined);
      return reconciled!;
    },
    async resendGroupResult(params: {
      botId: string;
      chatId: string;
      threadId?: string;
      deliveryId: string;
    }) {
      const bot = findBot(await repo.readConfig(), params.botId);
      if (!bot || !isFeishuBotProvider(bot.provider)) throw new Error("Group bot unavailable");
      const key = getBotConversationKey({
        botId: params.botId,
        chatType: "group",
        chatId: params.chatId,
        threadId: params.threadId,
      });
      const result = (await repo.readState()).bots[key]?.group?.deliveries?.[params.deliveryId];
      if (!result) throw new Error("Saved group result unavailable");
      await getGroupDeliverySender(bot, params.chatId, params.threadId)(result, true);
      return (await repo.readState()).bots[key]?.group?.deliveries?.[params.deliveryId] ?? result;
    },
    async setGroupEnabled(params: { botId: string; chatId: string; enabled: boolean }) {
      const bot = findBot(await repo.readConfig(), params.botId);
      if (!bot?.providerUserId) throw new Error("Bot owner unavailable");
      await handleGroupActivation(
        {
          botId: bot.id,
          actor: {
            provider: bot.provider,
            botId: bot.id,
            chatType: "group",
            chatId: params.chatId,
            providerUserId: bot.providerUserId,
          },
          text: params.enabled ? "/enable" : "/disable",
        },
        params.enabled,
      );
    },
    async retryPrivateDelivery({ botId, deliveryId }) {
      const failed = failedPrivateDeliveries.get(botId);
      const bot = findBot(await repo.readConfig(), botId);
      const context = (await repo.readState()).bots[botId];
      const recipient =
        bot?.provider === "weixin" ? context?.privateRecipientId : bot?.providerUserId;
      if (
        !failed ||
        failed.id !== deliveryId ||
        failed.sending ||
        !bot?.enabled ||
        context?.privateBindingId !== failed.bindingId ||
        context?.activeTaskId !== failed.taskId ||
        recipient !== failed.message.providerUserId
      )
        throw new Error("Private delivery is no longer available");
      failed.sending = true;
      try {
        await sendOutbound(bot, failed.message);
        if (failedPrivateDeliveries.get(botId) === failed) {
          failedPrivateDeliveries.delete(botId);
          const runtime = runtimeByBotId.get(botId);
          if (runtime)
            setRuntimeStatus({ ...runtime, deliveryRetryId: undefined, deliveryError: undefined });
        }
      } finally {
        failed.sending = false;
      }
    },
    async resetBotState(contextKey: string) {
      await repo.updateContext(contextKey, () => undefined);
      await reconcilePrivateSynchronization(contextKey);
    },
    watchAutomationRun,
    async handleInboundMessage(message: BotInboundMessage) {
      if (shutdownPromise) return [];
      if (message.senderType === "app") {
        // 机器人只能使用真人已启用的群/话题；原生 @ 可触发普通群输入，不能获取控制权限。
        if (
          message.actor.chatType !== "group" ||
          message.groupCardAction ||
          message.elicitationResponse
        )
          return [];
        const topic = (await repo.readState()).bots[
          getBotConversationKey({ ...message.actor, conversationThreadId: undefined })
        ];
        if (!topic?.group?.enabled) return [];
        if (message.actor.threadId) {
          if (topic.group.topicActive !== true) return [];
        } else if (message.mentionedBot !== true || topic.group.chatMode === "topic") {
          return [];
        }
      }
      message = {
        ...message,
        actor: { ...message.actor, mentionedBot: message.mentionedBot === true },
      };
      if (
        message.actor.chatType === "group" &&
        message.mentionedBot === false &&
        !message.groupCardAction
      ) {
        const topic = (await repo.readState()).bots[
          getBotConversationKey({ ...message.actor, conversationThreadId: undefined })
        ];
        if (
          !message.actor.threadId ||
          topic?.group?.topicActive === false ||
          (!topic?.group?.topicActive &&
            message.topicRootIsCurrentBot !== true &&
            !topicContinuations.has(getBotConversationKey(message.actor)))
        )
          return [];
      }

      if (message.actor.chatType === "group" && message.actor.threadId) {
        const actor: BotActor = { ...message.actor, conversationThreadId: undefined };
        const state = await repo.readState();
        if (!state.bots[getBotConversationKey(actor)]) {
          // alias 仅用于一次性安全迁移检查，不能再把话题路由到默认任务。
          for (const candidate of Object.values(state.bots)) {
            const group = candidate.group;
            if (!group || candidate.botId !== actor.botId || group.chatId !== actor.chatId)
              continue;
            const alias = group.topicAliases?.[actor.threadId!];
            if (!alias) continue;
            // 默认会话可能已切换工作区；迁移检查必须使用旧任务自己的完整工作区身份。
            const workspace = group.taskWorkspaces?.[alias.taskId] ?? candidate;
            const service = await resolveZCodeTaskServiceForContext({ ...candidate, ...workspace });
            if (
              !service.getBotGroupTaskBlockReason ||
              (await service.getBotGroupTaskBlockReason({
                taskId: alias.taskId,
                workspacePath: workspace.workspacePath,
                workspaceIdentity: workspace.workspaceIdentity,
              }))
            ) {
              return [createOutbound(actor, "原话题任务仍在执行，请结束后重新接入话题。")];
            }
          }
        }
        message = { ...message, actor };
      }
      if (message.actor.chatType === "group" && !message.groupCardAction) {
        const parent = (await repo.readState()).bots[
          getBotConversationKey({
            ...message.actor,
            threadId: undefined,
            conversationThreadId: undefined,
          })
        ];
        // 专用话题群根事件可能缺失 thread_id，必须通过原生消息解析，不能进入默认任务。
        if (
          parent?.group?.enabled &&
          parent.group.chatMode === "topic" &&
          !message.actor.threadId
        ) {
          const bot = findBot(await repo.readConfig(), message.botId);
          const resolve = bot && providers[bot.provider]?.resolveTopic;
          if (!bot || !resolve) throw new Error("Topic routing is unavailable");
          message = {
            ...message,
            actor: { ...message.actor, ...(await resolve(bot, message.actor)) },
          };
        }
      }
      if (
        message.actor.chatType === "group" &&
        !message.groupCardAction &&
        !message.elicitationResponse &&
        message.mentionedBot === false &&
        message.contentParts?.some((part) => part.type === "channelMention")
      ) {
        // 已接入话题曾把发给别人的任务也当成新指令；只记录补读边界，不触发停止或 CLI admission。
        if (message.actor.threadId)
          await serializeStateWrite(async () => {
            const state = await repo.readState();
            const current = state.bots[getBotConversationKey(message.actor)];
            if (!current?.group?.enabled || current.group.topicActive !== true) return;
            const accepted = Object.values(current.group.inputs ?? {}).filter(
              (input) => input.admission === "accepted",
            );
            current.group.backgroundHistory = {
              revision: randomUUID(),
              checkpoint: current.group.backgroundHistory
                ? current.group.backgroundHistory.checkpoint
                : accepted.at(-1)?.source.messageId,
            };
            await repo.writeState(state);
          });
        return [];
      }
      // 机器人生成的 slash/审批文字只能作为输入材料，不能进入控制分支。
      const commandType =
        message.senderType === "app"
          ? "message"
          : parseBotCommand(message.commandText ?? message.text).type;
      const isGroupControl =
        message.actor.chatType === "group" &&
        (Boolean(message.elicitationResponse) ||
          [
            "queue.cancel",
            "stop",
            "topic.leave",
            "permission.respond",
            "approve",
            "deny",
            "elicitation.respond",
            "elicitation.submit",
          ].includes(commandType));
      const processInbound = async () => {
        await capturePrivateContextToken(message);
        if (message.elicitationResponse) {
          return handleStructuredElicitationResponse(message, message.elicitationResponse);
        }
        const parsedCommand = parseBotCommand(message.commandText ?? message.text);
        // 群主聊天也会进入此分发器；仅改外层 commandType 不能阻止机器人触发控制/数字选择。
        const command =
          message.senderType === "app"
            ? ({ type: "message", text: message.text } as const)
            : parsedCommand.type === "message"
              ? (resolvePendingSelectionCommand(message.actor, parsedCommand.text) ?? parsedCommand)
              : parsedCommand.type === "selection.cancel" &&
                  message.actor.provider !== "weixin" &&
                  (message.commandText ?? message.text).trim() === "0"
                ? (clearPendingSelection(message.actor),
                  { type: "message", text: message.text } as const)
                : parsedCommand;
        const weixinActivationReply = await handleWeixinFirstActivation(message, command);
        if (weixinActivationReply) {
          await capturePrivateContextToken(message);
          return weixinActivationReply;
        }
        switch (command.type) {
          case "queue.cancel":
            return cancelGroupInput(message, command.commandId);
          case "group.enable":
            return handleGroupActivation(message, true);
          case "group.disable":
            return handleGroupActivation(message, false);
          case "group.history":
            return handleGroupHistory(message, command.enabled);
          case "selection.cancel":
            return handleSelectionCancel(message);
          case "bind":
            return handleBind(message, command.code);
          case "help":
            return handleHelp(message);
          case "status":
            return handleStatus(message);
          case "reconnect":
            return handleReconnect(message);
          case "new": {
            const auth = await withAuthorizedContext(message, "new");
            if (!auth.ok) return auth.reply;
            if (message.actor.threadId)
              return [
                createOutbound(
                  message.actor,
                  auth.locale === "en-US"
                    ? "Open another topic to start a new task."
                    : "请另开一个话题开始新任务。",
                ),
              ];
            const blockReason = await getContextTaskBlockReason(auth.context);
            if (blockReason) {
              return [createOutbound(message.actor, msg(auth.locale, blockReason))];
            }
            const context = await writeDraftContext(
              auth.context,
              await buildActiveTaskDraftOptions(auth.context),
            );
            return createStatusReply(message.actor, context, auth.locale);
          }
          case "workspace.list": {
            const auth = await withAuthorizedContext(message, "workspace");
            if (!auth.ok) return auth.reply;
            const blockReason = await getContextTaskBlockReason(auth.context);
            if (blockReason) {
              // Bugfix: task 运行中不展示 workspace 选择，避免用户误以为可以切换上下文。
              return [createOutbound(message.actor, msg(auth.locale, blockReason))];
            }
            const synced = await normalizeBotWorkspaceConfig(
              auth.config,
              auth.bot,
              createCurrentWorkspaceRef(auth.context),
            );
            const visibleWorkspaces = filterAllowedWorkspaces(
              synced.workspaces,
              synced.user.allowedWorkspaces,
            );
            const options = visibleWorkspaces.map((workspace) => ({
              id: workspace.id,
              // Bugfix: Telegram/飞书等按钮通道只展示 label，不展示 description。
              // 远端标识必须合进 label，避免 /workspace 列表看不出哪些项目来自远端。
              label: formatWorkspaceOptionLabel(workspace, auth.locale),
            }));
            if (options.length === 0) {
              pendingWorkspaceSelectionsByContext.delete(getActorContextKey(message.actor));
              return [createOutbound(message.actor, msg(auth.locale, "workspaceMissing"))];
            }
            // Bugfix: 远端 workspace 选项必须在展示时保留 workspaceIdentity。
            // Telegram/飞书按钮会把点击变成 /workspace 序号，切换阶段若重新从 settings 解析，
            // current remote context 可能不在候选列表里，最终表现成 /workspace 不支持远端。
            pendingWorkspaceSelectionsByContext.set(
              getActorContextKey(message.actor),
              new Map(visibleWorkspaces.map((workspace) => [workspace.id, { workspace }])),
            );
            return createSelectionReply(
              message.actor,
              {
                id: `workspace-${Date.now()}`,
                title: msg(auth.locale, "workspaceSelectTitle", {
                  workspace:
                    visibleWorkspaces.find((workspace) => workspace.id === auth.context.workspaceId)
                      ?.label ?? auth.context.workspacePath,
                }),
                currentId: auth.context.workspaceId,
                action: "workspace.set",
                options,
              },
              auth.locale,
            );
          }
          case "workspace.set": {
            const auth = await withAuthorizedContext(message, "workspace");
            if (!auth.ok) return auth.reply;
            const blockReason = await getContextTaskBlockReason(auth.context);
            if (blockReason) {
              return [createOutbound(message.actor, msg(auth.locale, blockReason))];
            }
            const synced = await normalizeBotWorkspaceConfig(
              auth.config,
              auth.bot,
              createCurrentWorkspaceRef(auth.context),
            );
            const workspace =
              resolvePendingWorkspaceSelectionEntry(message.actor, command.value)?.workspace ??
              resolveWorkspaceByValue(
                synced.workspaces,
                command.value,
                synced.user.allowedWorkspaces,
              );
            if (!workspace)
              return [createOutbound(message.actor, msg(auth.locale, "workspaceMissing"))];
            if (!isWorkspaceAllowed(workspace.id, synced.user.allowedWorkspaces))
              return [createOutbound(message.actor, msg(auth.locale, "workspaceOutOfScope"))];
            const context = { ...auth.context, ...(await bindProject(workspace)) };
            const draftContext = await writeDraftContext(
              context,
              await buildInitializedDraftOptions(context),
            );
            pendingWorkspaceSelectionsByContext.delete(getActorContextKey(message.actor));
            return createStatusReply(message.actor, draftContext, auth.locale);
          }
          case "model.list": {
            const auth = await withAuthorizedContext(message, "model");
            if (!auth.ok) return auth.reply;
            const blockReason = await getContextTaskBlockReason(auth.context);
            if (blockReason) {
              // Bugfix: task 运行中不展示模型选择，避免产生运行中不可用的 pending selection。
              return [createOutbound(message.actor, msg(auth.locale, blockReason))];
            }
            if (auth.context.mode === "draft" || !auth.context.activeTaskId) {
              const draftOptions = await resolveDraftOptionsForDisplay(auth.context);
              const providers = await listModelProviderOptionsForActiveTask(
                {
                  model: formatBotModelSelectionValue(draftOptions.modelSelection),
                  workspacePath: auth.context.workspacePath,
                  workspaceIdentity: auth.context.workspaceIdentity,
                },
                draftOptions.provider,
              );
              if (providers.length === 0) {
                return [createOutbound(message.actor, msg(auth.locale, "modelProviderMissing"))];
              }
              const currentProviderId = await readCurrentModelProviderId(
                {
                  model: formatBotModelSelectionValue(draftOptions.modelSelection),
                  workspacePath: auth.context.workspacePath,
                  workspaceIdentity: auth.context.workspaceIdentity,
                },
                [],
                draftOptions.provider,
              );
              return createSelectionReply(
                message.actor,
                {
                  id: `model-${Date.now()}`,
                  title: msg(auth.locale, "modelProviderSelectTitle", {
                    model: await formatStatusModelLabel(
                      formatBotModelSelectionValue(draftOptions.modelSelection),
                      auth.context,
                    ),
                  }),
                  currentId: currentProviderId,
                  action: "model.provider.set",
                  options: providers,
                },
                auth.locale,
              );
            }
            const active = await requireActiveTask(message, auth);
            if (!active.ok) return active.reply;
            const activeProvider = normalizeAgentProviderToZCodeAgent(active.task.provider);
            if (!activeProvider) {
              return [createOutbound(message.actor, msg(auth.locale, "modelProviderMissing"))];
            }
            const providers = await listModelProviderOptionsForActiveTask(
              active.task,
              activeProvider,
            );
            if (providers.length === 0) {
              return [createOutbound(message.actor, msg(auth.locale, "modelProviderMissing"))];
            }
            const currentValue = readCurrentActiveTaskModel(active.task, active.configOptions);
            const currentProviderId = await readCurrentModelProviderId(
              active.task,
              active.configOptions,
              activeProvider,
            );
            return createSelectionReply(
              message.actor,
              {
                id: `model-${Date.now()}`,
                title: msg(auth.locale, "modelProviderSelectTitle", {
                  model: await formatStatusModelLabel(currentValue, active.task),
                }),
                currentId: currentProviderId,
                action: "model.provider.set",
                options: providers,
              },
              auth.locale,
            );
          }
          case "model.provider.set": {
            const auth = await withAuthorizedContext(message, "model");
            if (!auth.ok) return auth.reply;
            const blockReason = await getContextTaskBlockReason(auth.context);
            if (blockReason) {
              return [createOutbound(message.actor, msg(auth.locale, blockReason))];
            }
            if (auth.context.mode === "draft" || !auth.context.activeTaskId) {
              const draftOptions = await resolveDraftOptionsForDisplay(auth.context);
              const draftTask = {
                model: formatBotModelSelectionValue(draftOptions.modelSelection),
                workspacePath: auth.context.workspacePath,
                workspaceIdentity: auth.context.workspaceIdentity,
              };
              const providers = await listModelProviderOptionsForActiveTask(
                draftTask,
                draftOptions.provider,
              );
              const provider =
                resolvePendingSelectionOption(message.actor, "model.provider.set", command.value) ??
                resolveOptionByValue(providers, command.value);
              const providerId = provider?.id;
              if (!providerId) {
                return [createOutbound(message.actor, msg(auth.locale, "modelProviderMissing"))];
              }
              const providerModels = readModelProviderSelectionModels(provider);
              const options =
                providerModels.length > 0
                  ? providerModels
                  : await listModelOptionsForProviderFromActiveTask(
                      draftTask,
                      draftOptions.provider,
                      providerId,
                    );
              if (options.length === 0) {
                return [createOutbound(message.actor, msg(auth.locale, "modelMissing"))];
              }
              return createSelectionReply(
                message.actor,
                {
                  id: `model-${Date.now()}`,
                  title: msg(auth.locale, "modelModelSelectTitle", {
                    model: formatBotModelSelectionValue(draftOptions.modelSelection) ?? "-",
                  }),
                  currentId: options.some(
                    (option) =>
                      option.id === formatBotModelSelectionValue(draftOptions.modelSelection),
                  )
                    ? formatBotModelSelectionValue(draftOptions.modelSelection)
                    : undefined,
                  action: "model.set",
                  options,
                },
                auth.locale,
              );
            }
            const active = await requireActiveTask(message, auth);
            if (!active.ok) return active.reply;
            const activeProvider = normalizeAgentProviderToZCodeAgent(active.task.provider);
            if (!activeProvider) {
              return [createOutbound(message.actor, msg(auth.locale, "modelProviderMissing"))];
            }
            const providers = await listModelProviderOptionsForActiveTask(
              active.task,
              activeProvider,
            );
            const provider =
              resolvePendingSelectionOption(message.actor, "model.provider.set", command.value) ??
              resolveOptionByValue(providers, command.value);
            const providerId = provider?.id;
            if (!providerId) {
              return [createOutbound(message.actor, msg(auth.locale, "modelProviderMissing"))];
            }
            const providerModels = readModelProviderSelectionModels(provider);
            const options =
              providerModels.length > 0
                ? providerModels
                : await listModelOptionsForProviderFromActiveTask(
                    active.task,
                    activeProvider,
                    providerId,
                  );
            if (options.length === 0) {
              return [createOutbound(message.actor, msg(auth.locale, "modelMissing"))];
            }
            const currentValue = readCurrentActiveTaskModel(active.task, active.configOptions);
            return createSelectionReply(
              message.actor,
              {
                id: `model-${Date.now()}`,
                title: msg(auth.locale, "modelModelSelectTitle", {
                  model: currentValue ?? "-",
                }),
                currentId: options.some((option) => option.id === currentValue)
                  ? currentValue
                  : undefined,
                action: "model.set",
                options,
              },
              auth.locale,
            );
          }
          case "model.set": {
            const auth = await withAuthorizedContext(message, "model");
            if (!auth.ok) return auth.reply;
            const blockReason = await getContextTaskBlockReason(auth.context);
            if (blockReason) {
              return [createOutbound(message.actor, msg(auth.locale, blockReason))];
            }
            if (auth.context.mode === "draft" || !auth.context.activeTaskId) {
              const draftOptions = await ensureDraftOptions(auth.context);
              const model =
                resolvePendingSelectionOption(message.actor, "model.set", command.value) ??
                resolveOptionByValue(
                  await listAllModelOptionsForActiveTask(
                    {
                      model: formatBotModelSelectionValue(draftOptions.modelSelection),
                      workspacePath: auth.context.workspacePath,
                      workspaceIdentity: auth.context.workspaceIdentity,
                    },
                    draftOptions.provider,
                  ),
                  command.value,
                );
              if (!model) {
                return [createOutbound(message.actor, msg(auth.locale, "modelMissing"))];
              }
              const identity = parseBotModelOptionValue(model.id);
              const view = await readModelSelectionView(auth.context);
              const selection =
                view && identity ? completeNewModelSelection(view, identity) : undefined;
              // Bot 的主动选模也须取目标最高档；旧菜单失效/读取失败不能清掉已保存选择。
              if (!selection)
                return [createOutbound(message.actor, msg(auth.locale, "modelMissing"))];
              const nextContext = await writeDraftOptions(auth.context, {
                ...draftOptions,
                // 模型身份切换必须构造全新的 Selection，不能把旧模型的显式 options 带过去。
                modelSelection: selection,
              });
              return createStatusReply(message.actor, nextContext, auth.locale);
            }
            const active = await requireActiveTask(message, auth);
            if (!active.ok) return active.reply;
            const activeProvider = normalizeAgentProviderToZCodeAgent(active.task.provider);
            if (!activeProvider) {
              return [createOutbound(message.actor, msg(auth.locale, "modelProviderMissing"))];
            }
            const model =
              resolvePendingSelectionOption(message.actor, "model.set", command.value) ??
              resolveOptionByValue(
                await listAllModelOptionsForActiveTask(active.task, activeProvider),
                command.value,
              );
            if (!model) return [createOutbound(message.actor, msg(auth.locale, "modelMissing"))];
            const nextModel = model.id;
            const customModel = decodeCustomModelValue(nextModel);
            const targetModel = customModel
              ? resolveCustomModelRuntimeModelId(activeProvider, customModel)
              : nextModel;
            if (!targetModel) {
              return [createOutbound(message.actor, msg(auth.locale, "modelMissing"))];
            }
            const targetIdentity = customModel?.modelName
              ? {
                  // Bugfix: bot /model 选择 custom provider 时，targetModel 会被降成纯模型名。
                  // legacy task facade 必须额外拿到原始 provider 身份，否则同名模型会退回 glm/native。
                  providerId: customModel.providerId,
                  modelId: customModel.modelName,
                }
              : { providerId: activeProvider, modelId: targetModel };
            const view = await readModelSelectionView(active.task);
            const targetModelSelection = view
              ? completeNewModelSelection(view, targetIdentity)
              : undefined;
            if (!targetModelSelection)
              return [createOutbound(message.actor, msg(auth.locale, "modelMissing"))];
            const traceId = generateTraceId(active.taskId);
            const zcodeTaskService = await resolveZCodeTaskServiceForContext(active.task);
            const configOptions = await zcodeTaskService.setModel({
              taskId: active.taskId,
              traceId,
              modelSelection: targetModelSelection,
            });
            await broadcastTaskConfigSync({
              context: auth.context,
              taskId: active.taskId,
              task: await readContextActiveTaskMeta(auth.context),
              provider: activeProvider,
              configOptions,
            });
            return createStatusReply(message.actor, auth.context, auth.locale);
          }
          case "mode.list":
          case "thoughtLevel.list": {
            const commandName = command.type === "mode.list" ? "mode" : "thoughtLevel";
            const auth = await withAuthorizedContext(message, commandName);
            if (!auth.ok) return auth.reply;
            if (command.type === "mode.list" && !auth.context.group) {
              // Bot 硬锁 yolo：不提供模式选择。
              return [createOutbound(message.actor, msg(auth.locale, "modeLocked"))];
            }
            const blockReason = await getContextTaskBlockReason(auth.context);
            if (blockReason) {
              // Bugfix: task 运行中不展示模式/思考级别选择，避免和正在执行的上下文配置混淆。
              return [createOutbound(message.actor, msg(auth.locale, blockReason))];
            }
            if (auth.context.mode === "draft" || !auth.context.activeTaskId) {
              const draftOptions = await ensureDraftOptions(auth.context);
              const optionSource = await listDraftConfigOptions(auth.context, draftOptions);
              const rawCurrentValue =
                commandName === "mode"
                  ? draftOptions.mode
                  : findSelectConfigOption(optionSource, commandName)?.currentValue;
              const currentValue =
                typeof rawCurrentValue === "string" ? rawCurrentValue : undefined;
              const currentLabel = readConfigSelectLabelForValue(
                optionSource,
                commandName,
                currentValue,
                { locale: auth.locale, provider: draftOptions.provider },
              );
              const selectOption = findSelectConfigOption(optionSource, commandName);
              const options = listConfigSelectOptions(optionSource, commandName, {
                locale: auth.locale,
                provider: draftOptions.provider,
              });
              if (options.length === 0) {
                return [
                  createOutbound(
                    message.actor,
                    msg(auth.locale, getConfigCommandMissingMessageId(commandName)),
                  ),
                ];
              }
              return createSelectionReply(
                message.actor,
                {
                  id: `${selectOption?.id ?? commandName}-${Date.now()}`,
                  title:
                    commandName === "mode"
                      ? msg(auth.locale, "modeSelectTitle", {
                          mode: currentLabel ?? "-",
                        })
                      : msg(auth.locale, "thoughtLevelSelectTitle", {
                          level: currentLabel ?? "-",
                        }),
                  currentId: currentValue,
                  action: `${commandName}.set` as SelectionPrompt["action"],
                  options,
                },
                auth.locale,
              );
            }
            const active = await requireActiveTask(message, auth);
            if (!active.ok) return active.reply;
            const optionSource =
              commandName === "mode" && active.task.provider
                ? await listProviderConfigOptionsForActiveTask(
                    active.task,
                    normalizeAgentProviderToZCodeAgent(active.task.provider),
                  )
                : active.configOptions;
            const currentValue =
              commandName === "mode"
                ? readCurrentActiveTaskMode(active.task, active.configOptions)
                : readConfigSelectCurrentValue(active.configOptions, commandName);
            const currentLabel =
              commandName === "mode"
                ? readConfigSelectLabelForValue(optionSource, commandName, currentValue, {
                    locale: auth.locale,
                    provider: normalizeAgentProviderToZCodeAgent(active.task.provider),
                  })
                : readConfigSelectCurrentLabel(active.configOptions, commandName, {
                    locale: auth.locale,
                    provider: normalizeAgentProviderToZCodeAgent(active.task.provider),
                  });
            const selectOption = findSelectConfigOption(optionSource, commandName);
            const options = listConfigSelectOptions(optionSource, commandName, {
              locale: auth.locale,
              provider: normalizeAgentProviderToZCodeAgent(active.task.provider),
            });
            if (options.length === 0) {
              return [
                createOutbound(
                  message.actor,
                  msg(auth.locale, getConfigCommandMissingMessageId(commandName)),
                ),
              ];
            }
            return createSelectionReply(
              message.actor,
              {
                id: `${selectOption?.id ?? commandName}-${Date.now()}`,
                title:
                  commandName === "mode"
                    ? msg(auth.locale, "modeSelectTitle", {
                        mode: currentLabel ?? "-",
                      })
                    : msg(auth.locale, "thoughtLevelSelectTitle", {
                        level: currentLabel ?? "-",
                      }),
                currentId: currentValue,
                action: `${commandName}.set` as SelectionPrompt["action"],
                options,
              },
              auth.locale,
            );
          }
          case "mode.set":
          case "thoughtLevel.set": {
            const commandName = command.type === "mode.set" ? "mode" : "thoughtLevel";
            const auth = await withAuthorizedContext(message, commandName);
            if (!auth.ok) return auth.reply;
            if (command.type === "mode.set" && !auth.context.group) {
              // Bot 硬锁 yolo：拒绝任何模式切换请求。
              return [createOutbound(message.actor, msg(auth.locale, "modeLocked"))];
            }
            const blockReason = await getContextTaskBlockReason(auth.context);
            if (blockReason) {
              return [createOutbound(message.actor, msg(auth.locale, blockReason))];
            }
            if (auth.context.mode === "draft" || !auth.context.activeTaskId) {
              const originalOptions = await ensureDraftOptions(auth.context);
              const view = await readModelSelectionView(
                auth.context,
                originalOptions.modelSelection,
              );
              const optionSource = await listDraftConfigOptions(
                auth.context,
                originalOptions,
                view,
              );
              // 同一个快照给出候选与当前模型；失效原意图不能因副本为空退回 preferred。
              const draftOptions = {
                ...originalOptions,
                modelSelection:
                  (originalOptions.modelSelection
                    ? view?.effectiveSelection
                    : view?.preferredSelection) ?? undefined,
              };
              const displayOptions = listConfigSelectOptions(optionSource, commandName, {
                locale: auth.locale,
                provider: draftOptions.provider,
              });
              const option =
                resolvePendingSelectionOption(
                  message.actor,
                  `${commandName}.set` as SelectionPrompt["action"],
                  command.value,
                ) ?? resolveOptionByValue(displayOptions, command.value);
              if (option && !displayOptions.some((candidate) => candidate.id === option.id)) {
                return [
                  createOutbound(
                    message.actor,
                    msg(auth.locale, getConfigCommandMissingMessageId(commandName)),
                  ),
                ];
              }
              if (!option) {
                return [
                  createOutbound(
                    message.actor,
                    msg(auth.locale, getConfigCommandMissingMessageId(commandName)),
                  ),
                ];
              }
              const nextContext = await writeDraftOptions(auth.context, {
                ...draftOptions,
                ...(commandName === "mode"
                  ? { mode: option.id }
                  : draftOptions.modelSelection
                    ? {
                        modelSelection: {
                          ...draftOptions.modelSelection,
                          options: {
                            ...draftOptions.modelSelection.options,
                            reasoningLevel: option.id,
                          },
                        },
                      }
                    : {}),
              });
              return createStatusReply(message.actor, nextContext, auth.locale);
            }
            const active = await requireActiveTask(message, auth);
            if (!active.ok) return active.reply;
            const optionSource =
              commandName === "mode" && active.task.provider
                ? await listProviderConfigOptionsForActiveTask(active.task, active.task.provider)
                : active.configOptions;
            const selectOption = findSelectConfigOption(optionSource, commandName);
            const displayOptions = listConfigSelectOptions(optionSource, commandName, {
              locale: auth.locale,
              provider: active.task.provider,
            });
            const option =
              resolvePendingSelectionOption(
                message.actor,
                `${commandName}.set` as SelectionPrompt["action"],
                command.value,
              ) ?? resolveOptionByValue(displayOptions, command.value);
            if (!option) {
              return [
                createOutbound(
                  message.actor,
                  msg(auth.locale, getConfigCommandMissingMessageId(commandName)),
                ),
              ];
            }
            if (!selectOption?.id) {
              return [
                createOutbound(
                  message.actor,
                  msg(auth.locale, getConfigCommandMissingMessageId(commandName)),
                ),
              ];
            }
            const traceId = generateTraceId(active.taskId);
            const zcodeTaskService = await resolveZCodeTaskServiceForContext(auth.context);
            const configOptions = await zcodeTaskService.setConfigOption({
              taskId: active.taskId,
              traceId,
              configId: selectOption.id,
              value: option.id,
            });
            await broadcastTaskConfigSync({
              context: auth.context,
              taskId: active.taskId,
              task: await readContextActiveTaskMeta(auth.context),
              provider: active.task.provider,
              configOptions,
            });
            return createStatusReply(message.actor, auth.context, auth.locale);
          }
          case "task.list":
            return handleTaskList(message);
          case "task.set": {
            const auth = await withAuthorizedContext(message, "task");
            if (!auth.ok) return auth.reply;
            if (message.actor.threadId)
              return createStatusReply(message.actor, auth.context, auth.locale);
            const taskEntry = await resolveTaskSelectionEntry(
              message,
              auth.context,
              auth.user,
              command.value,
            );
            if (!taskEntry) return [createOutbound(message.actor, msg(auth.locale, "taskMissing"))];
            const { task } = taskEntry;
            const blockReason =
              auth.context.activeTaskId !== task.taskId
                ? await getContextTaskBlockReason(auth.context)
                : null;
            if (blockReason) {
              // Bugfix: 运行中的旧 task 已经建立了第三方 stream 订阅。
              // 如果此时允许 /task 改写 activeTaskId，后续输入会落到新 task，
              // 但旧 task 输出仍会继续回到同一 bot 会话，用户会误以为消息串线。
              return [createOutbound(message.actor, msg(auth.locale, blockReason))];
            }
            const nextContext = {
              ...auth.context,
              mode: "task",
              activeTaskId: task.taskId,
            } satisfies BotContextState;
            await writeContext(nextContext);
            if (auth.context.activeTaskId !== nextContext.activeTaskId)
              stopGroupSynchronization(auth.context);
            await restoreGroupSynchronization(nextContext);
            pendingTaskSelectionsByContext.delete(getActorContextKey(message.actor));
            return createStatusReply(message.actor, nextContext, auth.locale);
          }
          case "reply.list": {
            const auth = await withAuthorizedContext(message, "reply");
            if (!auth.ok) return auth.reply;
            return createSelectionReply(
              message.actor,
              {
                id: `reply-${Date.now()}`,
                title: msg(auth.locale, "replySelectTitle", {
                  mode: formatReplyGranularityLabel(
                    auth.bot.replyMode,
                    auth.locale,
                    auth.bot.provider,
                  ),
                }),
                currentId: normalizeBotReplyGranularity(auth.bot.provider, auth.bot.replyMode),
                action: "reply.set",
                options: getReplyGranularityOptions(auth.locale, auth.bot.provider),
              },
              auth.locale,
            );
          }
          case "reply.set": {
            const auth = await withAuthorizedContext(message, "reply");
            if (!auth.ok) return auth.reply;
            const replyGranularity = resolveReplyGranularityByValue(
              command.value,
              auth.locale,
              auth.bot.provider,
            );
            if (!replyGranularity)
              return [createOutbound(message.actor, msg(auth.locale, "replyMissing"))];
            await service.saveBot({
              bot: {
                ...auth.bot,
                replyMode: replyGranularity.id,
              },
            });
            return createStatusReply(message.actor, auth.context, auth.locale);
          }
          case "topic.leave": {
            const auth = await withAuthorizedContext(message, "workspace");
            if (!auth.ok) return auth.reply;
            if (!auth.context.group?.threadId)
              return [
                createOutbound(
                  message.actor,
                  auth.locale === "en-US"
                    ? "Use /leave inside a topic."
                    : "请在话题中使用 /leave。",
                ),
              ];
            await cancelTopicInputs(message.actor);
            await serializeStateWrite(async () => {
              const state = await repo.readState();
              const current = state.bots[getBotStateKey(auth.context)];
              if (current?.group) current.group.topicActive = false;
              await repo.writeState(state);
            });
            if (auth.context.activeTaskId) {
              const service = await resolveZCodeTaskServiceForContext(auth.context);
              const target = {
                taskId: auth.context.activeTaskId,
                workspacePath: auth.context.workspacePath,
                workspaceIdentity: auth.context.workspaceIdentity,
              };
              if (!service.readBotTopicExecution || !service.stopBotTopicExecution)
                throw new Error("Topic runtime control is unavailable");
              const executionId = await service.readBotTopicExecution(target);
              if (executionId) await stopTopicRun(auth.context, executionId.executionId);
            }
            return [
              createOutbound(
                message.actor,
                auth.locale === "en-US"
                  ? "Left this topic. Mention me to resume the same task."
                  : "已退出话题。再次 @我可继续原任务。",
              ),
            ];
          }
          case "stop": {
            const auth = await withAuthorizedContext(message, "stop");
            if (!auth.ok) return auth.reply;
            if (auth.context.group?.threadId) await cancelTopicInputs(message.actor);
            if (!auth.context.activeTaskId) {
              return [createOutbound(message.actor, msg(auth.locale, "noActiveTask"))];
            }
            try {
              const zcodeTaskService = await resolveZCodeTaskServiceForContext(auth.context);
              if (auth.context.group?.threadId) {
                if (!zcodeTaskService.readBotTopicExecution)
                  throw new Error("Topic runtime control is unavailable");
                const executionId = await zcodeTaskService.readBotTopicExecution({
                  taskId: auth.context.activeTaskId,
                  workspacePath: auth.context.workspacePath,
                  workspaceIdentity: auth.context.workspaceIdentity,
                });
                if (executionId) await stopTopicRun(auth.context, executionId.executionId);
              } else await zcodeTaskService.stopGeneration({ taskId: auth.context.activeTaskId });
            } catch (error) {
              const messageText = error instanceof Error ? error.message : String(error);
              return [
                createOutbound(
                  message.actor,
                  msg(auth.locale, "taskFailed", { message: messageText }),
                ),
              ];
            }
            runningTasks.delete(auth.context.activeTaskId);
            stopTyping(auth.context.activeTaskId);
            await broadcastTaskListChange(auth.context, auth.context.activeTaskId, "updated");
            // 群聊成功停止只更新状态，避免状态卡再次触发机器人互答。
            return auth.context.group
              ? []
              : createStatusReply(message.actor, auth.context, auth.locale);
          }
          case "permission.respond": {
            const auth = await withAuthorizedContext(message, "approve");
            if (!auth.ok) return auth.reply;
            if (!auth.context.activeTaskId)
              return [createOutbound(message.actor, msg(auth.locale, "noActiveTask"))];
            const optionIndex = Number.parseInt(command.value, 10) - 1;
            const option = Number.isFinite(optionIndex)
              ? auth.context.pendingPermissionOptions?.[optionIndex]
              : undefined;
            botsLogger.info(
              undefined,
              `permission callback task=${auth.context.activeTaskId} user=${message.actor.providerUserId} optionIndex=${optionIndex + 1} pending=${auth.context.pendingPermissionOptions?.length ?? 0} option=${option ? `${option.command}:${option.optionId}` : "missing"} handled=${option?.handledAt ? "yes" : "no"}`,
            );
            if (!option)
              return [createOutbound(message.actor, msg(auth.locale, "permissionExpired"))];
            if (option.handledAt)
              return [createOutbound(message.actor, msg(auth.locale, "permissionHandled"))];
            const zcodeTaskService = await resolveZCodeTaskServiceForContext(auth.context);
            const submitted = await zcodeTaskService.respondPermission({
              taskId: auth.context.activeTaskId,
              requestId: option.requestId,
              optionId: option.optionId,
              response: option.response,
            });
            // 修复原因：权限和问答必须以同一个 v4 ACK 为提交点。ACK 失败前不能持久化
            // handledAt，否则 Telegram/文本序号按钮无法重试，runtime 仍会继续等待权限。
            const handledAt = Date.now();
            const nextPermissionOptions = auth.context.pendingPermissionOptions?.map((item) =>
              item.requestId === option.requestId ? { ...item, handledAt } : item,
            );
            botsLogger.info(
              undefined,
              `permission callback respond task=${auth.context.activeTaskId} requestId=${option.requestId} optionId=${option.optionId} submitted=${submitted}`,
            );
            if (!submitted) {
              return [createOutbound(message.actor, msg(auth.locale, "permissionHandled"))];
            }
            await writeContext({
              ...auth.context,
              pendingPermissionOptions: nextPermissionOptions,
            });
            await broadcastTaskListChange(
              auth.context,
              auth.context.activeTaskId,
              "permission_resolved",
              {
                requestId: option.requestId,
              },
            );
            startTyping(auth.bot, message.actor, auth.context.activeTaskId);
            return [
              createOutbound(
                message.actor,
                msg(
                  auth.locale,
                  option.command === "deny" ? "permissionDenied" : "permissionSubmitted",
                ),
              ),
            ];
          }
          case "elicitation.respond": {
            const auth = await withAuthorizedContext(message, "message");
            if (!auth.ok) return auth.reply;
            return handlePendingElicitationValue(auth, message.actor, command.value);
          }
          case "elicitation.submit": {
            const auth = await withAuthorizedContext(message, "message");
            if (!auth.ok) return auth.reply;
            const pending = auth.context.pendingElicitation;
            if (!pending) {
              return [createOutbound(message.actor, msg(auth.locale, "elicitationExpired"))];
            }
            if (message.actor.provider !== "weixin") {
              // Bugfix: 非微信通道的“完成”应从带 token 的按钮进入 elicitation.respond。
              // 直接 /elicitation submit 没有轮次标识，可能误提交上一轮 AskUserQuestion。
              return [createOutbound(message.actor, msg(auth.locale, "elicitationExpired"))];
            }
            return submitPendingElicitation(
              auth,
              message.actor,
              pending,
              "accept",
              buildBotElicitationContent(pending),
            );
          }
          case "approve": {
            const auth = await withAuthorizedContext(message, "approve");
            if (!auth.ok) return auth.reply;
            if (!auth.context.activeTaskId)
              return [createOutbound(message.actor, msg(auth.locale, "noActiveTask"))];
            const pendingOption = auth.context.pendingPermissionOptions?.find(
              (option) =>
                option.requestId === command.requestId && option.optionId === command.optionId,
            );
            if (!pendingOption) {
              return [createOutbound(message.actor, msg(auth.locale, "permissionHandled"))];
            }
            const zcodeTaskService = await resolveZCodeTaskServiceForContext(auth.context);
            const submitted = await zcodeTaskService.respondPermission({
              taskId: auth.context.activeTaskId,
              requestId: command.requestId,
              optionId: command.optionId,
              response: pendingOption.response,
            });
            if (!submitted)
              return [createOutbound(message.actor, msg(auth.locale, "permissionHandled"))];
            await broadcastTaskListChange(
              auth.context,
              auth.context.activeTaskId,
              "permission_resolved",
              {
                requestId: command.requestId,
              },
            );
            startTyping(auth.bot, message.actor, auth.context.activeTaskId);
            return [createOutbound(message.actor, msg(auth.locale, "permissionSubmitted"))];
          }
          case "deny": {
            const auth = await withAuthorizedContext(message, "approve");
            if (!auth.ok) return auth.reply;
            if (!auth.context.activeTaskId)
              return [createOutbound(message.actor, msg(auth.locale, "noActiveTask"))];
            const pendingOption = auth.context.pendingPermissionOptions?.find(
              (option) => option.requestId === command.requestId && option.command === "deny",
            );
            const zcodeTaskService = await resolveZCodeTaskServiceForContext(auth.context);
            const submitted = await zcodeTaskService.respondPermission({
              taskId: auth.context.activeTaskId,
              requestId: command.requestId,
              optionId: "deny",
              response: pendingOption?.response ?? {
                decision: "deny",
                reason: "Denied by bot command",
              },
            });
            if (!submitted)
              return [createOutbound(message.actor, msg(auth.locale, "permissionHandled"))];
            await broadcastTaskListChange(
              auth.context,
              auth.context.activeTaskId,
              "permission_resolved",
              {
                requestId: command.requestId,
              },
            );
            startTyping(auth.bot, message.actor, auth.context.activeTaskId);
            return [createOutbound(message.actor, msg(auth.locale, "permissionDenied"))];
          }
          case "unknown":
            return [
              createOutbound(
                message.actor,
                msg(await readMessageLocale(), "unknownCommand", {
                  command: command.name,
                }),
              ),
            ];
          case "message":
            return handleMessage(message);
        }
      };
      if (!(await admitAutoReplyTurn(message))) return [];
      const replies =
        message.actor.chatType === "group" && message.actor.threadId && commandType === "message"
          ? await receiveTopicMessage(message)
          : await enqueueInboundProcessing(message.actor, processInbound, isGroupControl);
      if (message.actor.chatType !== "group") return replies;
      const current = (await repo.readState()).bots[getBotConversationKey(message.actor)];
      return replies.map((reply) =>
        reply.selection && current?.group?.authorizationId
          ? {
              ...reply,
              threadId: message.actor.threadId ?? current.group.threadId,
              rootMessageId: message.actor.rootMessageId ?? current.group.rootMessageId,
              groupCard: groupCardFor(message.actor, current),
            }
          : reply,
      );
    },
    async handleProviderCallback(provider: BotProvider, payload: unknown) {
      return (await processProviderCallback(provider, payload)).replies;
    },
    async handleProviderCallbackResponse(provider: BotProvider, payload: unknown) {
      return processProviderCallback(provider, payload);
    },
    disposeAll() {
      void service.disposeAllAndWait().catch((error: unknown) => {
        botsLogger.warn(
          undefined,
          `dispose Bot runtimes failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    },
    disposeAllAndWait() {
      if (shutdownPromise) {
        return shutdownPromise;
      }
      memoryDiagnostics.dispose();
      // 材料下载可能晚于 Host 关闭返回；先同步失效，再回收上传侧的取消代次。
      topicPreparation.clear();
      const pendingTopicKeys = [...topicContinuations.keys()];
      for (const key of pendingTopicKeys) {
        topicGenerations.set(key, (topicGenerations.get(key) ?? 0) + 1);
        topicContinuations.get(key)?.cancel();
        for (const resolve of topicReplies.get(key)?.values() ?? []) resolve([]);
        topicReplies.get(key)?.clear();
      }
      const cancelUploads = (async () => {
        const states = (await repo.readState()).bots;
        await Promise.all(
          pendingTopicKeys.map(async (key) => {
            const context = states[key];
            if (!context?.activeTaskId) return;
            const taskService = await resolveZCodeTaskServiceForContext(context);
            await taskService.invalidateBotTopicInputs?.({
              taskId: context.activeTaskId,
              workspacePath: context.workspacePath,
              workspaceIdentity: context.workspaceIdentity,
            });
          }),
        );
      })();
      for (const controller of streamingCardRequestControllers) {
        controller.abort(new Error("Bot service disposed."));
      }
      streamingCardRequestControllers.clear();
      for (const subscription of streamSubscriptions.values()) {
        subscription.dispose();
      }
      streamSubscriptions.clear();
      taskStreamHub.dispose();
      if (privateRecoveryTimer) clearInterval(privateRecoveryTimer);
      privateImTraces.clear();
      privateWatches.clear();
      failedPrivateDeliveries.clear();
      transientInteractionCards.clear();
      adminAttention.clear();
      for (const intervalId of typingIntervals.values()) {
        clearInterval(intervalId);
      }
      typingIntervals.clear();
      for (const [taskId] of typingTargets) {
        stopTyping(taskId);
      }
      runningTasks.clear();
      liveStatusProgressByTaskId.clear();
      pendingRemoteReconnectsByKey.clear();
      recentRemoteReconnectAtByKey.clear();
      recentRemoteReconnectDeliveryAtByKey.clear();
      recentInboundDeliveryAtByKey.clear();
      automationDeliveryWarningAtByKey.clear();
      inboundProcessingQueuesByContext.clear();
      // Bugfix：host 的异步资源回收会优先调用 disposeAllAndWait。保留统一 Promise，确保并发关闭
      // 只执行一次，并在返回前等三类 Provider runtime 的请求、WebSocket 和跨进程锁全部收口。
      shutdownPromise = Promise.allSettled([
        cancelUploads,
        telegramRuntime.dispose(),
        weixinRuntime.dispose(),
        feishuRuntime.dispose(),
      ]).then(() => undefined);
      return shutdownPromise;
    },
  };
  if (runStartupBackgroundTasks) {
    // 远端连接没有 Bot 专属事件源；只检查已存在的连接，不建立额外连接或重放历史。
    privateRecoveryTimer = setInterval(() => {
      if (shutdownPromise || privateRecoveryPending) return;
      privateRecoveryPending = true;
      void repo
        .readState()
        .then(async (state) => {
          for (const context of Object.values(state.bots))
            if (!context.group) await reconcilePrivateSynchronization(context.botId);
        })
        .catch(() => botsLogger.warn(undefined, "Private Bot recovery state unavailable"))
        .finally(() => {
          privateRecoveryPending = false;
        });
    }, 10_000);
    privateRecoveryTimer.unref();
    void telegramRuntime.refresh();
    void weixinRuntime.refresh();
    void feishuRuntime.refresh();
    void ensureBotStorageMigrated()
      .then(async () => {
        for (const context of Object.values((await repo.readState()).bots)) {
          await restoreGroupSynchronization(context);
          if (!context.group) await reconcilePrivateSynchronization(context.botId);
        }
      })
      .catch((error: unknown) => {
        // 首次读取失败必须可见，不能产生未处理 rejection；交互入口仍直接收到该错误。
        botsLogger.error(
          undefined,
          `Bot storage initialization failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }
  return service;
}
