import { formatBotInputClientId, isAuxiliarySessionKind } from "@zcode/shared";
import { createBotTopicAdmission } from "#src/zcode-agent/botTopicAdmission.js";
import {
  readBotGroupRuntimeSnapshot,
  waitBotGroupExecutionEnd,
} from "#src/zcode-agent/groupRuntimeSnapshot.js";
import { uploadBotGroupAttachments } from "./groupAttachmentUpload.js";
/* oxlint-disable eslint(max-lines) -- 迁移期需要在一个门面里集中维护旧 task projection 到 ZCode session 的协议适配。 */
import { createHash, randomUUID } from "node:crypto";
import { createZCodeAgentConnectionScope } from "#src/zcode-agent/zcodeAgentConnectionScope.js";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  Emitter,
  Event,
  emitNetworkTelemetryObservation,
  type NetworkObservation,
} from "@zcode/rpc";
import {
  coalesceConsecutiveZCodeAssistants,
  createSessionTraceId,
  decodeCustomModelValue,
  deriveZCodeTaskStatusFromSessionSnapshot,
  extractPlanStepsFromToolInput,
  extractPlanStepsFromToolOutput,
  generateTraceId,
  getZCodeGoalActiveIterationCount,
  getZCodeGoalIterationByAssistantMessageId,
  getZCodeUserVisibleMessages,
  isMainAgentToolProjectionSource,
  normalizeZCodeApiRetryStatus,
  attachZCodeBackgroundTaskNotificationToRaw,
  collectZCodeBackgroundTaskNotificationsByToolUseId,
  mergeZCodeBackgroundTaskControlItems,
  parseZCodeBackgroundTaskControlItems,
  parseZCodeBackgroundTaskNotifications,
  parseModelPickerValue as parseSharedModelSelection,
  resolveWorkspaceKey,
  resolveZCodeVisibleSessionTitle,
  textFromZCodeMessageParts,
  ZCODE_AGENT_PROVIDER,
  zcodeBackgroundTaskNotificationFailureText,
  zcodeBackgroundTaskNotificationToolUpdateStatus,
  appendZCodeStreamingToolInputDelta,
  buildZCodeStreamingToolInputPreview,
  createZCodeToolProjectionMemory,
  finalizeZCodeToolProjectionInput,
  forgetZCodeToolProjectionMetadata,
  isZCodeModelRetryRecoveryProgressPayload,
  markZCodeStreamingToolInputPreviewMaterialized,
  resolveZCodeToolProjectionMetadata,
  zcodeApiRetryFromModelNetworkStatusPayload,
  zcodeApiRetryFromStreamRecoveryPayload,
  zcodeTaskNetworkDebugStatusFromPayload,
  shouldMaterializeZCodeStreamingToolInputPreview,
  type ZCodeApiRetryStatus,
  type ZCodeAssistantMessageFeedback,
  type ZCodeBackgroundTaskNotificationInfo,
  type ZCodeBackgroundTaskControlItem,
  type ZCodeBackgroundTurnAttribution,
  type ZCodeAutomationBotDeliveryTarget,
  type ZCodeCancelTaskCommandResult,
  type ZCodeCodexConnectivityCheckResult,
  type ZCodeConfigOption,
  type ZCodeEnqueueTaskCommandResult,
  type ZCodeError,
  type ZCodeGoalVerificationTimelineMeta,
  type ZCodeImportSessionsResult,
  type ZCodeImportableSessionCandidate,
  type ZCodeUsage,
  type ZCodePersistedMessage,
  type ZCodePersistedMessagePart,
  type ZCodePersistedToolCall,
  type ZCodePromptAttachment,
  type ZCodeProvider,
  type ZCodeSessionFile,
  type ZCodeTaskGoal,
  type ZCodeTaskGoalStats,
  type ZCodeTaskMode,
  type ZCodePlanStep,
  type ZCodeSlashCommand,
  type ZCodeStreamEvent,
  type ZCodeSwitchAgentResult,
  type ZCodeSyncTaskSessionBindingResult,
  type ZCodeTaskCreateResult,
  type ZCodeTaskMeta,
  type ZCodeTaskClientMode,
  type ZCodeTaskRuntimeCommand,
  type ZCodeTaskSnapshot,
  type ZCodeTaskSnapshotBody,
  type ZCodeTaskSnapshotRefContent,
  type ZCodeTaskSnapshotToolCallsSlice,
  type ZCodeTaskTokenUsageResult,
  type ZCodeTodoGroup,
  type ZCodeTurnSteerCommandKind,
  type ZCodeTurnSteerSource,
  type ZCodeWorkspaceEvent,
  type ZCodeWorkspaceTaskListChanged,
  type InputId,
  type TraceId,
  zcodeContextUsageBreakdownSchema,
  zcodeSessionSettingsStateSchema,
  type ZCodeDeliveryKind,
  type ZCodeMessagePart,
  type ZCodeMessageWithParts,
  type ModelSelection,
  type ZCodePermissionOption,
  type ZCodePermissionRequestParams,
  type ZCodePermissionRequest,
  type ZCodeSessionEvent,
  type ZCodeSessionMode,
  type ZCodeSessionSettingsState,
  type ZCodeSessionStateSnapshot,
  type ZCodeStateUpdatedNotification,
  type ZCodeContextCompactionTimelineMeta,
  type ZCodeTimelineMeta,
  type ZCodeTimelineStatus,
  type ZCodeTimelineTrigger,
  type ZCodeToolProjectionMemory,
  type ZCodeUserInputRequestParams,
  type ZCodeUserInputResponse,
  type ZCodeAgentMcpServer,
} from "@zcode/shared";
import type {
  ZCodeTaskListQuery,
  ZCodeTaskListResult,
  ZCodeWorkspaceEventSubscriptionParams,
  IZCodeTaskService,
  ZCodeArchivedTaskDeletionResult,
  ZCodeTaskReadyOutcome,
  ZCodeTaskTerminalOutcome,
} from "../session/zcodeTaskService.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import {
  AUTOMATION_MUTATION_TOOL_NAMES,
  OFF_PEAK_MUTATION_TOOL_NAMES,
} from "#src/zcode-agent/automationToolPolicy.js";
import type { ISettingService } from "#src/setting/setting.js";
import type {
  SessionMessageDeliveryResult,
  SessionMessageSendRequested,
} from "#src/session/sessionMailbox.js";
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";
import type {
  IZCodeAgentService,
  ZCodeAgentServiceEvent,
  ZCodeAgentWorkspaceTarget,
} from "./zcodeAgent.js";
import type {
  ZCodeTaskIndexReadyEvent,
  ZCodeTaskIndexSyncer,
  ZCodeTaskIndexTerminalEvent,
} from "./zcodeTaskIndexSyncer.js";
import { readModelTrajectory } from "./modelTrajectory.js";
import {
  errorAttributionSchema,
  type CommandAck,
  type CommandPayloadMap,
} from "@zcode/shared/zcode-protocol-v4";
import {
  assertV4CommandAckOk,
  createHostCommandEnvelope,
  sendHostCasCommandV4,
} from "./zcodeV4HostCommand.js";
import {
  getLegacyDeletedTaskSessionSnapshotPath,
  getLegacyTaskSessionSnapshotPath,
} from "#src/paths.js";
import { claudeNativeSessionImportRepo } from "#src/session/claude-native/claudeNativeSessionImportRepo.js";
import { importClaudeNativeSessions } from "#src/session/claude-native/claudeNativeSessionImportService.js";
import { repairImportedClaudeSessionSnapshot } from "#src/session/claude-native/importedClaudeHistoryRepair.js";
import { safeParseLegacyTaskSessionFile } from "#src/session/legacyTaskSessionFile.js";
import {
  MODEL_CONFIG_ID,
  MODE_CONFIG_ID,
  THOUGHT_LEVEL_CONFIG_ID,
  formatTaskMetaModelSelectionFromSnapshot,
  formatModelPickerValue,
  getZCodeAgentAvailableModes,
  normalizeAvailableZCodeMode,
  settingsToConfigOptions,
} from "./zcodeConfigOptions.js";
import type { CuaProductMcpServerResolver } from "#src/cua-permission-broker/index.js";
import { registerMemoryDiagnosticsProvider } from "#src/memoryDiagnostics.js";

interface CreateZCodeTaskServiceAdapterOptions {
  zcodeAgentService: IZCodeAgentService;
  taskIndexRepo?: TaskIndexRepo;
  // syncer 现在持有 workspace emitter 和 broadcast 入口，adapter 必须共用同一实例，
  // 否则 desktop-continuous 路径和 task adapter 路径的事件订阅会分裂成两份，UI 收不全。
  taskIndexSyncer: ZCodeTaskIndexSyncer;
  settingService?: Pick<ISettingService, "get">;
  cuaProductMcpServerResolver?: CuaProductMcpServerResolver;
}

interface TaskTarget {
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  cronAutomationId?: string;
  remoteSessionId?: string;
}

interface TaskTargetWithMcpServers extends TaskTarget {
  additionalDirectories?: string[];
  model?: string;
  thoughtLevel?: string;
  mcpServers?: ZCodeAgentMcpServer[];
  toolDenylist?: string[];
}

type WorkspaceEventInput = string | ZCodeWorkspaceEventSubscriptionParams;
type ZCodeSendPromptRuntimeCommand = Extract<ZCodeTaskRuntimeCommand, { type: "send_prompt" }>;
type ZCodeTerminalStreamEvent =
  | Extract<ZCodeStreamEvent, { type: "task_complete" }>
  | Extract<ZCodeStreamEvent, { type: "task_error" }>;

const GLM_PROVIDER: ZCodeProvider = ZCODE_AGENT_PROVIDER;
const EMPTY_SLASH_COMMANDS: ZCodeSlashCommand[] = [];
const logger = createServiceLogger("zcode-task-service");
const ASK_USER_QUESTION_TOOL_NAME = "AskUserQuestion";
const EXIT_PLAN_MODE_TOOL_NAME = "ExitPlanMode";
const EXIT_PLAN_MODE_APPROVAL_QUESTION = "Review this implementation plan.";
const EXIT_PLAN_MODE_APPROVAL_APPROVE = "approve";

const MAX_LIVE_TOOL_PROJECTION_TASKS = 128;
const MAX_LIVE_TOOL_PROJECTION_TOOLS_PER_TASK = 2000;

interface LiveToolProjection {
  order: number;
  parentToolUseId: string | null;
  tool: ZCodePersistedToolCall;
  toolId: string;
}

function padDatePart(value: number): string {
  return value.toString().padStart(2, "0");
}

function formatZCodeAgentLogDate(now: Date): string {
  return [now.getFullYear(), padDatePart(now.getMonth() + 1), padDatePart(now.getDate())].join("-");
}

function resolveZCodeAgentCurrentLogFilePath(now = new Date()): string {
  const configuredLogDir = process.env.ZCODE_LOG_DIR?.trim();
  const logDir = configuredLogDir || join(homedir(), ".zcode", "cli", "log");
  return join(logDir, `zcode-${formatZCodeAgentLogDate(now)}.jsonl`);
}

export function createZCodeTaskServiceAdapter(
  options: CreateZCodeTaskServiceAdapterOptions,
): IZCodeTaskService {
  // Bot 原来绕过连接 facade，导致真实附件 admission 缺少可信身份；复用既有 scope，
  // 同一 Bot 接入的附件、命令及对账共用连接，不改变桌面与手机各自的传输模式。
  const botConnectionScopes = new Map<string, ReturnType<typeof createZCodeAgentConnectionScope>>();
  function botAgent(workspace: ZCodeAgentWorkspaceTarget) {
    const key = JSON.stringify([resolveWorkspaceKey(workspace), workspace.remoteSessionId ?? ""]);
    let scope = botConnectionScopes.get(key);
    if (!scope) {
      scope = createZCodeAgentConnectionScope(options.zcodeAgentService, {
        connectionId: `bot-${randomUUID()}`,
        clientMode: "desktop-continuous",
        role: "trusted-host-relay",
      });
      botConnectionScopes.set(key, scope);
    }
    return scope.service;
  }
  const errorEmitter = new Emitter<ZCodeError>();
  const taskEmitters = new Map<string, Emitter<ZCodeStreamEvent>>();
  const globalTaskEmitters = new Map<string, Emitter<ZCodeStreamEvent>>();
  const taskTargets = new Map<string, TaskTarget>();
  const topicAdmission = createBotTopicAdmission();
  const runtimeCommands = new Map<string, ZCodeTaskRuntimeCommand[]>();
  const runtimeCommandDrains = new Map<string, Promise<void>>();
  const apiRetryByTaskKey = new Map<string, ZCodeApiRetryStatus | null>();
  const backgroundTaskControlsByTaskKey = new Map<string, ZCodeBackgroundTaskControlItem[]>();
  const streamedTurnText = new Map<string, { messageId?: string; text: string }>();
  const activePromptInputIds = new Map<string, InputId>();
  const toolProjectionMemoryByTaskKey = new Map<string, ZCodeToolProjectionMemory>();
  const liveToolProjectionsByTaskKey = new Map<string, Map<string, LiveToolProjection>>();
  let liveToolProjectionOrder = 0;
  const legacySnapshotTaskKeys = new Set<string>();
  // 内存诊断计数器（docs/monitoring/memory-diagnostics-log.md）：对应审计里 deleteTask
  // 不清理的 per-task 表，只读 size。
  const memoryDiagnostics = registerMemoryDiagnosticsProvider("task", () => ({
    runtimeCommands: runtimeCommands.size,
    toolMemoryTasks: toolProjectionMemoryByTaskKey.size,
    taskEmitters: taskEmitters.size,
  }));
  const taskIndexRepo = options.taskIndexRepo ?? new TaskIndexRepo();
  const taskIndexSyncer = options.taskIndexSyncer;

  // 之前 adapter 自带 notifySyncerSession 时把 syncer 视为可选；现在 syncer 是构造必填项，
  // 简化为直接调用，避免每个 callsite 都做空判断。
  function notifySyncerSession(target: TaskTarget): void {
    taskIndexSyncer.ensureSessionSubscription({
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      sessionId: target.taskId,
    });
  }

  function unsupported(name: string): never {
    throw Object.assign(
      new Error(`ZCode task service adapter does not support IZCodeTaskService.${name} yet.`),
      {
        code: "ZCODE_AGENT_UNSUPPORTED_LEGACY_TASK_METHOD",
      },
    );
  }

  function resolvePromptToolDenylist(params: {
    automationId?: string;
    offPeakTaskId?: string;
    toolDenylist?: string[];
  }): string[] | undefined {
    const toolDenylist = new Set(params.toolDenylist);
    // 持久化的 cronAutomationId 不能当成当前 turn 的执行身份，否则定时任务
    // 跑过一次后，用户在同一会话主动修改调度也永久看不到 CronUpdate。权限必须只看本轮
    // automationId；cronAutomationId 仅保留任务归属和 UI 展示语义。
    if (params.automationId) {
      for (const toolName of AUTOMATION_MUTATION_TOOL_NAMES) {
        toolDenylist.add(toolName);
      }
    }
    // 闲时派发轮纵深隐藏 OffPeakCreate；不与 automation 分支合并（cron 轮放行）。
    if (params.offPeakTaskId) {
      for (const toolName of OFF_PEAK_MUTATION_TOOL_NAMES) {
        toolDenylist.add(toolName);
      }
    }
    return toolDenylist.size > 0 ? [...toolDenylist] : undefined;
  }

  function turnAttributionOf(
    params: ZCodeBackgroundTurnAttribution,
  ): ZCodeBackgroundTurnAttribution {
    if (params.automationId) return { automationId: params.automationId };
    if (params.offPeakTaskId) {
      return {
        offPeakTaskId: params.offPeakTaskId,
        ...(params.offPeakRunType ? { offPeakRunType: params.offPeakRunType } : {}),
      };
    }
    return {};
  }

  async function resolveProductMcpServers(
    servers: ZCodeAgentMcpServer[] | undefined,
  ): Promise<ZCodeAgentMcpServer[] | undefined> {
    const configuredServers = (servers?.length ?? 0) > 0 ? servers : undefined;
    if (!configuredServers || !options.cuaProductMcpServerResolver) {
      return configuredServers;
    }
    return options.cuaProductMcpServerResolver.resolveMcpServers(configuredServers);
  }

  function workspaceKey(params: { workspacePath: string; workspaceIdentity?: string }): string {
    return resolveWorkspaceKey(params);
  }

  function taskKey(params: { workspacePath: string; workspaceIdentity?: string; taskId: string }) {
    return `${workspaceKey(params)}\u0000${params.taskId}`;
  }

  function createTaskOwnerCommandError(
    message: string,
    code: "NO_ACTIVE_TASK_OWNER" | "STALE_TASK_OWNER_COMMAND",
  ): Error & { code: "NO_ACTIVE_TASK_OWNER" | "STALE_TASK_OWNER_COMMAND" } {
    return Object.assign(new Error(message), { code });
  }

  function assertCurrentOwnerRun(params: TaskTarget, ownerRunId: TraceId | undefined): void {
    if (!ownerRunId) {
      return;
    }
    const key = taskKey(params);
    const activeRunId = activePromptInputIds.get(key);
    if (!activeRunId) {
      // 手机端 owner command 到达 host 时，task 可能已经终态收口。
      // 没有 active run 时不能再把旧 command 写入 host 队列，否则会在桌面 shared host 上误发旧输入。
      throw createTaskOwnerCommandError("No active task owner.", "NO_ACTIVE_TASK_OWNER");
    }
    if (activeRunId !== ownerRunId) {
      // ownerRunId 是远控请求的 stale 防护边界。
      // 旧 run 的 enqueue/promote 不能修改当前 task command queue。
      throw createTaskOwnerCommandError("Stale task owner command.", "STALE_TASK_OWNER_COMMAND");
    }
  }

  async function sendPromptToAgent(
    target: TaskTarget,
    params: {
      traceId: TraceId;
      queryId?: string;
      messageId?: string;
      content: string;
      attachments?: ZCodePromptAttachment[];
      toolDenylist?: string[];
      botDeliveryTarget?: ZCodeAutomationBotDeliveryTarget;
      clientId?: string;
      clientMode?: ZCodeTaskClientMode;
      logReason?: string;
      modelSelection?: CommandPayloadMap["sendText"]["modelSelection"];
      modelSelectionBasis?: CommandPayloadMap["sendText"]["modelSelectionBasis"];
      modelExecution?: CommandPayloadMap["sendText"]["modelExecution"];
    } & ZCodeBackgroundTurnAttribution,
  ): Promise<CommandAck | undefined> {
    const startedAt = Date.now();
    notifySyncerSession(target);
    // live tool projection 只用于当前运行的终态收口。
    // 新输入开始时必须清掉上一轮 live-only 子工具，避免后续 snapshot 把旧工具补到新回复尾部。
    clearLiveToolProjection(target);
    clearStreamingToolInputCache(target);
    // ZCode task wrapper 的字段仍叫 traceId，但这里语义已经是单次输入 inputId。
    // 先记录 inputId，后续 ZCode session 事件回投 ZCode Agent 时才能让 UI 终态按输入轮次收口。
    activePromptInputIds.set(taskKey(target), params.traceId);
    logger.info(params.traceId, "ZCode task facade sendPrompt 开始", {
      attachmentCount: params.attachments?.length ?? 0,
      queryId: params.queryId ?? null,
      reason: params.logReason ?? "direct",
      taskId: target.taskId,
      textLength: params.content.length,
      workspaceIdentity: target.workspaceIdentity ?? null,
      workspaceKey: resolveWorkspaceKey(target),
      workspacePath: target.workspacePath,
    });
    try {
      const promptToolDenylist = resolvePromptToolDenylist(params);
      // 附件旧路径没有 v4 ACK，保持 undefined。
      let ack: CommandAck | undefined;
      if (params.attachments?.length) {
        // 遗留（附件命令面）：v4 sendText 的 attachments 是 attachmentRef 引用模型，
        // 上传/寄存命令面尚未建模（CLI 侧 fork-edit-retry.ts 同款裁决“附件命令面后续”）。
        // 带附件输入保留旧 session/send，避免手机 replayable 图片/文件输入回归；
        // 过渡归宿 = v4 附件命令面（届时由 v4 sendText 承接）。
        await options.zcodeAgentService.sendPrompt({
          workspacePath: target.workspacePath,
          workspaceIdentity: target.workspaceIdentity,
          ...(target.remoteSessionId ? { remoteSessionId: target.remoteSessionId } : {}),
          sessionId: target.taskId,
          inputId: params.traceId,
          queryId: params.queryId,
          messageId: params.messageId,
          content: params.content,
          attachments: params.attachments.map((attachment) => ({
            ...attachment,
          })),
          // 附件回退只改变载荷传输，不得丢掉本次已解析的模型或执行范围。
          modelSelection: params.modelSelection,
          modelSelectionBasis: params.modelSelectionBasis,
          modelExecution: params.modelExecution,
          ...turnAttributionOf(params),
          toolDenylist: promptToolDenylist,
          botDeliveryTarget: params.botDeliveryTarget,
          ...(params.clientMode ? { clientMode: params.clientMode } : {}),
        });
      } else {
        // send 主路径收敛 v4 sendText。幂等键 inputId→commandId 对齐：
        // CLI 侧以 commandId 为 inputId 起 turn，终态事件 inputId 才能与 host command
        // queue 的 traceId 对账（completeRuntimeCommandByInputId 语义不变）。
        // heldQueueDisposition=keepQueueAndSend：旧 session/send 没有 held choice 闸门，
        // replayable 无人机交互路径按“立即发送、不动队列”等价老语义。
        const sendAck = await options.zcodeAgentService.sendConversationCommandV4({
          workspacePath: target.workspacePath,
          workspaceIdentity: target.workspaceIdentity,
          ...(target.remoteSessionId ? { remoteSessionId: target.remoteSessionId } : {}),
          ...(params.clientMode ? { clientMode: params.clientMode } : {}),
          envelope: createHostCommandEnvelope({
            type: "sendText",
            payload: {
              text: params.content,
              heldQueueDisposition: "keepQueueAndSend",
              ...(params.modelSelection ? { modelSelection: params.modelSelection } : {}),
              ...(params.modelSelectionBasis
                ? { modelSelectionBasis: params.modelSelectionBasis }
                : {}),
              ...(params.modelExecution ? { modelExecution: params.modelExecution } : {}),
              ...turnAttributionOf(params),
              ...(params.botDeliveryTarget ? { botDeliveryTarget: params.botDeliveryTarget } : {}),
              ...(promptToolDenylist ? { toolDisallowlist: promptToolDenylist } : {}),
            },
            sessionId: target.taskId,
            commandId: params.traceId,
            clientId: params.clientId,
          }),
        });
        // 调用方需要区分 accepted 与 duplicate：duplicate 不会开新一轮，也没有终态事件。
        ack = assertV4CommandAckOk("sendText", sendAck, `session=${target.taskId}`);
      }
      logger.info(params.traceId, "ZCode task facade sendPrompt ACK", {
        ackStatus: ack?.status ?? null,
        durationMs: Date.now() - startedAt,
        queryId: params.queryId ?? null,
        reason: params.logReason ?? "direct",
        taskId: target.taskId,
        workspaceIdentity: target.workspaceIdentity ?? null,
        workspaceKey: resolveWorkspaceKey(target),
        workspacePath: target.workspacePath,
      });
      return ack;
    } catch (error) {
      activePromptInputIds.delete(taskKey(target));
      logger.warn(params.traceId, "ZCode task facade sendPrompt 失败", {
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
        queryId: params.queryId ?? null,
        reason: params.logReason ?? "direct",
        taskId: target.taskId,
        workspaceIdentity: target.workspaceIdentity ?? null,
        workspaceKey: resolveWorkspaceKey(target),
        workspacePath: target.workspacePath,
      });
      throw error;
    }
  }

  function setRuntimeCommands(params: TaskTarget, commands: ZCodeTaskRuntimeCommand[]): void {
    const key = taskKey(params);
    if (commands.length === 0) {
      runtimeCommands.delete(key);
      return;
    }
    runtimeCommands.set(key, commands);
  }

  function markRuntimeCommandRunning(
    params: TaskTarget,
    command: ZCodeSendPromptRuntimeCommand,
  ): ZCodeSendPromptRuntimeCommand {
    const key = taskKey(params);
    const runningCommand: ZCodeSendPromptRuntimeCommand = {
      ...command,
      status: "running",
      updatedAt: Date.now(),
    };
    runtimeCommands.set(
      key,
      (runtimeCommands.get(key) ?? []).map((item) =>
        item.commandId === command.commandId ? runningCommand : item,
      ),
    );
    return runningCommand;
  }

  function markRuntimeCommandFailed(
    params: TaskTarget,
    command: ZCodeSendPromptRuntimeCommand,
    error: unknown,
  ): void {
    const key = taskKey(params);
    const failedCommand: ZCodeSendPromptRuntimeCommand = {
      ...command,
      status: "failed",
      updatedAt: Date.now(),
      error: error instanceof Error ? error.message : String(error),
    };
    runtimeCommands.set(
      key,
      (runtimeCommands.get(key) ?? []).map((item) =>
        item.commandId === command.commandId ? failedCommand : item,
      ),
    );
  }

  function removeRuntimeCommand(params: TaskTarget, commandId: string): void {
    setRuntimeCommands(
      params,
      (runtimeCommands.get(taskKey(params)) ?? []).filter(
        (command) => command.commandId !== commandId,
      ),
    );
  }

  function emitRuntimeCommandSnapshotUpdated(params: TaskTarget, traceId?: TraceId): void {
    emitTaskEvent(params, {
      type: "task_snapshot_updated",
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      workspaceKey: workspaceKey(params),
      taskId: params.taskId,
      traceId: traceId ?? generateTraceId(params.taskId),
      reason: "task_status_changed",
    });
  }

  function completeRuntimeCommandByInputId(
    params: TaskTarget,
    terminalInputId: string | undefined,
    terminalType: string,
  ): void {
    if (!terminalInputId) {
      return;
    }
    const command = (runtimeCommands.get(taskKey(params)) ?? []).find(
      (candidate) =>
        candidate.type === "send_prompt" &&
        candidate.status === "running" &&
        candidate.traceId === terminalInputId,
    );
    if (!command) {
      return;
    }
    // 手机 host command 在 sendPrompt ACK 后仍要保持 running，
    // 否则手机刷新拿不到“已开始发送”的 pendingCommands。只有真实终态到达后才能从 host 队列移除。
    removeRuntimeCommand(params, command.commandId);
    logger.info(command.traceId, "ZCode task command 终态收口", {
      commandId: command.commandId,
      terminalType,
      taskId: params.taskId,
      workspaceIdentity: params.workspaceIdentity ?? null,
      workspaceKey: resolveWorkspaceKey(params),
      workspacePath: params.workspacePath,
    });
  }

  function completeRuntimeCommandForTerminalEvent(
    params: TaskTarget,
    event: ZCodeTerminalStreamEvent,
  ): void {
    completeRuntimeCommandByInputId(params, event.inputId ?? event.traceId, event.type);
  }

  async function drainRuntimeCommands(params: TaskTarget, reason: string): Promise<void> {
    const key = taskKey(params);
    if (activePromptInputIds.has(key)) {
      return;
    }
    const commands = runtimeCommands.get(key) ?? [];
    if (commands.some((command) => command.status === "running")) {
      return;
    }
    const command = commands.find(
      (candidate): candidate is ZCodeSendPromptRuntimeCommand =>
        candidate.type === "send_prompt" && candidate.status === "accepted",
    );
    if (!command) {
      return;
    }

    const runningCommand = markRuntimeCommandRunning(params, command);
    logger.info(runningCommand.traceId, "ZCode task command drain 开始", {
      commandId: runningCommand.commandId,
      queryId: runningCommand.queryId ?? null,
      reason,
      taskId: params.taskId,
      workspaceIdentity: params.workspaceIdentity ?? null,
      workspaceKey: resolveWorkspaceKey(params),
      workspacePath: params.workspacePath,
    });
    try {
      await sendPromptToAgent(params, {
        traceId: runningCommand.traceId,
        queryId: runningCommand.queryId,
        messageId: runningCommand.commandId,
        content: runningCommand.content,
        attachments: runningCommand.attachments,
        ...turnAttributionOf(
          runningCommand.automationId ? { automationId: runningCommand.automationId } : {},
        ),
        // v4 sendText 信封保留手机提交端 clientId（pendingCommands 展示与幂等表按提交端区分）。
        clientId: runningCommand.clientId,
        logReason: "host-command-drain",
      });
    } catch (error) {
      markRuntimeCommandFailed(params, runningCommand, error);
      logger.warn(runningCommand.traceId, "ZCode task command drain 失败", {
        commandId: runningCommand.commandId,
        error: error instanceof Error ? error.message : String(error),
        reason,
        taskId: params.taskId,
        workspaceIdentity: params.workspaceIdentity ?? null,
        workspaceKey: resolveWorkspaceKey(params),
        workspacePath: params.workspacePath,
      });
    }
  }

  async function drainRuntimeCommandsSafely(params: TaskTarget, reason: string): Promise<void> {
    try {
      await drainRuntimeCommands(params, reason);
    } catch (error) {
      logger.warn(undefined, "ZCode task command drain 调度失败", {
        error: error instanceof Error ? error.message : String(error),
        reason,
        taskId: params.taskId,
        workspaceIdentity: params.workspaceIdentity ?? null,
        workspaceKey: resolveWorkspaceKey(params),
        workspacePath: params.workspacePath,
      });
    }
  }

  function scheduleRuntimeCommandDrain(params: TaskTarget, reason: string): void {
    const key = taskKey(params);
    const existingDrain = runtimeCommandDrains.get(key);
    if (existingDrain) {
      const nextDrainPromise = existingDrain
        .finally(() => drainRuntimeCommandsSafely(params, reason))
        .finally(() => {
          if (runtimeCommandDrains.get(key) === nextDrainPromise) {
            runtimeCommandDrains.delete(key);
          }
        });
      runtimeCommandDrains.set(key, nextDrainPromise);
      return;
    }
    const drainPromise = (async () => {
      await drainRuntimeCommandsSafely(params, reason);
    })().finally(() => {
      if (runtimeCommandDrains.get(key) === drainPromise) {
        runtimeCommandDrains.delete(key);
      }
    });
    runtimeCommandDrains.set(key, drainPromise);
  }

  function getLiveToolProjectionMap(params: TaskTarget): Map<string, LiveToolProjection> {
    const key = taskKey(params);
    let projection = liveToolProjectionsByTaskKey.get(key);
    if (!projection) {
      projection = new Map<string, LiveToolProjection>();
      liveToolProjectionsByTaskKey.set(key, projection);
      while (liveToolProjectionsByTaskKey.size > MAX_LIVE_TOOL_PROJECTION_TASKS) {
        const oldestKey = liveToolProjectionsByTaskKey.keys().next().value;
        if (typeof oldestKey !== "string") break;
        liveToolProjectionsByTaskKey.delete(oldestKey);
      }
    }
    return projection;
  }

  function trimLiveToolProjectionMap(projection: Map<string, LiveToolProjection>): void {
    while (projection.size > MAX_LIVE_TOOL_PROJECTION_TOOLS_PER_TASK) {
      let oldestKey: string | undefined;
      let oldestOrder = Number.POSITIVE_INFINITY;
      for (const [toolId, item] of projection) {
        if (item.order < oldestOrder) {
          oldestOrder = item.order;
          oldestKey = toolId;
        }
      }
      if (!oldestKey) return;
      projection.delete(oldestKey);
    }
  }

  function clearLiveToolProjection(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): void {
    liveToolProjectionsByTaskKey.delete(taskKey(params));
  }

  function normalizeLiveToolRaw(
    raw: unknown,
    toolId: string,
    parentToolUseId: string | null | undefined,
  ): unknown {
    const rawRecord = asRecord(raw);
    const rawBase =
      Object.keys(rawRecord).length > 0 ? rawRecord : raw === undefined ? {} : { raw };
    const parentFromRaw =
      stringValue(rawRecord.parentToolUseId) ??
      stringValue(rawRecord.parentToolCallId) ??
      parentToolUseId ??
      null;
    return {
      ...rawBase,
      toolCallId: stringValue(rawRecord.toolCallId) ?? toolId,
      ...(parentFromRaw
        ? {
            parentToolCallId: stringValue(rawRecord.parentToolCallId) ?? parentFromRaw,
          }
        : {}),
    };
  }

  function persistedStatusFromToolUpdate(
    status: Extract<ZCodeStreamEvent, { type: "tool_call_update" }>["status"],
  ): ZCodePersistedToolCall["status"] | undefined {
    return status === "completed" ||
      status === "failed" ||
      status === "denied" ||
      status === "stopped"
      ? status
      : undefined;
  }

  function rememberLiveToolProjection(params: TaskTarget, event: ZCodeStreamEvent): void {
    if (event.type !== "tool_call" && event.type !== "tool_call_update") {
      return;
    }

    const projection = getLiveToolProjectionMap(params);
    const existing = projection.get(event.toolId);
    const parentToolUseId = event.parentToolUseId ?? existing?.parentToolUseId ?? null;
    const raw = normalizeLiveToolRaw(event.raw, event.toolId, parentToolUseId);
    const nextTool: ZCodePersistedToolCall =
      event.type === "tool_call"
        ? {
            ...existing?.tool,
            toolName: event.toolName ?? existing?.tool.toolName,
            title: event.title ?? existing?.tool.title ?? event.toolName,
            kind: event.kind ?? existing?.tool.kind ?? event.toolName,
            input: event.input,
            raw,
          }
        : {
            ...existing?.tool,
            toolName: event.toolName ?? existing?.tool.toolName,
            title: event.title ?? existing?.tool.title ?? event.toolName ?? event.kind,
            kind: event.kind ?? existing?.tool.kind ?? event.toolName ?? existing?.tool.toolName,
            input: event.input !== undefined ? event.input : existing?.tool.input,
            output: event.content !== undefined ? event.content : existing?.tool.output,
            error: event.error ?? existing?.tool.error,
            raw,
            status: persistedStatusFromToolUpdate(event.status) ?? existing?.tool.status,
          };
    projection.set(event.toolId, {
      order: existing?.order ?? ++liveToolProjectionOrder,
      parentToolUseId,
      tool: nextTool,
      toolId: event.toolId,
    });
    trimLiveToolProjectionMap(projection);
  }

  function persistedToolId(tool: ZCodePersistedToolCall): string | undefined {
    return stringValue(asRecord(tool.raw).toolCallId);
  }

  function mergeToolRaw(snapshotRaw: unknown, liveRaw: unknown): unknown {
    const snapshotRecord = asRecord(snapshotRaw);
    const liveRecord = asRecord(liveRaw);
    if (Object.keys(snapshotRecord).length === 0) {
      return liveRaw;
    }
    if (Object.keys(liveRecord).length === 0) {
      return snapshotRaw;
    }
    return {
      ...liveRecord,
      ...snapshotRecord,
      parentToolCallId:
        stringValue(snapshotRecord.parentToolCallId) ?? stringValue(liveRecord.parentToolCallId),
      toolCallId: stringValue(snapshotRecord.toolCallId) ?? stringValue(liveRecord.toolCallId),
    };
  }

  function mergePersistedToolCall(
    snapshotTool: ZCodePersistedToolCall | undefined,
    liveTool: ZCodePersistedToolCall,
  ): ZCodePersistedToolCall {
    if (!snapshotTool) {
      return liveTool;
    }
    return {
      ...liveTool,
      ...snapshotTool,
      // 终态 snapshot 来自父 session message parts，可能没有 live mirror 的
      // subagent parentToolCallId/raw/output。这里把 snapshot 作为终态事实源，同时保留
      // live 协议事件已经提供的父子归属和大字段，避免 task_complete 后工具树被覆盖丢失。
      input: snapshotTool.input ?? liveTool.input,
      output: snapshotTool.output ?? liveTool.output,
      raw: mergeToolRaw(snapshotTool.raw, liveTool.raw),
      error: snapshotTool.error ?? liveTool.error,
      status: snapshotTool.status ?? liveTool.status,
      snapshotRefs: snapshotTool.snapshotRefs ?? liveTool.snapshotRefs,
    };
  }

  function findToolLocation(
    messages: readonly ZCodePersistedMessage[],
    toolId: string,
  ): { messageIndex: number; toolIndex: number } | null {
    for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
      const message = messages[messageIndex];
      if (!message?.tools) continue;
      const toolIndex = message.tools.findIndex((tool) => persistedToolId(tool) === toolId);
      if (toolIndex >= 0) {
        return { messageIndex, toolIndex };
      }
    }
    return null;
  }

  function latestAssistantMessageIndex(messages: readonly ZCodePersistedMessage[]): number {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === "assistant") {
        return index;
      }
    }
    return -1;
  }

  function upsertPersistedToolPart(
    parts: readonly ZCodePersistedMessagePart[] | undefined,
    toolIndex: number,
  ): ZCodePersistedMessagePart[] {
    if (parts?.some((part) => part.type === "tool-call" && part.toolIndex === toolIndex)) {
      return [...parts];
    }
    return [...(parts ?? []), { type: "tool-call", toolIndex }];
  }

  function updateSnapshotMessageTool(
    message: ZCodePersistedMessage,
    toolIndex: number,
    tool: ZCodePersistedToolCall,
  ): ZCodePersistedMessage {
    const tools = [...(message.tools ?? [])];
    tools[toolIndex] = mergePersistedToolCall(tools[toolIndex], tool);
    return {
      ...message,
      tools,
      parts:
        message.role === "assistant"
          ? upsertPersistedToolPart(message.parts, toolIndex)
          : message.parts,
    };
  }

  function appendSnapshotMessageTool(
    message: ZCodePersistedMessage,
    tool: ZCodePersistedToolCall,
  ): ZCodePersistedMessage {
    const tools = [...(message.tools ?? []), tool];
    const toolIndex = tools.length - 1;
    return {
      ...message,
      tools,
      parts:
        message.role === "assistant"
          ? upsertPersistedToolPart(message.parts, toolIndex)
          : message.parts,
    };
  }

  function mergeLiveToolProjectionIntoSnapshotMessages(
    meta: ZCodeTaskMeta,
    messages: ZCodePersistedMessage[],
  ): ZCodePersistedMessage[] {
    const projection = liveToolProjectionsByTaskKey.get(taskKey(meta));
    if (!projection || projection.size === 0 || messages.length === 0) {
      return messages;
    }

    let nextMessages = messages;
    let changed = false;
    let mergedToolCount = 0;
    const liveTools = [...projection.values()].sort((a, b) => a.order - b.order);
    for (const liveTool of liveTools) {
      const existingLocation = findToolLocation(nextMessages, liveTool.toolId);
      if (existingLocation) {
        nextMessages = nextMessages.map((message, index) =>
          index === existingLocation.messageIndex
            ? updateSnapshotMessageTool(message, existingLocation.toolIndex, liveTool.tool)
            : message,
        );
        changed = true;
        mergedToolCount += 1;
        continue;
      }

      const parentLocation = liveTool.parentToolUseId
        ? findToolLocation(nextMessages, liveTool.parentToolUseId)
        : null;
      const targetMessageIndex =
        parentLocation?.messageIndex ?? latestAssistantMessageIndex(nextMessages);
      if (targetMessageIndex < 0) {
        continue;
      }

      nextMessages = nextMessages.map((message, index) =>
        index === targetMessageIndex ? appendSnapshotMessageTool(message, liveTool.tool) : message,
      );
      changed = true;
      mergedToolCount += 1;
    }

    if (changed) {
      logger.debug(undefined, "ZCode snapshot 合并 live tool projection", {
        event: "zcode_task.snapshot.live_tool_projection.merged",
        liveToolCount: liveTools.length,
        mergedToolCount,
        taskId: meta.taskId,
        workspaceIdentity: meta.workspaceIdentity,
        workspacePath: meta.workspacePath,
      });
    }
    return changed ? nextMessages : messages;
  }

  function rememberTaskTarget(params: TaskTarget): void {
    const existing = taskTargets.get(params.taskId);
    taskTargets.set(params.taskId, {
      ...params,
      // cronAutomationId 是会话的 sticky 归属标记，供 UI 展示和任务关联使用，不参与当前
      // turn 的工具权限。resume/onDynamicTaskEvent 等入口不带值时仍需保留权威归属；明确设置
      // 或清除只能走 rememberIndexedTaskMeta。
      cronAutomationId: params.cronAutomationId ?? existing?.cronAutomationId,
    });
  }

  function getTaskTarget(taskId: string): TaskTarget {
    const target = taskTargets.get(taskId);
    if (!target) {
      throw Object.assign(new Error(`ZCode session target is not loaded: ${taskId}`), {
        code: "ZCODE_SESSION_TARGET_NOT_FOUND",
      });
    }
    return target;
  }

  function getToolProjectionMemory(params: TaskTarget): ZCodeToolProjectionMemory {
    const key = taskKey(params);
    let memory = toolProjectionMemoryByTaskKey.get(key);
    if (!memory) {
      memory = createZCodeToolProjectionMemory();
      toolProjectionMemoryByTaskKey.set(key, memory);
    }
    return memory;
  }

  function clearStreamingToolInputCache(params: TaskTarget): void {
    toolProjectionMemoryByTaskKey.get(taskKey(params))?.streamingToolInputById?.clear();
  }

  // Bugfix: workspace emitter 已上提到 syncer，adapter 通过 syncer 获取共享 emitter，
  // 保证 task adapter 路径和 desktop-continuous 路径走同一份订阅，UI 不会漏事件。
  function getWorkspaceEmitter(workspace: WorkspaceEventInput): Emitter<ZCodeWorkspaceEvent> {
    return taskIndexSyncer.getWorkspaceEmitter(workspace);
  }

  function getTaskEmitter(params: TaskTarget): Emitter<ZCodeStreamEvent> {
    const key = taskKey(params);
    let emitter = taskEmitters.get(key);
    if (!emitter) {
      emitter = new Emitter<ZCodeStreamEvent>();
      taskEmitters.set(key, emitter);
    }
    return emitter;
  }

  function getGlobalTaskEmitter(taskId: string): Emitter<ZCodeStreamEvent> {
    let emitter = globalTaskEmitters.get(taskId);
    if (!emitter) {
      emitter = new Emitter<ZCodeStreamEvent>();
      globalTaskEmitters.set(taskId, emitter);
    }
    return emitter;
  }

  function emitTaskEvent(params: TaskTarget, event: ZCodeStreamEvent): void {
    getTaskEmitter(params).fire(event);
    getGlobalTaskEmitter(params.taskId).fire(event);
  }

  // 委托到 syncer，让 archive/rename/pin/delete 等 task 元数据变更和
  // desktop-continuous 路径（turn.completed 等）走同一条广播通道。
  // 设计修正：reason 必填，发射点必须声明变更类别。
  function emitWorkspaceTaskListChanged(
    params: {
      workspacePath: string;
      workspaceIdentity?: string;
      taskId?: string;
    },
    taskMeta: ZCodeTaskMeta | undefined,
    reason: ZCodeWorkspaceTaskListChanged["reason"],
  ) {
    taskIndexSyncer.emitWorkspaceTaskListChanged(params, taskMeta, reason);
  }

  function emitWorkspaceConfig(
    params: ZCodeAgentWorkspaceTarget,
    settings: ZCodeSessionSettingsState,
  ) {
    getWorkspaceEmitter(params).fire({
      type: "workspace_config_options_update",
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      configOptions: settingsToConfigOptions(settings),
    });
  }

  async function resumeSnapshot(
    params: TaskTargetWithMcpServers,
  ): Promise<ZCodeSessionStateSnapshot> {
    rememberTaskTarget(params);
    const thoughtLevel = params.thoughtLevel?.trim();
    const mcpServers = await resolveProductMcpServers(params.mcpServers);
    return options.zcodeAgentService.resumeSession({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      sessionId: params.taskId,
      ...(params.additionalDirectories !== undefined
        ? { additionalDirectories: params.additionalDirectories }
        : {}),
      // Bugfix: replayable 手机端恢复仍经 task adapter，但 stale model guard 在
      // session resume 内执行；这里带上当前 UI 模型，避免只保护 desktop continuous 主链路。
      model: params.model ? parseModelPickerValue(params.model) : undefined,
      ...(thoughtLevel ? { thoughtLevel } : {}),
      ...(mcpServers ? { mcpServers } : {}),
      ...(params.toolDenylist ? { toolDenylist: params.toolDenylist } : {}),
    });
  }

  /**
   * 会话级配置写（模型/思考深度/模式）的 v4 CAS 命令提交。
   * host 无本地 v4 投影，revision 用 stale ACK 的 revisionAtDecision 收敛（sendHostCasCommandV4）。
   * 注意与 compact/goal 标注同一坑位：旧协议 stateRevision 与 v4 conversation revision
   * 是两套计数器，这里全程只用 v4 ACK 回报的 revision，绝不混入旧 expectedRevision。
   */
  async function sendConfigCasCommandV4<T extends "switchModelConfig" | "switchCollaborationMode">(
    target: TaskTarget,
    type: T,
    payload: CommandPayloadMap[T],
    contextMessage: string,
  ): Promise<void> {
    await sendHostCasCommandV4({
      send: (envelope) =>
        options.zcodeAgentService.sendConversationCommandV4({
          workspacePath: target.workspacePath,
          workspaceIdentity: target.workspaceIdentity,
          envelope,
        }),
      type,
      payload,
      sessionId: target.taskId,
      contextMessage,
    });
  }

  /**
   * session/setMode → v4 switchCollaborationMode。
   * auto 例外保真：v4 命令值域刻意排除 auto（「auto 非用户可切，不进 UI 命令面」，
   * command.ts 裁决），而旧协议 ZCodeSessionMode 含 auto 且旧 op 接受它——为 UI 行为
   * 零变化，auto 继续走旧 op，其余值一律 v4 原生。过渡归宿 = auto 语义在 v4 侧裁决后收口。
   */
  async function switchCollaborationModeViaProtocol(
    target: TaskTarget,
    mode: ZCodeSessionMode,
  ): Promise<void> {
    if (mode === "auto") {
      await options.zcodeAgentService.setMode({
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        sessionId: target.taskId,
        mode,
      });
      return;
    }
    await sendConfigCasCommandV4(
      target,
      "switchCollaborationMode",
      { mode },
      `session=${target.taskId} mode=${mode}`,
    );
  }

  async function repairEmptyImportedClaudeSnapshot(
    params: TaskTargetWithMcpServers,
    snapshot: ZCodeSessionStateSnapshot,
  ): Promise<ZCodeSessionStateSnapshot> {
    const repaired = await repairImportedClaudeSessionSnapshot({
      snapshot,
      target: params,
      createSession: (input) => options.zcodeAgentService.createSession(input),
      onRepair: (history) => {
        logger.warn(
          undefined,
          `Claude 导入 protocol session 历史异常，按 ${history.source} 回填 taskId=${params.taskId}`,
        );
      },
    });
    if (!repaired) {
      return snapshot;
    }
    const meta = await syncTaskIndexSnapshot(repaired);
    await updateIndexedPresentation({ ...meta, migrationSource: "claudeCode" });
    return repaired;
  }

  function isSessionMissingError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? "");
    return /\bSession (not found|is not active):/i.test(message);
  }

  async function readLegacyTaskSnapshot(params: TaskTarget): Promise<ZCodeTaskSnapshot | null> {
    const paths = [
      getLegacyTaskSessionSnapshotPath(
        params.workspacePath,
        params.taskId,
        params.workspaceIdentity,
      ),
      getLegacyDeletedTaskSessionSnapshotPath(
        params.workspacePath,
        params.taskId,
        params.workspaceIdentity,
      ),
    ];
    const snapshotPath = paths.find((path) => existsSync(path));
    if (!snapshotPath) {
      return null;
    }

    try {
      const rawSnapshot = JSON.parse(readFileSync(snapshotPath, "utf-8")) as unknown;
      const parsed = safeParseLegacyTaskSessionFile(rawSnapshot);
      if (!parsed.success) {
        logger.warn(
          undefined,
          `读取 legacy task snapshot 非法 taskId=${params.taskId}`,
          parsed.error.flatten(),
        );
        return null;
      }

      const legacyFile = parsed.data;
      const indexedMeta = await taskIndexRepo.getTaskMeta(params).catch(() => null);
      const legacyMeta: ZCodeTaskMeta = {
        ...legacyFile.meta,
        // Bugfix: 旧 ACP task 只落在 ~/.zcode/v2/sessions/*.json，没有写入
        // zcode-cli 的 sqlite session 表。新协议 resume 会把 taskId 当 sessionId
        // 直接报 Session not found；这里按旧快照恢复只读历史内容，并用 task index
        // 补齐用户改名、归档状态和终态 status，避免把旧 task 误当成可订阅的新 session。
        taskId: params.taskId,
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity ?? legacyFile.meta.workspaceIdentity,
        title: indexedMeta?.title ?? legacyFile.meta.title,
        updatedAt: indexedMeta?.updatedAt ?? legacyFile.meta.updatedAt,
        mode: legacyFile.meta.mode ?? indexedMeta?.mode ?? "default",
        provider: legacyFile.meta.provider ?? indexedMeta?.provider ?? GLM_PROVIDER,
        status: legacyFile.meta.status ?? indexedMeta?.status ?? "completed",
        lastError: legacyFile.meta.lastError ?? indexedMeta?.lastError,
      };
      const snapshot: ZCodeTaskSnapshot = {
        ...legacyFile,
        meta: {
          ...legacyMeta,
          ...(indexedMeta ? { title: indexedMeta.title, unreadAt: indexedMeta.unreadAt } : {}),
        },
        runtime: {
          apiRetry: apiRetryByTaskKey.get(taskKey(params)) ?? null,
          pendingCommands: runtimeCommands.get(taskKey(params)) ?? [],
        },
      };
      legacySnapshotTaskKeys.add(taskKey(params));
      rememberIndexedTaskMeta(snapshot.meta);
      return snapshot;
    } catch (error) {
      logger.warn(undefined, `读取 legacy task snapshot 失败 taskId=${params.taskId}`, error);
      return null;
    }
  }

  async function resumeSnapshotOrLegacy(
    params: TaskTargetWithMcpServers,
  ): Promise<
    | { kind: "session"; snapshot: ZCodeSessionStateSnapshot }
    | { kind: "legacy"; snapshot: ZCodeTaskSnapshot }
  > {
    try {
      const snapshot = await resumeSnapshot(params);
      return {
        kind: "session",
        snapshot: await repairEmptyImportedClaudeSnapshot(params, snapshot),
      };
    } catch (error) {
      if (!isSessionMissingError(error)) {
        throw error;
      }
      const legacySnapshot = await readLegacyTaskSnapshot(params);
      if (!legacySnapshot) {
        throw error;
      }
      if (legacySnapshot.meta.migrationSource === "claudeCode") {
        try {
          const mcpServers = await resolveProductMcpServers(params.mcpServers);
          const snapshot = await options.zcodeAgentService.createSession({
            workspacePath: params.workspacePath,
            workspaceIdentity: params.workspaceIdentity,
            sessionId: params.taskId,
            sessionTraceId: legacySnapshot.meta.traceId ?? createSessionTraceId(),
            persistence: "immediate",
            model: params.model ? parseModelPickerValue(params.model) : undefined,
            ...(mcpServers ? { mcpServers } : {}),
            ...(params.toolDenylist ? { toolDenylist: params.toolDenylist } : {}),
            importedHistory: {
              source: "claudeCode",
              title: legacySnapshot.meta.title,
              createdAt: legacySnapshot.meta.createdAt,
              updatedAt: legacySnapshot.meta.updatedAt,
              messages: legacySnapshot.messages.map((message) => ({
                role: message.role,
                content: message.content,
                timestamp: message.timestamp,
              })),
            },
          });
          const meta = await syncTaskIndexSnapshot(snapshot);
          await updateIndexedPresentation({ ...meta, migrationSource: "claudeCode" });
          logger.info(
            undefined,
            `legacy Claude 导入 task 已升级为 ZCode session taskId=${params.taskId}`,
          );
          return { kind: "session", snapshot };
        } catch (upgradeError) {
          logger.warn(
            undefined,
            `legacy Claude 导入 task 升级为 ZCode session 失败，继续只读恢复 taskId=${params.taskId}`,
            upgradeError,
          );
        }
      }
      logger.warn(
        undefined,
        `ZCode Protocol session 缺失，已按 legacy task snapshot 恢复 taskId=${params.taskId}`,
        error,
      );
      return { kind: "legacy", snapshot: legacySnapshot };
    }
  }

  function snapshotToMeta(snapshot: ZCodeSessionStateSnapshot): ZCodeTaskMeta {
    const target = {
      taskId: snapshot.session.sessionId,
      workspacePath: snapshot.session.workspace.workspacePath,
      workspaceIdentity: snapshot.session.workspace.workspaceIdentity,
    };
    rememberTaskTarget(target);
    return {
      taskId: snapshot.session.sessionId,
      traceId: snapshot.session.traceId ?? generateTraceId(snapshot.session.sessionId),
      title: deriveTitleFromSnapshot(snapshot),
      workspacePath: snapshot.session.workspace.workspacePath,
      workspaceIdentity: snapshot.session.workspace.workspaceIdentity,
      createdAt: snapshot.session.createdAt,
      updatedAt: snapshot.session.updatedAt,
      mode: fromZCodeMode(snapshot.session.mode),
      model: formatTaskMetaModelSelectionFromSnapshot(snapshot),
      thoughtLevel: snapshot.settings.thoughtLevel.current,
      provider: GLM_PROVIDER,
      status: deriveZCodeTaskStatusFromSessionSnapshot(snapshot),
      lastError: snapshot.projection.lastError
        ? {
            code: snapshot.projection.lastError.code ?? snapshot.projection.lastError.type,
            ...(snapshot.projection.lastError.detail
              ? { detail: snapshot.projection.lastError.detail }
              : {}),
            // 修复原因：service snapshot 是 mobile replayable/cold task meta 的来源，不能
            // 让它与 UI 直接投影的 lastError 产生归因漂移。
            ...(snapshot.projection.lastError.attribution
              ? { attribution: snapshot.projection.lastError.attribution }
              : {}),
            message: snapshot.projection.lastError.message,
          }
        : undefined,
      target: snapshot.projection.target
        ? fromZCodeGoal(snapshot.projection.target)
        : snapshot.projection.target,
    };
  }

  function rememberIndexedTaskMeta(meta: ZCodeTaskMeta): ZCodeTaskMeta {
    const existing = taskTargets.get(meta.taskId);
    // 权威归属刷新：index meta 是唯一可以设置/清除 cronAutomationId 的来源，直接以 meta 为准
    // 写入（绕过 rememberTaskTarget 的 merge-preserve），以便解绑/删除 automation 后能真正清空。
    taskTargets.set(meta.taskId, {
      ...existing,
      taskId: meta.taskId,
      workspacePath: meta.workspacePath,
      workspaceIdentity: meta.workspaceIdentity,
      cronAutomationId: meta.cronAutomationId,
    });
    return meta;
  }

  async function resolveTaskIndexResumeHints(
    params: TaskTarget,
    reason: "replayable_snapshot" | "resume_task",
  ): Promise<{ model?: string; thoughtLevel?: string }> {
    const meta = await taskIndexRepo.getTaskMeta(params).catch((error) => {
      logger.warn(undefined, "读取 task index resume hint 失败，继续不带历史配置恢复", {
        error: error instanceof Error ? error.message : String(error),
        reason,
        taskId: params.taskId,
        workspaceIdentity: params.workspaceIdentity ?? null,
        workspacePath: params.workspacePath,
      });
      return null;
    });
    const model = meta?.model?.trim();
    const thoughtLevel = meta?.thoughtLevel?.trim();
    if (model || thoughtLevel) {
      // task-local thoughtLevel 和 model 一样属于历史 session 恢复 hint。
      // 不回填 thoughtLevel 时，同 workspace 的 draft 默认值会在 session/resume 后覆盖 active task。
      logger.info(undefined, "从 task index 回填 ZCode session resume 配置", {
        model: model || null,
        thoughtLevel: thoughtLevel || null,
        reason,
        taskId: params.taskId,
        workspaceIdentity: params.workspaceIdentity ?? null,
        workspacePath: params.workspacePath,
      });
    }
    return {
      ...(model ? { model } : {}),
      ...(thoughtLevel ? { thoughtLevel } : {}),
    };
  }

  async function updateIndexedPresentation(meta: ZCodeTaskMeta): Promise<ZCodeTaskMeta> {
    const {
      mode,
      model,
      thoughtLevel,
      lastError,
      target,
      migrationSource,
      cronAutomationId,
      offPeakTaskId,
    } = meta;
    const presentation = Object.fromEntries(
      Object.entries({
        mode,
        model,
        thoughtLevel,
        lastError,
        target,
        migrationSource,
        cronAutomationId,
        offPeakTaskId,
      }).filter(([, value]) => value !== undefined),
    );
    const indexedMeta = await taskIndexRepo.updateTaskPresentation({ ...meta, presentation });
    return rememberIndexedTaskMeta(indexedMeta ?? meta);
  }

  async function syncTaskIndexSnapshot(
    snapshot: ZCodeSessionStateSnapshot,
    broadcastReason: ZCodeWorkspaceTaskListChanged["reason"] | null = "task_status_changed",
  ): Promise<ZCodeTaskMeta> {
    if (isAuxiliarySessionKind(snapshot.session.sessionKind)) return snapshotToMeta(snapshot);
    return rememberIndexedTaskMeta(
      await taskIndexSyncer.syncSnapshotAndBroadcast(snapshot, {
        broadcastReason,
      }),
    );
  }

  async function updateIndexedTaskState(
    params: TaskTarget,
    patch: { pinned?: boolean; archived?: boolean; unreadAt?: number },
  ): Promise<ZCodeTaskMeta> {
    return taskIndexRepo.updateTaskState({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      taskId: params.taskId,
      patch,
    });
  }

  function updateTaskApiRetryFromStreamEvent(params: TaskTarget, event: ZCodeStreamEvent): void {
    const key = taskKey(params);
    if (event.type === "session_info_update" && event.apiRetry !== undefined) {
      apiRetryByTaskKey.set(key, event.apiRetry ?? null);
      return;
    }
    if (event.type === "task_complete" || event.type === "task_error") {
      apiRetryByTaskKey.set(key, null);
    }
  }

  function hasActiveTaskApiRetry(params: TaskTarget): boolean {
    return apiRetryByTaskKey.get(taskKey(params)) != null;
  }

  function snapshotToZCode(
    snapshot: ZCodeSessionStateSnapshot,
    options?: { includeEmptyPendingElicitations?: boolean },
  ): ZCodeTaskSnapshot {
    const meta = snapshotToMeta(snapshot);
    const activeGoalIterationCount = getSnapshotGoalActiveIterationCount(snapshot);
    const goalIterationByAssistantMessageId = getZCodeGoalIterationByAssistantMessageId(
      snapshot.messages,
      {
        ...(activeGoalIterationCount > 0 ? { maxGoalIteration: activeGoalIterationCount } : {}),
        target: snapshot.projection.target,
      },
    );
    const backgroundTaskNotifications = collectZCodeBackgroundTaskNotificationsByToolUseId(
      snapshot.messages,
    );
    const messages = mergeLiveToolProjectionIntoSnapshotMessages(
      meta,
      normalizeGoalVerificationTimelineMessageOrder(
        addGoalVerificationTimelineSnapshotFallback(
          addSessionForkSnapshotFallback(
            coalesceConsecutiveZCodeAssistants(
              getZCodeUserVisibleMessages(snapshot.messages, {
                target: snapshot.projection.target,
              }).map((message) =>
                mapMessage(
                  message,
                  message.info.role === "assistant"
                    ? goalIterationByAssistantMessageId.get(message.info.messageId)
                    : undefined,
                  backgroundTaskNotifications,
                ),
              ),
            ),
            snapshot,
          ),
          snapshot,
        ),
      ),
    );
    const pendingPermissions: ZCodePermissionRequest[] = snapshot.projection.pendingPermissions
      .filter((permission) => !isUserInputBackedPermissionToolName(permission.toolName))
      .map((permission) => pendingPermissionToStreamEvent(snapshot.session.sessionId, permission));
    const pendingElicitations = snapshot.projection.pendingPermissions
      .filter((permission) => isUserInputBackedPermissionToolName(permission.toolName))
      .map((permission) =>
        pendingUserInputBackedPermissionToElicitationEvent(snapshot.session.sessionId, permission),
      )
      .filter(
        (event): event is Extract<ZCodeStreamEvent, { type: "elicitation_request" }> =>
          event !== null,
      );
    const backgroundTaskControls = parseZCodeBackgroundTaskControlItems(
      snapshot.projection.backgroundJobs,
    );
    setTaskBackgroundTaskControlCache(
      backgroundTaskControlsByTaskKey,
      taskKey(meta),
      backgroundTaskControls,
    );
    return {
      meta,
      messages,
      fileChanges: [],
      configOptions: settingsToConfigOptions(snapshot.settings),
      // agent 协议 snapshot 含有 `/compact` 等命令；task facade 投影时必须保留，
      // 否则 replayable/legacy task restore 会把 UI 的 slashCommands 回填成空。
      slashCommands: snapshot.slashCommands ?? EMPTY_SLASH_COMMANDS,
      runtime: {
        activeTurnKind: snapshot.runtime.activeTurnKind,
        apiRetry: apiRetryByTaskKey.get(taskKey(meta)) ?? null,
        contextUsage:
          contextUsageFromRuntime(snapshot.runtime.contextUsage) ??
          contextUsageFromProjection(snapshot.projection) ??
          undefined,
        pendingPermissions,
        backgroundBashJobs: backgroundTaskControls,
        // 手机 replayable 快照需要用空数组表达“用户输入队列已清空”。
        // desktop-continuous 主链路仍保持原投影形态，避免把 replayable 的集合恢复语义扩散过去。
        ...(pendingElicitations.length > 0 || options?.includeEmptyPendingElicitations
          ? { pendingElicitations }
          : {}),
        pendingCommands: runtimeCommands.get(taskKey(meta)) ?? [],
        // todo 的权威数据在 agent DB；历史恢复时必须随 snapshot 映射给 UI，
        // 不能只依赖 renderer 运行期收到过的 plan stream event。
        plan: sessionTodosToPlanSteps(snapshot.todos),
        goalStats: sessionGoalStatsToRuntime(snapshot.goalStats),
        goalVerifications: snapshot.runtime.goalVerifications ?? null,
        goalVerificationTimeline: snapshot.runtime.goalVerificationTimeline ?? null,
        todoGroups: sessionTodoGroupsToRuntime(snapshot.todoGroups),
      },
    };
  }

  function mapServiceEvent(params: TaskTarget, event: ZCodeAgentServiceEvent): void {
    if (event.type === "snapshot") {
      void syncTaskIndexSnapshot(event.snapshot).catch((error) => {
        logger.warn(undefined, "同步 ZCode snapshot 到 task index 失败", error);
      });
      const snapshotEvent: ZCodeStreamEvent = {
        type: "task_snapshot_updated",
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        workspaceKey: workspaceKey(params),
        taskId: params.taskId,
        traceId: generateTraceId(params.taskId),
      };
      emitTaskEvent(params, snapshotEvent);
      emitWorkspaceConfig(params, event.snapshot.settings);
      return;
    }

    if (event.type === "state.updated") {
      for (const streamEvent of mapStateUpdated(params, event.notification)) {
        emitTaskEvent(params, streamEvent);
      }
      return;
    }

    if (event.type === "permission.request") {
      emitTaskEvent(params, permissionRequestToStreamEvent(params.taskId, event.request));
      return;
    }

    if (event.type === "userInput.request") {
      emitTaskEvent(params, userInputRequestToElicitationStreamEvent(params.taskId, event.request));
      return;
    }

    if (event.type === "userInput.response") {
      emitTaskEvent(
        params,
        userInputResponseToElicitationStreamEvent(params.taskId, event.requestId, event.response),
      );
      return;
    }

    if (event.type === "providerRuntimeHeaders.request") {
      return;
    }

    if (event.type === "session.event") {
      recordAgentModelNetworkTelemetry(event.event);
      if (event.event.type === "turn.started") {
        const payload = asRecord(event.event.payload);
        const inputId = stringValue(payload.inputId);
        if (inputId) {
          // remote/replayable/fallback 订阅不一定由 sendPrompt 建立。
          // turn.started 是后续 model.streaming 事件归属当前输入的协议事实，必须在 services 投影层同步记录。
          activePromptInputIds.set(taskKey(params), inputId);
        }
      }
    }

    const activePromptInputId = activePromptInputIds.get(taskKey(params));
    const streamEvents = mapSessionEvent(
      params,
      event.event,
      streamedTurnText,
      activePromptInputId,
      getToolProjectionMemory(params),
      backgroundTaskControlsByTaskKey,
      hasActiveTaskApiRetry(params),
    );
    for (const streamEvent of streamEvents) {
      rememberLiveToolProjection(params, streamEvent);
      updateTaskApiRetryFromStreamEvent(params, streamEvent);
      emitTaskEvent(params, streamEvent);
      if (streamEvent.type === "task_complete" || streamEvent.type === "task_error") {
        completeRuntimeCommandForTerminalEvent(params, streamEvent);
      }
    }
    if (event.event.type === "turn.completed" || event.event.type === "turn.failed") {
      activePromptInputIds.delete(taskKey(params));
    }
  }

  let disposed = false;

  function handleTaskIndexTerminalEvent(event: ZCodeTaskIndexTerminalEvent): void {
    const params: TaskTarget = {
      taskId: event.target.sessionId,
      workspacePath: event.target.workspacePath,
      workspaceIdentity: event.target.workspaceIdentity,
    };
    const key = taskKey(params);
    if (!activePromptInputIds.has(key) && !runtimeCommands.has(key)) {
      return;
    }
    // 终态事件源换成 v4 sessions-index 的 phase 迁移，摘要不携带 inputId，
    // 一律用本地记录的 active input 收口（旧协议 payload.inputId 缺失时的兜底路径，语义不变）。
    const terminalInputId = activePromptInputIds.get(key);
    completeRuntimeCommandByInputId(params, terminalInputId, event.kind);
    // turn 终态只说明 stream 收口已到，不代表 agent server 的 active lock 已释放。
    // 这里仅收口当前 input；下一条 host command 必须等 ready 事件触发。
    activePromptInputIds.delete(key);
  }

  const taskIndexTerminalDisposable = taskIndexSyncer.onSessionTerminalEvent((event) => {
    queueMicrotask(() => {
      if (!disposed) {
        handleTaskIndexTerminalEvent(event);
      }
    });
  });

  function handleTaskIndexReadyEvent(event: ZCodeTaskIndexReadyEvent): void {
    const params: TaskTarget = {
      taskId: event.target.sessionId,
      workspacePath: event.target.workspacePath,
      workspaceIdentity: event.target.workspaceIdentity,
    };
    const key = taskKey(params);
    if (!activePromptInputIds.has(key) && !runtimeCommands.has(key)) {
      return;
    }
    const activeInputId = activePromptInputIds.get(key);
    completeRuntimeCommandByInputId(params, activeInputId, event.reason);
    // prompt_completed/prompt_failed 由 agent server 在释放 activeAbortController 后发出。
    // 手机 host command queue 以它作为“下一条可以发送”的 ready 边界，避免 fixed delay 重试，
    // 也不改变桌面 continuous 的 renderer-local queue。
    activePromptInputIds.delete(key);
    scheduleRuntimeCommandDrain(params, "session-ready");
  }

  const taskIndexReadyDisposable = taskIndexSyncer.onSessionReadyEvent((event) => {
    queueMicrotask(() => {
      if (!disposed) {
        handleTaskIndexReadyEvent(event);
      }
    });
  });

  function disposeLocalTaskState(): void {
    taskIndexTerminalDisposable.dispose();
    taskIndexReadyDisposable.dispose();
    taskIndexRepo.close();
    for (const emitter of taskEmitters.values()) emitter.dispose();
    for (const emitter of globalTaskEmitters.values()) emitter.dispose();
    errorEmitter.dispose();
    taskEmitters.clear();
    globalTaskEmitters.clear();
    runtimeCommandDrains.clear();
    streamedTurnText.clear();
  }

  async function disposeZCodeAgentServiceAndWait(): Promise<void> {
    const agentService = options.zcodeAgentService as IZCodeAgentService & {
      disposeAllAndWait?: () => Promise<void>;
    };
    if (agentService.disposeAllAndWait) {
      await agentService.disposeAllAndWait();
      return;
    }
    agentService.disposeAll();
  }

  const service: IZCodeTaskService & {
    disposeAll(): void;
    disposeAllAndWait(): Promise<void>;
  } = {
    async initialize(params) {
      const result = await options.zcodeAgentService.initialize(params);
      return {
        available: result.available,
        version: result.protocolName
          ? `${result.protocolName}/${result.protocolVersion ?? 1}`
          : undefined,
      };
    },

    async releaseWorkspacePreparation(params): Promise<void> {
      await options.zcodeAgentService.disposeWorkspace({
        ...normalizeWorkspaceParams(params),
        releasePreparation: true,
      });
    },

    async checkCodexConnectivity(): Promise<ZCodeCodexConnectivityCheckResult> {
      return { target: "zcode-agent", reachable: true };
    },

    async createTask(params): Promise<ZCodeTaskCreateResult> {
      const target = normalizeWorkspaceParams(params);
      const requestedSelection =
        params.modelSelection ??
        (params.model
          ? {
              ...parseModelPickerValue(params.model),
              ...(params.thoughtLevel ? { options: { reasoningLevel: params.thoughtLevel } } : {}),
            }
          : undefined);
      const mcpServers = await resolveProductMcpServers(params.mcpServers);
      let snapshot: ZCodeSessionStateSnapshot;
      // M5 ③-2 评估标注（生命周期 op，不迁）：v4 createSession 命令已原生（desktop
      // v4 UI 在用），但 replayable createTask 需要 mcpServers/model/importedHistory
      // 载荷与 snapshot 返回值（task index 同步依赖），v4 命令面均未建模；
      // 迁移属 ③-3/波次 3 生命周期收口。
      if (params.v4Create === true) {
        const model = requestedSelection;
        const ack = assertV4CommandAckOk(
          "createSession",
          await options.zcodeAgentService.sendConversationCommandV4({
            ...target,
            projectId: params.projectId ?? null,
            envelope: createHostCommandEnvelope({
              type: "createSession",
              sessionId: null,
              payload: {
                workspaceId: target.workspaceIdentity?.trim() || target.workspacePath,
                ...(params.additionalDirectories !== undefined
                  ? { additionalDirectories: params.additionalDirectories }
                  : {}),
                ...(params.permissionScope ? { permissionScope: params.permissionScope } : {}),
                config: {
                  ...(model ? { provider: model.providerId, model: model.modelId } : {}),
                  ...(model?.options?.reasoningLevel
                    ? { thought: model.options.reasoningLevel }
                    : {}),
                  ...(params.mode ? { mode: toZCodeMode(params.mode) } : {}),
                },
                ...(mcpServers ? { mcpServers } : {}),
              },
            }),
          }),
          `workspace=${target.workspacePath}`,
        );
        const sessionId = ack.result?.type === "createSession" ? ack.result.sessionId : undefined;
        if (!sessionId) {
          throw new Error("v4 createSession accepted without sessionId result");
        }
        snapshot = await options.zcodeAgentService.readSession({
          ...target,
          sessionId,
        });
      } else {
        snapshot = await options.zcodeAgentService.createSession({
          ...target,
          projectId: params.projectId ?? null,
          additionalDirectories: params.additionalDirectories,
          sessionTraceId: createSessionTraceId(),
          mode: toZCodeMode(params.mode),
          model: requestedSelection,
          thoughtLevel: requestedSelection?.options?.reasoningLevel,
          ...(params.automationId || params.deferPersistenceUntilFirstPrompt
            ? {
                // 修复原因：automation / 闲时任务新建空 session 后会立即 sendText。session_input 有
                // session 外键，必须让 V4 admission 在首发前统一持久化 session 主记录；
                // 否则 create 返回成功后第一条 prompt 会稳定触发 FOREIGN KEY constraint failed。
                persistence: "deferred" as const,
              }
            : {}),
          ...(params.automationId
            ? {
                titleGenerationEnabled: false,
              }
            : {}),
          // Bugfix: replayable task facade 创建 session 时同样会启动 runtime；
          // 之前这里丢掉 mcpServers，导致手机远控路径和 desktop-continuous 的 MCP 行为不一致。
          mcpServers,
        });
      }
      const baseMeta = await syncTaskIndexSnapshot(snapshot, null);
      const meta = await updateIndexedPresentation({
        ...baseMeta,
        ...(params.automationId ? { cronAutomationId: params.automationId } : {}),
        // 闲时派发在创建时即盖章持久归属；月亮图标与后续系统分组归属都只看该标记。
        ...(params.offPeakTaskId ? { offPeakTaskId: params.offPeakTaskId } : {}),
      });

      notifySyncerSession({
        taskId: meta.taskId,
        workspacePath: meta.workspacePath,
        workspaceIdentity: meta.workspaceIdentity,
      });
      emitWorkspaceConfig(target, snapshot.settings);
      // 手机端通过 shared-host 创建 task 时，桌面 renderer 没有本地乐观插入。
      // create 事件必须保留 task_created 语义，否则 UI 会按普通 meta 事件只重排已存在项，远控首页就拿不到新任务。
      emitWorkspaceTaskListChanged(target, meta, "task_created");
      // task 创建结果需要携带 agent 协议快照里的命令列表；否则 replayable 首屏会覆盖为空。
      return {
        ...meta,
        initialSlashCommands: snapshot.slashCommands ?? EMPTY_SLASH_COMMANDS,
      };
    },

    async readBotTopicSummaries(params) {
      const target = taskTargets.get(params.taskId);
      if (target && taskKey(target) !== taskKey(params))
        throw new Error("Topic task workspace mismatch");
      const messages = await options.zcodeAgentService.readSessionMessages({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        remoteSessionId: params.remoteSessionId ?? target?.remoteSessionId,
        sessionId: params.taskId,
        limit: 200,
      });
      return messages
        .flatMap(({ info, parts }) => {
          if (info.role !== "user" || info.source !== "bot_topic_context") return [];
          return [
            {
              checkpoint: String(info.metadata?.checkpoint ?? ""),
              text:
                typeof info.metadata?.displayText === "string"
                  ? info.metadata.displayText
                  : textFromParts(parts),
            },
          ];
        })
        .slice(-20);
    },

    async invalidateBotTopicInputs(params) {
      const target = getTaskTarget(params.taskId);
      if (taskKey(target) !== taskKey(params)) throw new Error("Group task workspace mismatch");
      const key = JSON.stringify([
        taskKey(params),
        params.remoteSessionId ?? target.remoteSessionId ?? null,
      ]);
      await topicAdmission.invalidate(key);
    },
    async readBotTopicExecution(params) {
      const target = getTaskTarget(params.taskId);
      if (taskKey(target) !== taskKey(params)) throw new Error("Group task workspace mismatch");
      const workspace = {
        ...params,
        remoteSessionId: params.remoteSessionId ?? target.remoteSessionId,
      };
      const snapshot = await readBotGroupRuntimeSnapshot(botAgent(workspace), {
        ...workspace,
        sessionId: params.taskId,
      });
      if (snapshot.control.stopState === "idle") return undefined;
      const execution = snapshot.control.activeWorks.find((work) => work.foregroundExecutionId);
      if (!execution?.foregroundExecutionId)
        throw new Error("Topic execution identity is unavailable");
      return {
        executionId: execution.foregroundExecutionId,
        sourceCommandId: execution.sourceCommandId,
      };
    },
    async stopBotTopicExecution(params) {
      const target = getTaskTarget(params.taskId);
      if (taskKey(target) !== taskKey(params)) throw new Error("Group task workspace mismatch");
      const workspace = {
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        remoteSessionId: params.remoteSessionId ?? target.remoteSessionId,
      };
      const agent = botAgent(workspace);
      // 先注册终态监听再停止，避免快速结束发生在 ACK 与订阅之间。
      const observation = new AbortController();
      const ended = waitBotGroupExecutionEnd(
        agent,
        { ...workspace, sessionId: params.taskId },
        params.executionId,
        observation.signal,
      );
      void ended.catch(() => undefined);
      try {
        const ack = await agent.sendConversationCommandV4({
          ...workspace,
          envelope: createHostCommandEnvelope({
            type: "stop",
            sessionId: params.taskId,
            payload: { expectedForegroundExecutionId: params.executionId },
          }),
        });
        assertV4CommandAckOk("stop", ack, `session=${params.taskId}`);
        await ended;
      } finally {
        observation.abort();
      }
    },

    async getBotGroupTaskBlockReason(params) {
      const target = taskTargets.get(params.taskId);
      if (target && taskKey(target) !== taskKey({ ...params, taskId: params.taskId }))
        throw new Error("Group task workspace mismatch");
      const snapshot = await readBotGroupRuntimeSnapshot(botAgent(params), {
        ...params,
        ...((params.remoteSessionId ?? target?.remoteSessionId)
          ? { remoteSessionId: params.remoteSessionId ?? target?.remoteSessionId }
          : {}),
        sessionId: params.taskId,
      });
      if (snapshot.pendingInteractions.length > 0) return "interaction";
      if (snapshot.control.phase === "running" || snapshot.control.phase === "prewarming")
        return "running";
      if (snapshot.queue.items.length > 0) return "queued";
      return null;
    },
    async cancelBotGroupInput(params) {
      const target = getTaskTarget(params.taskId);
      if (
        params.workspacePath &&
        taskKey(target) !== taskKey({ ...params, workspacePath: params.workspacePath })
      )
        throw new Error("Group task workspace mismatch");
      const workspace = {
        workspacePath: params.workspacePath ?? target.workspacePath,
        workspaceIdentity: params.workspaceIdentity ?? target.workspaceIdentity,
        ...((params.remoteSessionId ?? target.remoteSessionId)
          ? { remoteSessionId: params.remoteSessionId ?? target.remoteSessionId }
          : {}),
      };
      const snapshot = await readBotGroupRuntimeSnapshot(botAgent(workspace), {
        ...workspace,
        sessionId: target.taskId,
      });
      const item = snapshot.queue.items.find(
        (entry) => entry.sourceCommandId === params.sourceCommandId,
      );
      if (!item || item.dispatch.state !== "queued") throw new Error("Input is no longer queued");
      const source = item.botGroupSource;
      if (
        !source ||
        source.botId !== params.botId ||
        source.chatId !== params.chatId ||
        (params.actorId !== params.ownerId && source.senderId !== params.actorId)
      )
        throw new Error("Queue cancellation is not authorized");
      return botAgent(workspace).sendConversationCommandV4({
        ...workspace,
        envelope: createHostCommandEnvelope({
          type: "deleteQueueItem",
          sessionId: target.taskId,
          commandId: params.commandId,
          baseRevision: snapshot.revision,
          payload: { queueItemId: item.queueItemId },
        }),
      });
    },

    async submitBotGroupInput(params) {
      const target = getTaskTarget(params.taskId);
      if (
        params.workspacePath &&
        taskKey(target) !== taskKey({ ...params, workspacePath: params.workspacePath })
      )
        throw new Error("Group task workspace mismatch");
      const workspace = {
        workspacePath: params.workspacePath ?? target.workspacePath,
        workspaceIdentity: params.workspaceIdentity ?? target.workspaceIdentity,
        ...((params.remoteSessionId ?? target.remoteSessionId)
          ? { remoteSessionId: params.remoteSessionId ?? target.remoteSessionId }
          : {}),
      };
      const admissionKey = JSON.stringify([
        taskKey({ ...workspace, taskId: target.taskId }),
        workspace.remoteSessionId ?? null,
      ]);
      const version = topicAdmission.capture(admissionKey);
      // Bug 原因：Host 重启后任务索引仍在，但 CLI 尚未加载原会话；直接 admission
      // 会返回 sessionNotFound。复用后台订阅的冷恢复屏障，不依赖 Desktop 打开任务。
      await readBotGroupRuntimeSnapshot(botAgent(workspace), {
        ...workspace,
        sessionId: target.taskId,
      });
      const attachments = await uploadBotGroupAttachments(
        botAgent(workspace),
        { ...workspace, sessionId: target.taskId },
        params.attachments ?? [],
      );
      // 停止可以发生在附件上传期间；完成上传不代表旧输入仍允许被接受。
      if (params.source.threadId && version !== topicAdmission.capture(admissionKey)) {
        throw new Error("Topic input was cancelled during preparation");
      }
      const envelope = createHostCommandEnvelope({
        type: "sendText",
        sessionId: target.taskId,
        commandId: params.commandId,
        clientId: formatBotInputClientId(params.source),
        payload: {
          text: params.content,
          attachments,
          requestedDelivery: params.source.threadId ? "startNow" : "queue",
          botGroupSource: params.source,
          conversationQuotes: params.conversationQuotes,
          botDeliveryTarget: {
            provider: params.source.provider,
            botId: params.source.botId,
            providerUserId: params.source.chatId,
            chatType: "group",
            ...(params.source.threadId
              ? { threadId: params.source.threadId, rootMessageId: params.source.rootMessageId }
              : {}),
          },
        },
      });
      const send = async () => {
        try {
          return await botAgent(workspace).sendConversationCommandV4({
            ...workspace,
            envelope,
          });
        } catch (error) {
          // ACK 丢失时查询同一个命令，不能生成新 ID 重发输入。
          const query = await botAgent(workspace)
            .queryConversationCommandsV4({
              ...workspace,
              commands: [{ sessionId: target.taskId, commandId: params.commandId }],
            })
            .catch(() => null);
          const result = query?.results[0]?.result;
          if (result && result !== "unknown") return result;
          throw error;
        }
      };
      return params.source.threadId ? topicAdmission.run(admissionKey, version, send) : send();
    },

    async sendPrompt(params): Promise<CommandAck | undefined> {
      const storedTarget = getTaskTarget(params.taskId);
      const target = {
        ...storedTarget,
        ...(params.remoteSessionId ? { remoteSessionId: params.remoteSessionId } : {}),
      };
      return sendPromptToAgent(target, {
        traceId: params.traceId,
        queryId: params.queryId,
        messageId: params.messageId,
        content: params.content,
        attachments: params.attachments,
        ...turnAttributionOf(params),
        toolDenylist: params.toolDenylist,
        botDeliveryTarget: params.botDeliveryTarget,
        clientId: params.clientId,
        clientMode: params.clientMode,
        modelSelection: params.modelSelection,
        modelExecution: params.modelExecution,
      });
    },

    async deliverSessionMessage(
      _request: SessionMessageSendRequested,
    ): Promise<SessionMessageDeliveryResult> {
      unsupported("deliverSessionMessage");
    },

    async sendSessionMessageDeliveryResult(): Promise<void> {
      unsupported("sendSessionMessageDeliveryResult");
    },

    async enqueueTaskCommand(params): Promise<ZCodeEnqueueTaskCommandResult> {
      assertCurrentOwnerRun(params, params.ownerRunId);
      const workspaceKeyValue = workspaceKey(params);
      const command: ZCodeTaskRuntimeCommand = {
        commandId: params.commandId,
        taskId: params.taskId,
        traceId: params.traceId,
        queryId: params.queryId,
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        workspaceKey: workspaceKeyValue,
        status: "accepted",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        clientId: params.clientId,
        clientLabel: params.clientLabel,
        type: "send_prompt",
        content: params.content,
        attachments: params.attachments,
        // manual run / 手机 replayable 的 prompt 可能先进入 host command queue；
        // 若这里丢 automationId，drain 时会按普通用户输入发送，CronCreate 会重新暴露。
        automationId: params.automationId,
      };
      const key = taskKey(params);
      runtimeCommands.set(key, [...(runtimeCommands.get(key) ?? []), command]);
      // 手机 replayable host command 被 accepted 后，前端本地 drain 会主动跳过 hostCommand。
      // 因此 host 需要在当前 task 已空闲时自行触发消费；桌面 continuous 不调用该入口，不会受影响。
      scheduleRuntimeCommandDrain(params, "enqueue");
      return { accepted: true, command };
    },

    async promoteTaskCommand(params): Promise<ZCodeEnqueueTaskCommandResult> {
      assertCurrentOwnerRun(params, params.ownerRunId);
      const key = taskKey(params);
      const commands = runtimeCommands.get(key) ?? [];
      const command = commands.find((candidate) => candidate.commandId === params.commandId);
      if (!command) {
        throw Object.assign(new Error("Task command not found."), {
          code: "OWNER_COMMAND_FAILED",
        });
      }
      if (command.status === "running") {
        return { accepted: true, command };
      }
      const nextCommand = {
        ...command,
        status: "accepted" as const,
        updatedAt: Date.now(),
      };
      runtimeCommands.set(key, [nextCommand, ...commands.filter((item) => item !== command)]);
      scheduleRuntimeCommandDrain(params, "promote");
      return { accepted: true, command: nextCommand };
    },

    async cancelTaskCommand(params): Promise<ZCodeCancelTaskCommandResult> {
      assertCurrentOwnerRun(params, params.ownerRunId);
      const key = taskKey(params);
      const commands = runtimeCommands.get(key) ?? [];
      const command = commands.find((candidate) => candidate.commandId === params.commandId);
      if (!command) {
        logger.info(undefined, "ZCode task command 取消时已不存在", {
          commandId: params.commandId,
          taskId: params.taskId,
          workspaceIdentity: params.workspaceIdentity ?? null,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        return {
          canceled: true,
          commandId: params.commandId,
          reason: "not_found",
        };
      }
      if (command.status === "running") {
        logger.info(command.traceId, "ZCode task command 已开始运行，跳过取消", {
          commandId: command.commandId,
          taskId: params.taskId,
          workspaceIdentity: params.workspaceIdentity ?? null,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        return {
          canceled: false,
          commandId: command.commandId,
          reason: "already_running",
          status: command.status,
        };
      }
      // 手机 replayable 队列的事实源在 host runtime command queue。
      // 删除按钮不能只清 renderer 本地 store，否则下一次 snapshot 会把已 accepted 的命令恢复回来。
      setRuntimeCommands(
        params,
        commands.filter((item) => item.commandId !== command.commandId),
      );
      emitRuntimeCommandSnapshotUpdated(params, command.traceId);
      logger.info(command.traceId, "ZCode task command 已取消", {
        commandId: command.commandId,
        status: command.status,
        taskId: params.taskId,
        workspaceIdentity: params.workspaceIdentity ?? null,
        workspaceKey: resolveWorkspaceKey(params),
        workspacePath: params.workspacePath,
      });
      return {
        canceled: true,
        commandId: command.commandId,
        status: command.status,
      };
    },

    async stopGeneration(params): Promise<void> {
      const startedAt = Date.now();
      const target = params.workspacePath
        ? {
            taskId: params.taskId,
            workspacePath: params.workspacePath,
            workspaceIdentity: params.workspaceIdentity,
          }
        : getTaskTarget(params.taskId);
      logger.info(params.runId, "ZCode task facade stopGeneration 开始", {
        hasRunId: Boolean(params.runId),
        taskId: params.taskId,
        workspaceIdentity: target.workspaceIdentity ?? null,
        workspaceKey: resolveWorkspaceKey(target),
        workspacePath: target.workspacePath,
      });
      // session/stop → v4 stop 命令（goal-pause barrier 语义由 CLI 原生 handler 承接）。
      const ack = await options.zcodeAgentService.sendConversationCommandV4({
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        envelope: createHostCommandEnvelope({
          type: "stop",
          // 话题停止必须保留已观察到的执行身份；日志 traceId 不能替代 CLI 执行身份。
          payload: params.expectedForegroundExecutionId
            ? { expectedForegroundExecutionId: params.expectedForegroundExecutionId }
            : {},
          sessionId: params.taskId,
        }),
      });
      assertV4CommandAckOk("stop", ack, `session=${params.taskId}`);
      logger.info(params.runId, "ZCode task facade stopGeneration ACK", {
        durationMs: Date.now() - startedAt,
        taskId: params.taskId,
        workspaceIdentity: target.workspaceIdentity ?? null,
        workspaceKey: resolveWorkspaceKey(target),
        workspacePath: target.workspacePath,
      });
    },

    async compactSession(params) {
      // v4 compact 是 CAS 命令（必带 v4 conversation revision
      // 的 baseRevision），而本 facade 的 expectedRevision 是旧协议 stateRevision——
      // 两套计数器不可互换；replayable 侧拿到 v4 revision 前强行迁移会造成假 stale。
      // 且 v4 compact 无 instructions/runtimeModel 载荷。
      const target = params.workspacePath
        ? {
            taskId: params.taskId,
            workspacePath: params.workspacePath,
            workspaceIdentity: params.workspaceIdentity,
          }
        : getTaskTarget(params.taskId);
      notifySyncerSession(target);
      if (params.inputId) {
        activePromptInputIds.set(taskKey(target), params.inputId);
      }
      try {
        const result = await options.zcodeAgentService.compactSession({
          workspacePath: target.workspacePath,
          workspaceIdentity: target.workspaceIdentity,
          sessionId: params.taskId,
          inputId: params.inputId,
          instructions: params.instructions,
          expectedRevision: params.expectedRevision,
        });
        if (result.compact?.state === "accepted") {
          return result;
        }
        const meta = await syncTaskIndexSnapshot(result.snapshot);
        // compact 收敛是状态同步，不涉及归属；缺省 task_meta_changed 会触发全局 membership 重拉。
        emitWorkspaceTaskListChanged(target, meta, "task_status_changed");
        activePromptInputIds.delete(taskKey(target));
        return result;
      } catch (error) {
        activePromptInputIds.delete(taskKey(target));
        throw error;
      }
    },

    async goalSession(params) {
      // v4 sendGoalCommand 只覆盖 set 语义（text 原文），
      // 本 facade 的 action=resume/clear/replace/status 依赖旧 op 的结构化 action 面
      // （v4 侧 resumeGoal 是 CAS 命令，revision 计数器问题同 compactSession）。
      // 过渡归宿 = replayable v4 读路径收口，与 compactSession 同批。
      const startedAt = Date.now();
      const target = params.workspacePath
        ? {
            taskId: params.taskId,
            workspacePath: params.workspacePath,
            workspaceIdentity: params.workspaceIdentity,
          }
        : getTaskTarget(params.taskId);
      notifySyncerSession(target);
      const mayStartContinuation =
        params.action === "set" || params.action === "replace" || params.action === "resume";
      if (mayStartContinuation) {
        // goal resume 也可能启动新一轮模型输出，不能继承上一轮 live-only 工具。
        clearLiveToolProjection(target);
        clearStreamingToolInputCache(target);
      }
      if (params.inputId && mayStartContinuation) {
        activePromptInputIds.set(taskKey(target), params.inputId);
      }
      logger.info(params.inputId, "[zcode-task-service] goalSession start", {
        action: params.action,
        hasObjective: Boolean(params.objective?.trim()),
        mayStartContinuation,
        taskId: params.taskId,
        workspaceIdentity: target.workspaceIdentity,
        workspacePath: target.workspacePath,
      });
      const result = await options.zcodeAgentService.goalSession({
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        sessionId: params.taskId,
        inputId: params.inputId,
        action: params.action,
        objective: params.objective,
        expectedRevision: params.expectedRevision,
      });
      logger.info(params.inputId, "[zcode-task-service] goalSession agent 返回", {
        action: params.action,
        durationMs: Date.now() - startedAt,
        responseLength: result.response?.length ?? 0,
        startedTurn: result.startedTurn,
        status: result.snapshot.session.status,
        taskId: params.taskId,
        workspaceIdentity: target.workspaceIdentity,
        workspacePath: target.workspacePath,
      });
      const syncStartedAt = Date.now();
      const meta = await syncTaskIndexSnapshot(result.snapshot);
      // goal 动作后的快照收敛同为状态同步，不涉及归属，避免全局 membership 重拉。
      emitWorkspaceTaskListChanged(target, meta, "task_status_changed");
      logger.info(params.inputId, "[zcode-task-service] goalSession task index 同步完成", {
        action: params.action,
        durationMs: Date.now() - startedAt,
        startedTurn: result.startedTurn,
        status: result.snapshot.session.status,
        syncDurationMs: Date.now() - syncStartedAt,
        taskId: params.taskId,
        workspaceIdentity: target.workspaceIdentity,
        workspacePath: target.workspacePath,
      });
      if (!mayStartContinuation || result.snapshot.session.status !== "running") {
        activePromptInputIds.delete(taskKey(target));
      }
      return result;
    },

    async respondPermission(params): Promise<boolean> {
      const target = params.workspacePath
        ? {
            taskId: params.taskId,
            workspacePath: params.workspacePath,
            workspaceIdentity: params.workspaceIdentity,
          }
        : getTaskTarget(params.taskId);
      // permission 回执收敛 v4 resolveInteraction。
      // interactionId ≡ 业务 requestId（CLI interaction-broker 同源注册）；optionId 由
      // CLI 侧 buildProtocolPermissionOptions 精确回映 response（allow_project 的
      // permissionUpdates 持久化规则不丢，见 interaction-broker v4AnswerToPermissionResponse）。
      const ack = await options.zcodeAgentService.sendConversationCommandV4({
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        envelope: createHostCommandEnvelope({
          type: "resolveInteraction",
          payload: {
            interactionId: params.requestId,
            answer: { optionId: params.optionId },
          },
          sessionId: params.taskId,
        }),
      });
      assertV4CommandAckOk("resolveInteraction", ack, `permission ${params.requestId}`);
      return true;
    },

    async respondElicitation(params): Promise<boolean> {
      const target = params.workspacePath
        ? {
            taskId: params.taskId,
            workspacePath: params.workspacePath,
            workspaceIdentity: params.workspaceIdentity,
          }
        : getTaskTarget(params.taskId);
      // AskUserQuestion/plan-approval 回执收敛 v4 resolveInteraction。
      // answer.action/content 是 additive 扩展（多题答案/注解无损承载，CLI 侧
      // interaction-broker 优先按 action 精确映射，缺省回落 optionId/freeText 兼容路径）。
      const ack = await options.zcodeAgentService.sendConversationCommandV4({
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        envelope: createHostCommandEnvelope({
          type: "resolveInteraction",
          payload: {
            interactionId: params.requestId,
            answer: {
              action: params.action,
              ...(params.content ? { content: params.content } : {}),
            },
          },
          sessionId: params.taskId,
        }),
      });
      assertV4CommandAckOk("resolveInteraction", ack, `elicitation ${params.requestId}`);
      if (params.clientMode === "web-remote-replayable") {
        // 语义保真（原 agentService.respondUserInput 的 web-remote-replayable 分支）：
        // 手机远控应答后，桌面/其它 observer 需要显式响应事件清理同一 requestId 的弹窗；
        // v4 命令路径不再经过旧 respondUserInput，这里由 adapter 本地补投同一事件。
        emitTaskEvent(
          target,
          userInputResponseToElicitationStreamEvent(params.taskId, params.requestId, {
            action: params.action,
            content: params.content,
          }),
        );
      }
      return true;
    },

    async resumeTask(params): Promise<ZCodeTaskMeta> {
      // v4 侧 resume 已走 subscribe 冷恢复钩子
      // （CLI cold-resume），但 replayable resumeTask 还承担 model/thoughtLevel 回填与
      // snapshot→task index 正文索引回源，旧 resumeSession op 保留到 v4 生命周期收口。
      const explicitModel = params.model?.trim();
      const explicitThoughtLevel = params.thoughtLevel?.trim();
      const indexHints =
        explicitModel && explicitThoughtLevel
          ? {}
          : await resolveTaskIndexResumeHints(params, "resume_task");
      const model = explicitModel || indexHints.model;
      const thoughtLevel = explicitThoughtLevel || indexHints.thoughtLevel;
      const restored = await resumeSnapshotOrLegacy({
        taskId: params.taskId,
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        model,
        thoughtLevel,
        mcpServers: params.mcpServers,
        additionalDirectories: params.additionalDirectories,
      });
      if (restored.kind === "legacy") {
        const meta = await updateIndexedPresentation({
          ...restored.snapshot.meta,
          ...(params.automationId ? { cronAutomationId: params.automationId } : {}),
          // D48：pre-打点会话被闲时续跑恢复时补写归属；backfill 之外的双保险。
          ...(params.offPeakTaskId ? { offPeakTaskId: params.offPeakTaskId } : {}),
        });
        // 打开/恢复任务是快照收敛，不涉及归属，与 resumeSession 广播同语义。
        emitWorkspaceTaskListChanged(params, meta, "task_status_changed");
        return meta;
      }
      const snapshot = restored.snapshot;
      emitWorkspaceConfig(params, snapshot.settings);
      const snapshotMeta = await syncTaskIndexSnapshot(snapshot);
      const meta =
        params.automationId || params.offPeakTaskId
          ? await updateIndexedPresentation({
              ...snapshotMeta,
              ...(params.automationId ? { cronAutomationId: params.automationId } : {}),
              // 续跑时补写闲时归属标记。
              ...(params.offPeakTaskId ? { offPeakTaskId: params.offPeakTaskId } : {}),
            })
          : snapshotMeta;
      notifySyncerSession({
        taskId: meta.taskId,
        workspacePath: meta.workspacePath,
        workspaceIdentity: meta.workspaceIdentity,
      });
      return meta;
    },

    async listTasks(params): Promise<ZCodeTaskMeta[]> {
      const tasks = await taskIndexRepo.listTaskMetas({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        provider: GLM_PROVIDER,
        pinned: false,
        archived: false,
      });
      return tasks.map(rememberIndexedTaskMeta);
    },

    async listPinnedTaskIds(): Promise<string[]> {
      const tasks = await taskIndexRepo.listTaskMetas({
        provider: GLM_PROVIDER,
        pinned: true,
        archived: false,
      });
      return tasks.map((task) => task.taskId);
    },

    async listPinnedTasks(params): Promise<ZCodeTaskMeta[]> {
      const tasks = await taskIndexRepo.listTaskMetas({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        provider: GLM_PROVIDER,
        pinned: true,
        archived: false,
      });
      return tasks.map(rememberIndexedTaskMeta);
    },

    async listDeletedTaskIds(params): Promise<string[]> {
      return taskIndexRepo.listDeletedTaskIds({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        provider: GLM_PROVIDER,
      });
    },

    async listActiveTaskIds(params): Promise<string[]> {
      const key = workspaceKey(params);
      return taskIndexSyncer
        .activeTaskRefs()
        .filter((ref) => workspaceKey(ref) === key)
        .map((ref) => ref.taskId);
    },

    async listPermanentlyDeletedTaskIds(params) {
      return taskIndexRepo.listPermanentlyDeletedTaskIds(params);
    },

    // 保留全局搜索与 Controller 的显式 scopes 查询；项目侧栏不再维护旧远端列表镜像。
    async listTaskList(params: ZCodeTaskListQuery): Promise<ZCodeTaskListResult> {
      const result = await taskIndexRepo.queryTaskList({
        ...params,
        provider: GLM_PROVIDER,
      });
      return {
        ...result,
        items: result.items.map(rememberIndexedTaskMeta),
      };
    },

    async listArchivedTasks(params): Promise<ZCodeTaskMeta[]> {
      const tasks = await taskIndexRepo.listTaskMetas({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        provider: GLM_PROVIDER,
        archived: true,
      });
      return tasks.map(rememberIndexedTaskMeta);
    },

    async getTaskSnapshot(params): Promise<ZCodeTaskSnapshot | null> {
      const startedAt = Date.now();
      const resumeStartedAt = Date.now();
      const explicitModel = params.model?.trim();
      const explicitThoughtLevel = params.thoughtLevel?.trim();
      const shouldBackfillTaskIndexResumeHints =
        params.clientMode === "web-remote-replayable" &&
        params.resumeModelPolicy !== "ui-resolved-only" &&
        (!explicitModel || !explicitThoughtLevel);
      const indexHints = shouldBackfillTaskIndexResumeHints
        ? await resolveTaskIndexResumeHints(params, "replayable_snapshot")
        : {};
      const model = explicitModel || indexHints.model;
      const thoughtLevel = explicitThoughtLevel || indexHints.thoughtLevel;
      const restored = await resumeSnapshotOrLegacy({
        taskId: params.taskId,
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        // 手机 replayable 首屏 snapshot 会先于后续 resumeTask 读取。
        // 这里必须把 task meta 解析出的历史模型和 thoughtLevel 传进 session/resume，
        // 避免冷恢复用 workspace/draft 默认配置污染 context window 与思考强度。
        model,
        thoughtLevel,
      });
      const resumeDurationMs = Date.now() - resumeStartedAt;
      if (restored.kind === "legacy") {
        const limitStartedAt = Date.now();
        const legacySnapshot = limitTaskSnapshotMessages(restored.snapshot, params.messageLimit);
        const limitDurationMs = Date.now() - limitStartedAt;
        const indexStartedAt = Date.now();
        const indexedMeta = (await taskIndexRepo.getTaskMeta(params)) ?? legacySnapshot.meta;
        const indexDurationMs = Date.now() - indexStartedAt;
        logger.info(undefined, "[zcode-task-service] 历史快照读取完成", {
          clientMode: params.clientMode ?? "unknown",
          durationMs: Date.now() - startedAt,
          indexDurationMs,
          limitDurationMs,
          messageLimit: params.messageLimit ?? null,
          resumeDurationMs,
          snapshotKind: "legacy",
          stats: getTaskSnapshotMessageDiagnostics(legacySnapshot),
          taskId: params.taskId,
          workspaceIdentity: params.workspaceIdentity ?? null,
          workspacePath: params.workspacePath,
        });
        return { ...legacySnapshot, meta: indexedMeta };
      }
      const snapshot = restored.snapshot;
      const projectionStartedAt = Date.now();
      const zcodeSnapshot = limitTaskSnapshotMessages(
        snapshotToZCode(snapshot, {
          includeEmptyPendingElicitations: params.clientMode === "web-remote-replayable",
        }),
        params.messageLimit,
      );
      const projectionDurationMs = Date.now() - projectionStartedAt;
      // 恢复先从 CLI 对账事实，再补模型/思考深度/正文；快照不再推导持久状态。
      const indexStartedAt = Date.now();
      const indexedMeta = await syncTaskIndexSnapshot(snapshot);
      const indexDurationMs = Date.now() - indexStartedAt;
      logger.info(undefined, "[zcode-task-service] 历史快照读取完成", {
        clientMode: params.clientMode ?? "unknown",
        durationMs: Date.now() - startedAt,
        indexDurationMs,
        messageLimit: params.messageLimit ?? null,
        projectionDurationMs,
        resumeDurationMs,
        snapshotKind: "session",
        stats: getTaskSnapshotMessageDiagnostics(zcodeSnapshot),
        taskId: params.taskId,
        workspaceIdentity: params.workspaceIdentity ?? null,
        workspacePath: params.workspacePath,
      });
      return { ...zcodeSnapshot, meta: indexedMeta };
    },

    async getTaskSnapshotWithEtag(params) {
      const startedAt = Date.now();
      const snapshot = await service.getTaskSnapshot(params);
      if (!snapshot) {
        logger.info(undefined, "[zcode-task-service] 历史快照 ETag 读取为空", {
          clientMode: params.clientMode ?? "unknown",
          durationMs: Date.now() - startedAt,
          messageLimit: params.messageLimit ?? null,
          taskId: params.taskId,
          workspaceIdentity: params.workspaceIdentity ?? null,
          workspacePath: params.workspacePath,
        });
        return { snapshot: null };
      }
      const etagStartedAt = Date.now();
      const etag = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
      const etagDurationMs = Date.now() - etagStartedAt;
      if (params.ifNoneMatch && params.ifNoneMatch === etag) {
        logger.info(undefined, "[zcode-task-service] 历史快照 ETag 命中缓存", {
          clientMode: params.clientMode ?? "unknown",
          durationMs: Date.now() - startedAt,
          etagDurationMs,
          messageLimit: params.messageLimit ?? null,
          stats: getTaskSnapshotMessageDiagnostics(snapshot),
          taskId: params.taskId,
          workspaceIdentity: params.workspaceIdentity ?? null,
          workspacePath: params.workspacePath,
        });
        return { snapshot: null, etag, notModified: true };
      }
      logger.info(undefined, "[zcode-task-service] 历史快照 ETag 生成完成", {
        clientMode: params.clientMode ?? "unknown",
        durationMs: Date.now() - startedAt,
        etagDurationMs,
        messageLimit: params.messageLimit ?? null,
        stats: getTaskSnapshotMessageDiagnostics(snapshot),
        taskId: params.taskId,
        workspaceIdentity: params.workspaceIdentity ?? null,
        workspacePath: params.workspacePath,
      });
      return { snapshot, etag };
    },

    async getTaskSnapshotBody(): Promise<ZCodeTaskSnapshotBody | null> {
      return null;
    },

    async getTaskSnapshotRef(): Promise<ZCodeTaskSnapshotRefContent | null> {
      return null;
    },

    async getTaskSnapshotToolCallsSlice(): Promise<ZCodeTaskSnapshotToolCallsSlice | null> {
      return null;
    },

    async getTaskMeta(params): Promise<ZCodeTaskMeta | null> {
      const meta = await taskIndexRepo.getTaskMeta(params);
      return meta ? rememberIndexedTaskMeta(meta) : null;
    },

    async getTaskConfigOptions(params): Promise<ZCodeConfigOption[]> {
      const snapshot = await resumeSnapshot(getTaskTarget(params.taskId));
      return settingsToConfigOptions(snapshot.settings);
    },

    async getTaskModelSelection(params): Promise<ModelSelection | null> {
      const target = getTaskTarget(params.taskId);
      const snapshot = await options.zcodeAgentService.readSession({
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        sessionId: params.taskId,
      });
      return snapshot.settings.model.current ?? null;
    },

    async setAssistantMessageFeedback(params): Promise<ZCodeSessionFile> {
      const snapshot = await service.getTaskSnapshot(params);
      if (!snapshot) {
        unsupported("setAssistantMessageFeedback");
      }
      const assistantMessages = snapshot.messages.filter((message) => message.role === "assistant");
      const targetMessage = assistantMessages[params.turnIndex];
      if (targetMessage) {
        targetMessage.feedback = params.feedback as ZCodeAssistantMessageFeedback | undefined;
      }
      return snapshot;
    },

    async syncTaskSessionBinding(): Promise<ZCodeSyncTaskSessionBindingResult> {
      unsupported("syncTaskSessionBinding");
    },

    async switchAgent(): Promise<ZCodeSwitchAgentResult> {
      unsupported("switchAgent");
    },

    async scanImportableClaudeSessions(params: {
      workspacePath?: string;
      workspaceIdentity?: string;
      modifiedSince?: number;
      limit?: number;
    }): Promise<ZCodeImportableSessionCandidate[]> {
      // legacy ACP 下线后 scanImportableClaudeSessions 被留成空桩，迁移向导扫不到 ~/.claude/projects。
      // workspaceIdentity 仅影响导入落盘目录，扫描仍按 jsonl 内 cwd 与可选 workspacePath 过滤。
      void params.workspaceIdentity;
      return claudeNativeSessionImportRepo.scanImportableSessions({
        workspacePath: params.workspacePath,
        modifiedSince: params.modifiedSince,
        limit: params.limit,
      });
    },

    async importClaudeSessions(params: {
      workspacePath?: string;
      workspaceIdentity?: string;
      sessionIds: string[];
    }): Promise<ZCodeImportSessionsResult> {
      return importClaudeNativeSessions({
        taskIndexRepo,
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        sessionIds: params.sessionIds,
        createImportedSession: async (source) => {
          const targetWorkspaceIdentity = params.workspacePath
            ? params.workspaceIdentity
            : undefined;
          const snapshot = await options.zcodeAgentService.createSession({
            workspacePath: source.workspacePath,
            workspaceIdentity: targetWorkspaceIdentity,
            // 显式重新导入产生新 CLI 会话，不能用来源 hash 覆盖已删除或已继续对话的记录。
            sessionTraceId: createSessionTraceId(),
            persistence: "immediate",
            importedHistory: {
              source: "claudeCode",
              title: source.title,
              createdAt: source.createdAt,
              updatedAt: source.updatedAt,
              messages: source.messages.map((message) => ({
                role: message.role,
                content: message.content,
                timestamp: message.timestamp,
              })),
            },
          });
          const meta = await syncTaskIndexSnapshot(snapshot);
          // 导入后的任务必须是真实 ZCode session，setModel/sendPrompt 才能继续命中 runtime。
          // 同时保留 migrationSource，避免任务列表把 Claude Code 迁移历史当成本地新会话。
          return updateIndexedPresentation({ ...meta, migrationSource: "claudeCode" });
        },
        onTaskImported: (meta) => {
          rememberIndexedTaskMeta(meta);
          emitWorkspaceTaskListChanged(
            {
              workspacePath: meta.workspacePath,
              workspaceIdentity: meta.workspaceIdentity,
              taskId: meta.taskId,
            },
            meta,
            // 导入沿用 task_meta_changed 旧语义。
            "task_meta_changed",
          );
        },
      });
    },

    async setMode(params): Promise<void> {
      // session/setMode → v4 switchCollaborationMode（CAS，revision 收敛见
      // sendHostCasCommandV4）。v4 handler 不发旧 state.updated，观察端一致性与桌面
      // v4 工具条切换同批（读路径 v4 store 收口）；发起端由下方 resumeSnapshot 保真。
      const target = getTaskTarget(params.taskId);
      await switchCollaborationModeViaProtocol(target, toZCodeMode(params.mode) ?? "build");
      const snapshot = await resumeSnapshot(target);
      await syncTaskIndexSnapshot(snapshot);
    },

    async setConfigOption(params): Promise<ZCodeConfigOption[]> {
      const target = getTaskTarget(params.taskId);
      if (params.configId === MODEL_CONFIG_ID) {
        return service.setModel({
          taskId: params.taskId,
          traceId: params.traceId,
          modelSelection: parseModelPickerValue(params.value),
        });
      }
      if (params.configId === THOUGHT_LEVEL_CONFIG_ID) {
        // session/setThoughtLevel → v4 switchModelConfig（v4 无独立思考深度命令，
        // thought 字段承载；provider/model 取当前会话选型，与桌面 v4 工具条同一命令面）。
        // 同 provider 同 model 直切，不涉及 runtimeModel（provider 凭据）解析——这正是
        // setModel 尚不能迁移的原因（见下方 setModel 标注）。
        const current = await options.zcodeAgentService.readSession({
          workspacePath: target.workspacePath,
          workspaceIdentity: target.workspaceIdentity,
          sessionId: params.taskId,
        });
        const model = current.settings.model.current;
        // 未绑定会话可以查看，但单独切档位不能猜测 Provider/Model。
        if (!model) throw new Error("请先选择模型，再设置思考档位");
        await sendConfigCasCommandV4(
          target,
          "switchModelConfig",
          {
            provider: model.providerId,
            model: model.modelId,
            thought: params.value,
          },
          `session=${params.taskId} thought=${params.value}`,
        );
      } else if (params.configId === MODE_CONFIG_ID) {
        await switchCollaborationModeViaProtocol(
          target,
          toZCodeMode(params.value as ZCodeTaskMode) ?? "build",
        );
      }
      const snapshot = await resumeSnapshot(target);
      await syncTaskIndexSnapshot(snapshot);
      return settingsToConfigOptions(snapshot.settings);
    },

    async setModel(params): Promise<ZCodeConfigOption[]> {
      // replayable facade 仍依赖 legacy op 返回的 Session
      // Snapshot；模型执行事实已经收敛到目标 Worker Registry，Host 只发送 Selection。
      // 过渡归宿 = task facade 原生消费 V4 config 投影与 revision。
      const target = getTaskTarget(params.taskId);
      await options.zcodeAgentService.setModel({
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        sessionId: params.taskId,
        // replayable/legacy facade 的 modelId 可能只是 UI 运行态模型名（如 gpt-5.5）。
        // 多个自定义 provider 同名时只能信任 UI 传入的结构化 ModelSelection。
        model: params.modelSelection,
      });
      const snapshot = await resumeSnapshot(target);
      await syncTaskIndexSnapshot(snapshot);
      return settingsToConfigOptions(snapshot.settings);
    },

    async setAutomationSessionConfig(params): Promise<ZCodeConfigOption[]> {
      const target = getTaskTarget(params.taskId);
      const model = params.modelSelection;
      const thoughtLevel = params.thoughtLevel?.trim() ?? "";
      // automation 过去先走 legacy session/setModel，再发 V4 Think。若目标模型
      // 已带相同默认 Think，第二步会 noop 且不产 ModelSelected，导致 runtime 已切换但
      // conversation 投影仍显示旧模型。这里用一条 V4 命令原子更新 runtime 与投影。
      await sendConfigCasCommandV4(
        target,
        "switchModelConfig",
        {
          provider: model.providerId,
          model: model.modelId,
          thought: thoughtLevel,
        },
        `automation session=${params.taskId} model=${model.providerId}/${model.modelId} thought=${thoughtLevel}`,
      );
      if (thoughtLevel) {
        // 跨模型 switchModelConfig 会先采用目标模型默认 Think，避免误用源模型档位。
        // automation 的 thought 已由创建/编辑表单按目标模型校验，可在模型事件落地后
        // 再以同模型命令显式收敛；同默认值时 noop，非默认值时发布第二个 config delta。
        await sendConfigCasCommandV4(
          target,
          "switchModelConfig",
          {
            provider: model.providerId,
            model: model.modelId,
            thought: thoughtLevel,
          },
          `automation session=${params.taskId} thought=${thoughtLevel}`,
        );
      }
      if (params.mode?.trim()) {
        await switchCollaborationModeViaProtocol(target, toZCodeMode(params.mode) ?? "build");
      }
      const snapshot = await resumeSnapshot(target);
      await syncTaskIndexSnapshot(snapshot);
      return settingsToConfigOptions(snapshot.settings);
    },

    async getWorkspaceProviderConfigFile(params) {
      return {
        provider: GLM_PROVIDER,
        path: params.workspacePath,
        exists: false,
      };
    },

    async getTaskNativeSessionLogFile() {
      const path = resolveZCodeAgentCurrentLogFilePath();
      // 返回 ZCode Agent 的结构化日志 JSONL；日志行中的 sessionId 用于按当前任务排查。
      return { provider: GLM_PROVIDER, path, exists: existsSync(path) };
    },

    async getModelTrajectory(params) {
      // ZCode Agent 把 taskId 当作 sessionId 落盘 model-io（见本文件其它 sessionId: params.taskId 用法），
      // 这里按 sessionId 还原该 task 的模型调用轨迹，供 UI 侧边栏可视化。
      const trajectory = await readModelTrajectory(params.taskId, params.limit);
      logger.info(
        `[ZCodeTaskService] getModelTrajectory taskId=${params.taskId} records=${trajectory.records.length} files=${trajectory.sourceFiles.length} truncated=${trajectory.truncated}`,
      );
      return trajectory;
    },

    async getTaskTokenUsage(params): Promise<ZCodeTaskTokenUsageResult> {
      // 摘要面板需要展示 task 的累计模型消耗，不能复用 usage_update 的 context window。
      // 这里通过 ZCode Protocol 读 agent SQLite 的 model_usage 聚合，保持桌面和远控同一事实源。
      return options.zcodeAgentService.getTaskTokenUsage({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        sessionId: params.taskId,
      });
    },

    async getTaskSessionFilePath(params) {
      return {
        path: `${params.workspacePath}/${params.taskId}.zcode-session`,
        exists: false,
      };
    },

    async restartWorkspaceProcess(params): Promise<void> {
      await options.zcodeAgentService.disposeWorkspace(normalizeWorkspaceParams(params));
    },

    async previewArchivedTaskDeletion(params) {
      const preview = options.zcodeAgentService.previewSessionDeletion;
      if (!preview) throw new Error("session-data.unavailable");
      const archived = await taskIndexRepo.isTaskArchived(params);
      const result = await preview({
        sessionId: params.taskId,
        workspace: normalizeWorkspaceParams(params),
      });
      if (!archived && !result.completed && !result.incomplete)
        return { ...result, blockedReason: "not-archived" as const };
      return result;
    },

    async permanentlyDeleteArchivedTask(params) {
      const execute = options.zcodeAgentService.executeSessionDeletion;
      if (!execute) throw new Error("session-data.unavailable");
      if (!(await taskIndexRepo.reservePermanentDeletion(params)))
        return {
          sessionId: params.taskId,
          status: "blocked" as const,
          sessionIds: [],
          retainedArtifacts: 0,
          reason: "not-archived",
        };
      // 响应丢失时保留准入；重试向 CLI 查询同一身份的持久结果，不把未知结果当作可恢复会话。
      const result = await execute({
        sessionId: params.taskId,
        workspace: normalizeWorkspaceParams(params),
        revision: params.revision,
        operationId: params.operationId,
      });
      if (result.status === "deleted") {
        await taskIndexRepo.completePermanentDeletion(params, result.sessionIds);
        emitWorkspaceTaskListChanged(params, undefined, "task_deleted");
      } else if (result.status === "blocked") await taskIndexRepo.releasePermanentDeletion(params);
      return result;
    },

    async deleteTask(params): Promise<void> {
      await taskIndexSyncer.mutateSessionFacts(
        { ...params, sessionId: params.taskId },
        { type: "delete" },
      );
    },

    async deleteArchivedTask(params): Promise<boolean> {
      const meta = await taskIndexRepo.deleteArchivedTask(params);
      if (!meta) return false;
      await taskIndexSyncer.mutateSessionFacts(
        { ...params, sessionId: params.taskId },
        { type: "delete" },
      );
      emitWorkspaceTaskListChanged(params, meta, "task_deleted");
      return true;
    },

    async deleteArchivedTasks(params): Promise<ZCodeArchivedTaskDeletionResult> {
      const result: ZCodeArchivedTaskDeletionResult = {
        deletedTaskIds: [],
        skippedTaskIds: [],
        failedTaskIds: [],
      };
      const taskIds = [...new Set(params.taskIds)];
      if (taskIds.length === 0) return result;
      const startedAt = Date.now();
      for (const taskId of taskIds) {
        const target = {
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
          taskId,
        };
        try {
          // 保留逐项事务与归档 guard：一项失败不能回滚其它成功项，也不能提前隐藏失败项。
          const meta = await taskIndexRepo.deleteArchivedTask(target);
          if (!meta) {
            result.skippedTaskIds.push(taskId);
            continue;
          }
          await taskIndexSyncer.mutateSessionFacts(
            { ...target, sessionId: taskId },
            { type: "delete" },
          );
          result.deletedTaskIds.push(taskId);
        } catch (error) {
          result.failedTaskIds.push(taskId);
          logger.warn(undefined, "[ArchivedTaskDeletion] 批次目标删除失败", { ...target, error });
        }
      }
      if (result.deletedTaskIds.length > 0) {
        // 根因：循环调用单条接口会逐项广播，驱动 Host 与 UI 各自全量重读。
        // 批次完成只发一次 workspace 事件，仍使所有观察端换代 deleted membership，防止任务复活。
        emitWorkspaceTaskListChanged(params, undefined, "task_deleted");
      }
      logger.info(undefined, "[ArchivedTaskDeletion] batch completed", {
        workspaceKey: resolveWorkspaceKey(params),
        requested: taskIds.length,
        deleted: result.deletedTaskIds.length,
        skipped: result.skippedTaskIds.length,
        failed: result.failedTaskIds.length,
        durationMs: Date.now() - startedAt,
      });
      return result;
    },

    async renameTask(params): Promise<ZCodeTaskMeta> {
      const meta = await taskIndexSyncer.mutateSessionFacts(
        { ...params, sessionId: params.taskId },
        { type: "rename", title: params.title },
      );
      if (!meta) throw new Error("task.not-found");
      return meta;
    },

    async setTaskPinned(params): Promise<ZCodeTaskMeta> {
      const meta = await updateIndexedTaskState(params, {
        pinned: params.pinned,
      });
      emitWorkspaceTaskListChanged(params, meta, params.pinned ? "task_pinned" : "task_unpinned");
      return meta;
    },

    async setTaskUnread(params): Promise<ZCodeTaskMeta> {
      if (!params.unread && typeof params.expectedUnreadAt === "number") {
        const result = await taskIndexRepo.clearTaskUnreadIfMatches({
          taskId: params.taskId,
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
          expectedUnreadAt: params.expectedUnreadAt,
        });
        // Bug 原因：旧手机点击可能晚于新的终态未读到达。CAS 未命中时必须把当前 meta
        // 广播出去让 renderer 对账，不能先乐观清除后留下 renderer-only 已读状态。
        if (result.cleared) {
          emitWorkspaceTaskListChanged(params, result.meta, "task_meta_changed");
        }
        return result.meta;
      }

      const unreadAt = params.unread ? Date.now() : undefined;
      const meta = await updateIndexedTaskState(params, { unreadAt });
      // Bug 原因：repository 可能为避免同毫秒 CAS 版本碰撞而推进 unreadAt；
      // 必须把最终持久值广播给 renderer 对账，否则后续 snapshot 会继续暴露旧 marker。
      // unread 归属在 tasks-index、sessions-index 不携带，必须走 task_meta_changed 触发 membership 重拉。
      emitWorkspaceTaskListChanged(params, meta, "task_meta_changed");
      return meta;
    },

    async archiveTask(params): Promise<ZCodeTaskMeta> {
      const meta = await updateIndexedTaskState(params, { archived: true });
      emitWorkspaceTaskListChanged(params, meta, "task_archived");
      return meta;
    },

    async unarchiveTask(params): Promise<ZCodeTaskMeta> {
      const meta = await updateIndexedTaskState(params, { archived: false });
      emitWorkspaceTaskListChanged(params, meta, "task_unarchived");
      return meta;
    },

    async branchTaskFromPrompt(): Promise<ZCodeTaskCreateResult> {
      unsupported("branchTaskFromPrompt");
    },

    onDynamicStreamEvent(taskId: string): Event<ZCodeStreamEvent> {
      return getGlobalTaskEmitter(taskId).event;
    },

    onDynamicTaskTerminalOutcome(taskId: string): Event<ZCodeTaskTerminalOutcome> {
      // 合并迁移：V4 syncer 只暴露归一化后的终态 kind，不再携带旧协议 event payload。
      // automation 只需要稳定收口运行结果，因此 completed/failed 在此映射为公开 outcome。
      return (listener) =>
        taskIndexSyncer.onSessionTerminalEvent((terminal) => {
          if (terminal.target.sessionId !== taskId) {
            return;
          }
          const target = {
            taskId,
            workspacePath: terminal.target.workspacePath,
            workspaceIdentity: terminal.target.workspaceIdentity,
          };
          const inputId = activePromptInputIds.get(taskKey(target));
          listener({
            taskId,
            ...(inputId ? { inputId } : {}),
            outcome: terminal.kind === "turn.failed" ? "failed" : "succeeded",
          });
        });
    },

    onDynamicTaskReady(taskId: string): Event<ZCodeTaskReadyOutcome> {
      return (listener) =>
        taskIndexSyncer.onSessionReadyEvent((ready) => {
          if (ready.target.sessionId !== taskId) {
            return;
          }
          listener({ taskId, reason: ready.reason });
        });
    },

    onDynamicTaskEvent(params): Event<ZCodeStreamEvent> {
      const target = {
        taskId: params.taskId,
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
      };
      rememberTaskTarget(target);
      return (listener) => {
        const localDisposable = getTaskEmitter(target).event(listener);
        if (legacySnapshotTaskKeys.has(taskKey(target))) {
          // Bugfix: legacy ACP task 没有 zcode-cli sqlite session，恢复后只能作为只读历史。
          // 若继续向 ZCode Protocol 建 desktop-continuous/replayable 订阅，会反复触发
          // Session is not active 并刷爆日志；本地 emitter 已足够承接 rename/archive 等元数据事件。
          return localDisposable;
        }
        // M5 ③-2 复核（2026-07-06）：这里仍是 services/ 内旧 session/subscribe 词表的
        // 最后消费点（replayable/bots 的 stream 投影源）。写路径（send/stop/交互回执）
        // 本波已收敛 v4 命令；读路径消费方是 bots handleStreamEvent（10 种事件词表）与
        // host 镜像 taskRealtimePort（词表同为 ZCodeStreamEvent），二者换 v4 帧 = relay
        // 协议 + 手机 store + bots 投影整波重做（且 ui/store 本波由并行 agent 主修，避让）。
        // 死期改判 = replayable 读路径 v4 store 波次（波次 3），与 host/index.ts 镜像、
        // mapStateUpdated/mapServiceEvent、agentService.onDynamicSessionEvent 同批摘除。
        const upstreamDisposable = options.zcodeAgentService.onDynamicSessionEvent({
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
          sessionId: params.taskId,
          deliveryKind: toZCodeDeliveryKind(params.deliveryKind),
          includeSnapshot: params.deliveryKind === "replayable",
        })((event) => mapServiceEvent(target, event));
        return {
          dispose() {
            upstreamDisposable.dispose();
            localDisposable.dispose();
          },
        };
      };
    },

    onDynamicWorkspaceEvent(workspace): Event<ZCodeWorkspaceEvent> {
      return taskIndexSyncer.onDynamicWorkspaceEvent(workspace);
    },

    onError: errorEmitter.event,

    disposeAll(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      memoryDiagnostics.dispose();
      // syncer 持有 agentService 的 v4 帧订阅（sessions-index/workspace-config），
      // 必须在 agentService.disposeAll 前释放，否则 emitter dispose 时仍会回调到已失效的 syncer。
      // workspaceEmitters 已下沉到 syncer，由 syncer.disposeAll 统一回收。
      taskIndexSyncer.disposeAll();
      for (const scope of botConnectionScopes.values()) void scope.dispose();
      botConnectionScopes.clear();
      options.zcodeAgentService.disposeAll();
      disposeLocalTaskState();
    },

    async disposeAllAndWait(): Promise<void> {
      if (disposed) {
        return;
      }
      disposed = true;
      // app 退出必须先断开 task index syncer 的订阅，再等待 agent 进程树完成清理；
      // 否则 host 退出时会把 zcode-cli 的 SIGKILL 兜底 timer 一起带走。
      taskIndexSyncer.disposeAll();
      await Promise.all([...botConnectionScopes.values()].map((scope) => scope.dispose()));
      botConnectionScopes.clear();
      await disposeZCodeAgentServiceAndWait();
      disposeLocalTaskState();
    },
  };

  return service;
}

function normalizeWorkspaceParams(params: {
  workspacePath: string;
  workspaceIdentity?: string;
}): ZCodeAgentWorkspaceTarget {
  return {
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity,
  };
}

function deriveTitleFromSnapshot(snapshot: ZCodeSessionStateSnapshot): string {
  return resolveZCodeVisibleSessionTitle({
    title: snapshot.session.title,
    messages: snapshot.messages,
    target: snapshot.projection.target,
  });
}

function normalizeSnapshotMessageLimit(messageLimit: number | undefined): number | undefined {
  if (!messageLimit || !Number.isFinite(messageLimit) || messageLimit <= 0) {
    return undefined;
  }
  return Math.floor(messageLimit);
}

function buildSnapshotHistory(
  totalMessages: number,
  messageLimit: number,
): NonNullable<ZCodeTaskSnapshot["history"]> {
  return {
    truncatedBefore: totalMessages > messageLimit,
    totalMessages,
  };
}

function getTaskSnapshotMessageDiagnostics(snapshot: ZCodeTaskSnapshot) {
  let assistantMessages = 0;
  let userMessages = 0;
  let toolCalls = 0;
  let bodyRefs = 0;
  let toolSliceMessages = 0;
  let contentChars = 0;
  let thoughtChars = 0;

  for (const message of snapshot.messages) {
    if (message.role === "assistant") {
      assistantMessages += 1;
    } else {
      userMessages += 1;
    }
    toolCalls += message.tools?.length ?? 0;
    bodyRefs += message.bodyRefs?.length ?? 0;
    if (message.toolSlice) {
      toolSliceMessages += 1;
    }
    contentChars += message.content.length;
    thoughtChars += message.thought?.length ?? 0;
  }

  return {
    assistantMessages,
    bodyRefs,
    contentChars,
    fileChanges: snapshot.fileChanges?.length ?? 0,
    historyTotalMessages: snapshot.history?.totalMessages ?? snapshot.messages.length,
    messages: snapshot.messages.length,
    slashCommands: snapshot.slashCommands?.length ?? 0,
    thoughtChars,
    toolCalls,
    toolSliceMessages,
    truncatedBefore: snapshot.history?.truncatedBefore ?? false,
    userMessages,
  };
}

function limitTaskSnapshotMessages(
  snapshot: ZCodeTaskSnapshot,
  messageLimit: number | undefined,
): ZCodeTaskSnapshot {
  const limit = normalizeSnapshotMessageLimit(messageLimit);
  if (!limit) {
    return snapshot;
  }
  const history = buildSnapshotHistory(snapshot.messages.length, limit);
  return {
    ...snapshot,
    messages: history.truncatedBefore ? snapshot.messages.slice(-limit) : snapshot.messages,
    // 手机 replayable 首屏为了性能只拿尾部窗口。
    // UI 不能再用“返回条数是否等于 limit”猜测是否还有更早历史，因为短尾部终态快照也可能是裁剪窗口。
    history,
  };
}

function parseModelPickerValue(value: string): ModelSelection {
  const customModel = decodeCustomModelValue(value);
  if (customModel?.providerId && customModel.modelName) {
    // UI 下拉的 custom:provider:model 只是展示态，不能原样传给 zcode-cli。
    // 旧解析会先按冒号截断成 custom，最终下发 glm/custom，触发 Unsupported model。
    return {
      providerId: customModel.providerId,
      modelId: customModel.modelName,
    };
  }

  return parseSharedModelSelection(value);
}

function toZCodeMode(mode: ZCodeTaskMode | undefined): ZCodeSessionMode | undefined {
  switch (mode) {
    case "plan":
      return "plan";
    case "edit":
      // automation UI 保存的“自动编辑”使用 canonical edit。旧映射漏掉该值，
      // 调用方的 ?? build 会把权限模式静默降级成“变更前确认”。
      return "edit";
    case "guarded":
      return "guarded";
    case "yolo":
    case "bypassPermissions":
    case "dontAsk":
      return "yolo";
    case "auto":
      return "auto";
    case "build":
    case "default":
    case "acceptEdits":
    case "autoEdit":
      return "build";
    default:
      return undefined;
  }
}

function fromZCodeMode(mode: ZCodeSessionMode): ZCodeTaskMode {
  return mode === "build" ? "build" : mode;
}

function addSessionForkSnapshotFallback(
  messages: ZCodePersistedMessage[],
  snapshot: ZCodeSessionStateSnapshot,
): ZCodePersistedMessage[] {
  const parentSessionId = snapshot.session.parentSessionId;
  if (
    !parentSessionId ||
    messages.some((message) => message.syntheticTimeline?.type === "session_fork")
  ) {
    return messages;
  }

  return [
    ...messages,
    {
      id: `zcode-timeline-fork-${parentSessionId}-`,
      role: "user",
      content: "",
      timestamp: snapshot.session.createdAt,
      // 旧的纯对话 fork 没有落库 synthetic notice，只能从 session.parentSessionId
      // 恢复一个不可跳转的分割线，避免历史 fork 会话完全看不到来源边界。
      syntheticTimeline: {
        version: 1,
        kind: "synthetic",
        type: "session_fork",
        display: "separator",
        parentSessionId,
        targetMessageId: "",
      },
    },
  ];
}

function addGoalVerificationTimelineSnapshotFallback(
  messages: ZCodePersistedMessage[],
  snapshot: ZCodeSessionStateSnapshot,
): ZCodePersistedMessage[] {
  const timeline = snapshot.runtime.goalVerificationTimeline ?? [];
  if (timeline.length === 0) {
    return messages;
  }
  const existingIds = new Set(
    messages
      .map((message) =>
        message.syntheticTimeline?.type === "goal_verification"
          ? goalVerificationTimelineIdentityKey(message.syntheticTimeline)
          : null,
      )
      .filter((id): id is string => Boolean(id)),
  );
  const timelineMessages = timeline
    .filter((item) => !existingIds.has(goalVerificationTimelineIdentityKey(item)))
    .map<ZCodePersistedMessage>((item) => ({
      id: goalVerificationTimelineMessageId(item),
      role: "assistant",
      content: "",
      timestamp: item.startedAt ?? item.updatedAt,
      // goal verifier lifecycle 是 agent snapshot 的持久状态，不一定有
      // 对应 message history；task facade 也要按 target+iteration 和 anchor 补 divider，避免恢复后重复或错位。
      syntheticTimeline: item,
    }));
  if (timelineMessages.length === 0) {
    return messages;
  }
  return insertGoalVerificationTimelineMessages(messages, timelineMessages);
}

function goalVerificationTimelineIdentityKey(
  item: Extract<ZCodeGoalVerificationTimelineMeta, { type: "goal_verification" }>,
): string {
  if (typeof item.goalIteration === "number") {
    return `${item.targetId}:${item.goalIteration}`;
  }
  return `verification:${item.verificationId}`;
}

function goalVerificationTimelineMessageId(
  item: Extract<ZCodeGoalVerificationTimelineMeta, { type: "goal_verification" }>,
): string {
  if (typeof item.goalIteration === "number") {
    return `zcode-goal-verification-${item.targetId}-${item.goalIteration}`;
  }
  return `zcode-goal-verification-${item.verificationId}`;
}

function insertGoalVerificationTimelineMessages(
  messages: ZCodePersistedMessage[],
  timelineMessages: ZCodePersistedMessage[],
): ZCodePersistedMessage[] {
  const result = [...messages];
  for (const message of [...timelineMessages].sort(
    (left, right) => left.timestamp - right.timestamp,
  )) {
    const timeline = message.syntheticTimeline;
    const anchorIndex =
      timeline?.type === "goal_verification" && timeline.anchorAssistantMessageId
        ? findPersistedMessageIndexById(result, timeline.anchorAssistantMessageId)
        : -1;
    if (anchorIndex >= 0) {
      result.splice(goalVerificationAnchorInsertIndex(result, anchorIndex), 0, message);
      continue;
    }
    result.splice(timestampInsertIndex(result, message.timestamp), 0, message);
  }
  return result;
}

function normalizeGoalVerificationTimelineMessageOrder(
  messages: ZCodePersistedMessage[],
): ZCodePersistedMessage[] {
  const timelineMessages = messages.filter(
    (message) => message.syntheticTimeline?.type === "goal_verification",
  );
  if (timelineMessages.length === 0) {
    return messages;
  }
  // agent history 已存在的 verifier divider 也可能因为异步到达排到下一条用户输入后面；
  // task facade snapshot 必须按 anchor 重新投影，而不是只给缺失 divider 做 fallback。
  return insertGoalVerificationTimelineMessages(
    messages.filter((message) => message.syntheticTimeline?.type !== "goal_verification"),
    timelineMessages,
  );
}

function goalVerificationAnchorInsertIndex(
  messages: readonly ZCodePersistedMessage[],
  anchorIndex: number,
): number {
  let index = anchorIndex + 1;
  while (
    index < messages.length &&
    messages[index]?.syntheticTimeline?.type === "goal_verification"
  ) {
    index += 1;
  }
  return index;
}

function timestampInsertIndex(
  messages: readonly ZCodePersistedMessage[],
  timestamp: number,
): number {
  const index = messages.findIndex((message) => message.timestamp > timestamp);
  return index >= 0 ? index : messages.length;
}

function findPersistedMessageIndexById(
  messages: readonly ZCodePersistedMessage[],
  messageId: string,
): number {
  return messages.findIndex(
    (message) => message.id === messageId || message.mergedMessageIds?.includes(messageId) === true,
  );
}

function getSnapshotGoalActiveIterationCount(snapshot: ZCodeSessionStateSnapshot): number {
  const targetId = snapshot.projection.target?.targetId;
  const timeline =
    snapshot.runtime.goalVerificationTimeline?.filter(
      (item) => !targetId || item.targetId === targetId,
    ) ?? [];
  return getZCodeGoalActiveIterationCount({
    targetStatus: snapshot.projection.target?.status ?? null,
    timeline,
  });
}

function toZCodeDeliveryKind(
  deliveryKind: "continuous" | "bot-channel-continuous" | "replayable" | "mixed" | undefined,
): ZCodeDeliveryKind {
  return deliveryKind === "replayable" ? "web-remote-replayable" : "desktop-continuous";
}

function backgroundTaskNotificationToolUpdatesFromInput(params: {
  input: string | undefined;
  inputId: InputId | undefined;
  originMeta: unknown;
  taskId: string;
  traceId: TraceId;
}): Extract<ZCodeStreamEvent, { type: "tool_call_update" }>[] {
  // 终态与失败原文优先取本轮 originMeta 的结构化结果，不解析 summary 文本。
  // 合并轮的每条通知各自更新自己的工具。
  return parseZCodeBackgroundTaskNotifications(params.input, params.originMeta).map((parsed) => {
    const status = zcodeBackgroundTaskNotificationToolUpdateStatus(parsed.notification.status);
    return {
      type: "tool_call_update",
      taskId: params.taskId,
      traceId: params.traceId,
      ...(params.inputId ? { inputId: params.inputId } : {}),
      toolId: parsed.toolUseId,
      status,
      content: parsed.notification.result ?? parsed.notification.summary,
      // replayable 动态事件也必须把 notification error 放到标准 tool error，
      // 否则手机远控与桌面 continuous 的失败详情会产生分叉。
      // 修复原因：合并轮没有结构化结果，通知里也没有 <error>，失败详情原来是空的。
      ...(status === "failed"
        ? { error: zcodeBackgroundTaskNotificationFailureText(parsed.notification) }
        : {}),
      raw: attachZCodeBackgroundTaskNotificationToRaw(
        { toolCallId: parsed.toolUseId },
        parsed.notification,
      ),
    };
  });
}

function mapMessage(
  message: ZCodeMessageWithParts,
  goalIteration?: number,
  backgroundTaskNotifications?: ReadonlyMap<string, ZCodeBackgroundTaskNotificationInfo>,
): ZCodePersistedMessage {
  const tools: ZCodePersistedToolCall[] = [];
  const parts: ZCodePersistedMessagePart[] = [];
  const attachments =
    message.info.role === "user" ? mapPromptAttachmentsFromParts(message.parts) : undefined;
  let syntheticTimeline: ZCodeTimelineMeta | undefined;
  for (const part of message.parts) {
    if (part.type === "text") {
      // fork notice 等结构化 synthetic 消息把 timeline meta 写在 part.metadata 上；
      // 持久化层不带 metadata 字段，所以提取一份挂到 message 级别供 UI 渲染分隔条。
      if (!syntheticTimeline) {
        const fromText = extractSyntheticTimelineFromTextPart(part);
        if (fromText) {
          syntheticTimeline = fromText;
        }
      }
    } else if (part.type === "compaction" && !syntheticTimeline) {
      // compact 的模型 summary/timelineText 属于 agent 内部上下文，不能作为正文透出。
      // 持久化恢复只从结构化字段合成横线，展示文案由 UI/TUI 本地 i18n 决定。
      syntheticTimeline = synthesizeCompactionTimeline(part);
    }
  }
  for (const part of message.parts) {
    if (part.type === "text") {
      parts.push({ type: "content", content: part.text });
    } else if (part.type === "reasoning") {
      parts.push({ type: "thought", content: part.text });
    } else if (part.type === "tool") {
      const toolIndex = tools.length;
      tools.push(mapToolPart(part, backgroundTaskNotifications));
      parts.push({ type: "tool-call", toolIndex });
    }
  }
  return {
    id: message.info.messageId,
    role: message.info.role,
    content: textFromParts(message.parts),
    timestamp: message.info.time.created,
    // 未绑定恢复仍需呈现完整历史，不能为缺失的消息来源补默认模型。
    model: message.info.model ? formatModelPickerValue(message.info.model) : undefined,
    ...(syntheticTimeline ? { syntheticTimeline } : {}),
    ...(attachments ? { attachments } : {}),
    ...(message.info.role === "assistant"
      ? {
          ...(goalIteration ? { goalIteration } : {}),
          durationMs: message.info.time.completed
            ? message.info.time.completed - message.info.time.created
            : undefined,
          thought: reasoningFromParts(message.parts),
          tools: tools.length > 0 ? tools : undefined,
          parts: parts.length > 0 ? parts : undefined,
        }
      : {}),
  };
}

function mapPromptAttachmentsFromParts(
  parts: readonly ZCodeMessagePart[],
): ZCodePromptAttachment[] | undefined {
  const attachments = parts
    .filter((part): part is Extract<ZCodeMessagePart, { type: "file" }> => part.type === "file")
    .map(mapPromptAttachmentFromFilePart)
    .filter((attachment): attachment is ZCodePromptAttachment => attachment !== undefined);
  return attachments.length > 0 ? attachments : undefined;
}

function mapPromptAttachmentFromFilePart(
  part: Extract<ZCodeMessagePart, { type: "file" }>,
): ZCodePromptAttachment | undefined {
  const mimeType = part.mime || "application/octet-stream";
  const metadata = asRecord(part.metadata);
  const filename = part.filename?.trim() || filenameFromPathLike(part.url) || "attachment";
  const sizeBytes = numberValue(metadata.sizeBytes);
  const dataBase64 = dataBase64FromDataUrl(part.url);
  const localPath = localPathFromAttachmentPart(part.url, metadata);

  // 历史恢复链路之前只把 file part 当作模型上下文，不回填 UI 的 attachments 字段。
  // 用户消息恢复后附件 chip 因此消失；这里从 agent 持久化的 file part 反投影回发送时的附件形态。
  if (mimeType.startsWith("image/")) {
    return {
      kind: "image",
      filename,
      mimeType,
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
      ...(dataBase64 ? { dataBase64 } : {}),
      ...(localPath ? { localPath } : {}),
    };
  }

  if (mimeType.startsWith("audio/")) {
    return {
      kind: "audio",
      filename,
      mimeType,
      ...(dataBase64 ? { dataBase64 } : {}),
      ...(localPath ? { localPath } : {}),
    };
  }

  if (mimeType.startsWith("video/")) {
    return {
      kind: "video",
      filename,
      mimeType,
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
      ...(dataBase64 ? { dataBase64 } : {}),
      ...(localPath ? { localPath } : {}),
    };
  }

  const preview = asRecord(metadata.preview);
  const textContent = !localPath ? stringValue(preview.text) : undefined;
  return {
    kind: "file",
    filename,
    mimeType,
    sizeBytes: sizeBytes ?? 0,
    ...(dataBase64 ? { dataBase64 } : {}),
    ...(textContent !== undefined ? { textContent } : {}),
    ...(localPath ? { localPath } : {}),
  };
}

function dataBase64FromDataUrl(value: string): string | undefined {
  const match = /^data:[^;,]+;base64,(.*)$/i.exec(value);
  return match?.[1] || undefined;
}

function localPathFromAttachmentPart(
  url: string,
  metadata: Record<string, unknown>,
): string | undefined {
  const originalUrl = stringValue(metadata.originalUrl);
  if (originalUrl && isAbsolutePathLike(originalUrl)) {
    return originalUrl;
  }
  return isAbsolutePathLike(url) ? url : undefined;
}

function isAbsolutePathLike(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("\\\\");
}

function filenameFromPathLike(value: string): string | undefined {
  if (value.startsWith("data:")) {
    return undefined;
  }
  const pathPart = value.split(/[?#]/u)[0] ?? "";
  const segments = pathPart.split(/[\\/]/u).filter(Boolean);
  const filename = segments.at(-1)?.trim();
  return filename && !filename.includes("://") ? filename : undefined;
}

function extractSyntheticTimelineFromTextPart(
  part: Extract<ZCodeMessagePart, { type: "text" }>,
): ZCodeTimelineMeta | undefined {
  const metadata = part.metadata;
  if (!metadata || typeof metadata !== "object") return undefined;
  const forkContext = (metadata as Record<string, unknown>)["forkContext"];
  if (!forkContext || typeof forkContext !== "object") return undefined;
  const ctx = forkContext as Record<string, unknown>;
  if (ctx["kind"] !== "session_fork") return undefined;
  const parentSessionId = typeof ctx["parentSessionId"] === "string" ? ctx["parentSessionId"] : "";
  const targetMessageId = typeof ctx["targetMessageId"] === "string" ? ctx["targetMessageId"] : "";
  const targetCheckpointId =
    typeof ctx["targetCheckpointId"] === "string" ? ctx["targetCheckpointId"] : undefined;
  if (!parentSessionId || !targetMessageId) return undefined;
  return {
    version: 1,
    kind: "synthetic",
    type: "session_fork",
    display: "separator",
    parentSessionId,
    targetMessageId,
    ...(targetCheckpointId ? { targetCheckpointId } : {}),
    ...(typeof ctx["restoredFileCount"] === "number"
      ? { restoredFileCount: ctx["restoredFileCount"] }
      : {}),
  };
}

function synthesizeCompactionTimeline(
  part: Extract<ZCodeMessagePart, { type: "compaction" }>,
): ZCodeTimelineMeta | undefined {
  const metadata = asRecord(part.metadata);
  const operationId = stringValue(metadata.operationId) ?? part.partId;
  const status = timelineStatusValue(metadata.timelineStatus);
  if (!status && !part.summaryMessageId) {
    // compact summary user message 也带 compaction metadata，
    // 但它是模型上下文，不是 UI timeline；否则 snapshot 恢复会多渲染一条横线。
    return undefined;
  }
  const trigger = timelineTriggerValue(metadata.trigger) ?? (part.auto ? "auto" : "manual");
  const replace = booleanValue(metadata.replace);
  const reason = part.reason ?? stringValue(metadata.reason);
  const boundaryId = stringValue(metadata.boundaryId) ?? part.summaryMessageId;
  const summaryMessageId = part.summaryMessageId ?? stringValue(metadata.summaryMessageId);
  const preCompactTokenCount = numberValue(metadata.preCompactTokenCount);
  const postCompactTokenCount = numberValue(metadata.postCompactTokenCount);
  const truePostCompactTokenCount = numberValue(metadata.truePostCompactTokenCount);
  const attempt = numberValue(metadata.attempt);
  const maxAttempts = numberValue(metadata.maxAttempts);
  const startedAt = numberValue(metadata.startedAt);
  const endedAt = numberValue(metadata.endedAt);
  return {
    version: 1,
    kind: "synthetic",
    type: "context_compaction",
    operationId,
    status: status ?? "completed",
    trigger,
    display: "separator",
    ...(replace !== undefined ? { replace } : {}),
    ...(reason ? { reason } : {}),
    ...(boundaryId ? { boundaryId } : {}),
    ...(summaryMessageId ? { summaryMessageId } : {}),
    ...(preCompactTokenCount !== undefined ? { preCompactTokenCount } : {}),
    ...(postCompactTokenCount !== undefined ? { postCompactTokenCount } : {}),
    ...(truePostCompactTokenCount !== undefined ? { truePostCompactTokenCount } : {}),
    ...(attempt !== undefined ? { attempt } : {}),
    ...(maxAttempts !== undefined ? { maxAttempts } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
  };
}

function mapToolPart(
  part: Extract<ZCodeMessagePart, { type: "tool" }>,
  backgroundTaskNotifications?: ReadonlyMap<string, ZCodeBackgroundTaskNotificationInfo>,
): ZCodePersistedToolCall {
  const state = part.state;
  const taskNotification = backgroundTaskNotifications?.get(part.callId);
  // ZCode Protocol 的 part.callId 是实时流和终态 snapshot 共同的工具身份。
  // 以前只保存 metadata 会丢掉 toolCallId，手机 replayable 里 result-only 临时工具就无法被终态快照覆盖。
  const raw = attachZCodeBackgroundTaskNotificationToRaw(
    attachToolCallIdToRaw("metadata" in state ? (state.metadata ?? state) : state, part.callId),
    taskNotification,
  );
  if (state.status === "completed") {
    // snapshot 里的 completed 是 background Agent launch ACK；failed
    // notification 必须在 replayable restore 中覆盖它，但不能顺带改变 stopped 等既有语义。
    const notificationStatus = taskNotification?.status
      ? zcodeBackgroundTaskNotificationToolUpdateStatus(taskNotification.status)
      : undefined;
    const notificationFailed = notificationStatus === "failed";
    return {
      toolName: part.tool,
      title: state.title || part.tool,
      kind: part.tool,
      status: notificationFailed ? "failed" : "completed",
      input: state.input,
      output: state.output,
      ...(notificationFailed && taskNotification
        ? { error: zcodeBackgroundTaskNotificationFailureText(taskNotification) }
        : {}),
      raw,
    };
  }
  if (state.status === "error") {
    return {
      toolName: part.tool,
      title: part.tool,
      kind: part.tool,
      status: "failed",
      input: state.input,
      error: state.error,
      raw,
    };
  }
  return {
    toolName: part.tool,
    title: "title" in state && state.title ? state.title : part.tool,
    kind: part.tool,
    input: state.input,
    raw,
  };
}

function attachToolCallIdToRaw(raw: unknown, toolCallId: string): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { toolCallId, raw };
  }
  return {
    ...raw,
    toolCallId:
      typeof (raw as Record<string, unknown>).toolCallId === "string"
        ? (raw as Record<string, unknown>).toolCallId
        : toolCallId,
  };
}

function textFromParts(parts: readonly ZCodeMessagePart[]): string {
  return textFromZCodeMessageParts(parts);
}

function reasoningFromParts(parts: readonly ZCodeMessagePart[]): string | undefined {
  const text = parts
    .filter(
      (part): part is Extract<ZCodeMessagePart, { type: "reasoning" }> => part.type === "reasoning",
    )
    .map((part) => part.text)
    .join("");
  return text || undefined;
}

function fromZCodeGoal(goal: unknown): ZCodeTaskGoal {
  const record = asRecord(goal);
  const time = asRecord(record.time);
  const status = stringValue(record.status);
  return {
    sessionID: stringValue(record.sessionID) ?? stringValue(record.sessionId) ?? "",
    targetID: stringValue(record.targetID) ?? stringValue(record.targetId) ?? "",
    objective: stringValue(record.objective) ?? "",
    summaryTitle: stringValue(record.summaryTitle) ?? null,
    status: isZCodeTaskGoalStatus(status) ? status : "active",
    tokenBudget: typeof record.tokenBudget === "number" ? record.tokenBudget : null,
    tokensUsed: numberValue(record.tokensUsed) ?? 0,
    timeUsedSeconds: numberValue(record.timeUsedSeconds) ?? 0,
    time: {
      created: numberValue(time.created) ?? numberValue(record.createdAt) ?? 0,
      updated: numberValue(time.updated) ?? numberValue(record.updatedAt) ?? 0,
    },
  };
}

function isZCodeTaskGoalStatus(status: string | undefined): status is ZCodeTaskGoal["status"] {
  return (
    status === "active" ||
    status === "paused" ||
    status === "budget_limited" ||
    status === "complete"
  );
}

function sessionTodosToPlanSteps(
  todos: ZCodeSessionStateSnapshot["todos"],
): ZCodePlanStep[] | null {
  if (!todos || todos.length === 0) {
    return null;
  }
  return todos.map((todo, index) => ({
    id: `todo-${index}`,
    status: todo.status,
    title: todo.content,
  }));
}

function sessionGoalStatsToRuntime(
  stats: ZCodeSessionStateSnapshot["goalStats"],
): ZCodeTaskGoalStats | null {
  return stats ? { ...stats } : null;
}

function sessionTodoGroupsToRuntime(
  groups: ZCodeSessionStateSnapshot["todoGroups"],
): ZCodeTodoGroup[] | null {
  if (!groups || groups.length === 0) {
    return null;
  }
  return groups.map((group) => ({
    id: group.id,
    source: group.source,
    ...(group.goalIteration ? { goalIteration: group.goalIteration } : {}),
    ...(group.targetId ? { targetId: group.targetId } : {}),
    ...(group.startedAt ? { startedAt: group.startedAt } : {}),
    ...(group.updatedAt ? { updatedAt: group.updatedAt } : {}),
    todos: group.todos.map((todo, index) => ({
      id: `${group.id}-todo-${index}`,
      status: todo.status,
      title: todo.content,
    })),
  }));
}

function mapStateUpdated(
  params: TaskTarget,
  notification: ZCodeStateUpdatedNotification,
): ZCodeStreamEvent[] {
  const parsedSettings = zcodeSessionSettingsStateSchema.safeParse(notification.patch);
  if (!parsedSettings.success) {
    return [];
  }
  const traceId = generateTraceId(params.taskId);
  return [
    {
      type: "mode_update",
      taskId: params.taskId,
      traceId,
      currentModeId: normalizeAvailableZCodeMode(parsedSettings.data.mode.current),
      availableModes: getZCodeAgentAvailableModes(),
    },
    {
      type: "glm_agent_model_state_update",
      taskId: params.taskId,
      traceId,
      version: 1,
      sessionId: params.taskId,
      reason:
        notification.reason === "thought_level_changed"
          ? "thought_level_changed"
          : notification.reason === "model_changed"
            ? "model_changed"
            : "session_initialized",
      model: {
        currentValue: formatModelPickerValue(parsedSettings.data.model.current),
      },
      thoughtLevel: {
        enabled: parsedSettings.data.thoughtLevel.enabled,
        currentValue: parsedSettings.data.thoughtLevel.current,
        options: parsedSettings.data.thoughtLevel.available.map((option) => ({
          value: option.value,
          name: option.label,
        })),
      },
      contextWindow: {
        tokens:
          parsedSettings.data.model.available.find(
            (option) =>
              formatModelPickerValue(option.ref) ===
              formatModelPickerValue(parsedSettings.data.model.current),
          )?.contextWindow ?? 0,
      },
    },
  ];
}

function mapSessionEvent(
  params: TaskTarget,
  event: ZCodeSessionEvent,
  streamedTurnText: Map<string, { messageId?: string; text: string }>,
  activePromptInputId?: InputId,
  toolProjectionMemory?: ZCodeToolProjectionMemory,
  backgroundTaskControlsByTaskKey?: Map<string, ZCodeBackgroundTaskControlItem[]>,
  hasActiveApiRetry = false,
): ZCodeStreamEvent[] {
  const protocolTraceId = event.traceId ?? generateTraceId(params.taskId);
  const payload = asRecord(event.payload);
  const inputId = stringValue(payload.inputId);
  const queryId = stringValue(payload.queryId);
  // 兼容层对外的 traceId 语义是“一次用户输入到本轮回复结束”的轮次标识。
  // ZCode Protocol runtime trace 只在事件没有 inputId 时兜底，避免同一轮 chunk/tool/complete 被拆成不同 trace。
  const eventInputId = inputId ?? activePromptInputId;
  const traceId = eventInputId ?? protocolTraceId;
  if (eventInputId && eventInputId !== protocolTraceId) {
    logger.debug(
      eventInputId,
      `对齐 ZCode prompt inputId eventType=${event.type} protocolTrace=${protocolTraceId}`,
    );
  }
  const turnKey = `${resolveWorkspaceKey(params)}:${event.sessionId}:${event.turnId ?? eventInputId ?? traceId}`;

  if (event.type === "turn.started") {
    streamedTurnText.delete(turnKey);
    const inputOrigin = asRecord(payload.intent).inputOrigin;
    const runStartedEvent: ZCodeStreamEvent = {
      ...(inputOrigin === "desktop" || inputOrigin === "mobile" ? { inputOrigin } : {}),
      type: "task_run_started",
      taskId: params.taskId,
      traceId,
      ...(eventInputId ? { inputId: eventInputId } : {}),
      ...(event.turnId ? { turnId: event.turnId } : {}),
      startedAt: event.timestamp,
    };
    const taskNotificationToolUpdates = backgroundTaskNotificationToolUpdatesFromInput({
      input: stringValue(payload.input),
      originMeta: payload.originMeta,
      taskId: params.taskId,
      traceId,
      inputId: eventInputId,
    });
    if (taskNotificationToolUpdates.length > 0) {
      return [runStartedEvent, ...taskNotificationToolUpdates];
    }
    if (
      stringValue(payload.inputSource) === "goal-continuation" &&
      stringValue(payload.inputVisibility) === "model-only"
    ) {
      return [
        runStartedEvent,
        {
          type: "goal_iteration_started",
          taskId: params.taskId,
          traceId,
          ...(eventInputId ? { inputId: eventInputId } : {}),
          ...(stringValue(payload.targetId) ? { targetId: stringValue(payload.targetId) } : {}),
          startedAt: event.timestamp,
        },
      ];
    }
    return [runStartedEvent];
  }

  const compactTimeline = mapCompactTimelinePayload(params.taskId, traceId, eventInputId, payload);
  if (compactTimeline) {
    return [compactTimeline];
  }

  const partTimeline = mapSyntheticTimelinePartPayload(
    params.taskId,
    traceId,
    eventInputId,
    payload,
  );
  if (partTimeline) {
    return [partTimeline];
  }

  const modelStreaming = mapModelStreaming(
    params.taskId,
    traceId,
    eventInputId,
    payload,
    toolProjectionMemory,
  );
  const apiRetryClearEvent = maybeBuildApiRetryClearOnModelProgress(
    hasActiveApiRetry,
    params.taskId,
    traceId,
    eventInputId,
    payload,
  );
  if (modelStreaming) {
    if (modelStreaming.type === "agent_message_chunk" && !modelStreaming.parentToolUseId) {
      const previous = streamedTurnText.get(turnKey);
      const messageId = modelStreaming.messageId;
      const sameMessage = !messageId || !previous?.messageId || messageId === previous.messageId;
      streamedTurnText.set(turnKey, {
        messageId: messageId ?? previous?.messageId,
        text: (sameMessage ? (previous?.text ?? "") : "") + modelStreaming.content,
      });
    }
    return apiRetryClearEvent ? [apiRetryClearEvent, modelStreaming] : [modelStreaming];
  }
  if (apiRetryClearEvent) {
    return [apiRetryClearEvent];
  }

  if (event.type === "tool.updated") {
    // 工具调用前的前言不是最终回答；下一条模型消息需要独立核对已接收正文。
    if (payload.kind === "scheduled" && !parentToolUseIdFromToolPayload(payload)) {
      streamedTurnText.delete(turnKey);
    }
    return mapToolUpdated(params.taskId, traceId, eventInputId, payload, toolProjectionMemory);
  }

  if (event.type === "permission.requested") {
    const toolCallId = stringValue(payload.toolCallId);
    const toolName = stringValue(payload.toolName);
    if (toolCallId && toolName) {
      toolProjectionMemory?.toolNameById?.set(toolCallId, toolName);
    }
    if (isUserInputBackedPermissionToolName(toolName)) {
      // AskUserQuestion/ExitPlanMode 的 permission.requested 只是 core 的等待态标记；
      // 真正需要展示的问题会通过 interaction/requestUserInput 到达。继续把它投成普通权限，
      // UI 会出现 Allow/Deny 弹窗且无法把答案写回工具 input。
      return [];
    }
    return [permissionPayloadToStreamEvent(params.taskId, traceId, eventInputId, payload)];
  }

  if (event.type === "permission.resolved") {
    return permissionResolvedPayloadToStreamEvents(
      params.taskId,
      traceId,
      eventInputId,
      payload,
      toolProjectionMemory?.toolNameById,
    );
  }

  if (event.type === "turn.steerQueued") {
    const source = turnSteerSourceValue(payload.source);
    return [
      {
        type: "turn_steer_queued",
        taskId: params.taskId,
        traceId,
        ...(eventInputId ? { inputId: eventInputId } : {}),
        ...(queryId ? { queryId } : {}),
        pendingInputId: stringValue(payload.pendingInputId) ?? event.eventId,
        messageId: eventInputId,
        ...(turnSteerCommandKindValue(payload.commandKind)
          ? { commandKind: turnSteerCommandKindValue(payload.commandKind) }
          : {}),
        ...(source ? { source } : {}),
        targetTurnId: stringValue(payload.targetTurnId),
        content: stringValue(payload.input) ?? "",
        raw: payload,
      },
    ];
  }

  if (event.type === "turn.steerDrained") {
    return [
      {
        type: "turn_steer_status",
        taskId: params.taskId,
        traceId,
        ...(eventInputId ? { inputId: eventInputId } : {}),
        ...(stringArray(payload.queryIds).length > 0
          ? { queryIds: stringArray(payload.queryIds) }
          : {}),
        status: "drained",
        pendingInputIds: stringArray(payload.pendingInputIds),
        injectedMessageIds: stringArray(payload.injectedMessageIds),
        targetTurnId: stringValue(payload.targetTurnId),
        raw: payload,
      },
    ];
  }

  if (event.type === "turn.completed") {
    const events: ZCodeStreamEvent[] = [];
    const response = stringValue(payload.response);
    // Bugfix: 只记录“本轮收到过文字”会让工具前言屏蔽最终回答兜底。
    // 在终态之前补齐当前模型消息缺少的后缀；完整正文已到达时不重复投递。
    const streamed = streamedTurnText.get(turnKey)?.text ?? "";
    const missingResponse = response?.startsWith(streamed)
      ? response.slice(streamed.length)
      : response;
    if (missingResponse) {
      events.push({
        type: "agent_message_chunk",
        taskId: params.taskId,
        traceId,
        ...(eventInputId ? { inputId: eventInputId } : {}),
        content: missingResponse,
      });
    }
    events.push({
      type: "task_complete",
      taskId: params.taskId,
      traceId,
      ...(eventInputId ? { inputId: eventInputId } : {}),
      stopReason: stringValue(payload.resultType) ?? "complete",
      usage: usageFromPayload(payload.usage),
    });
    toolProjectionMemory?.streamingToolInputById?.clear();
    streamedTurnText.delete(turnKey);
    return events;
  }

  if (event.type === "turn.failed") {
    toolProjectionMemory?.streamingToolInputById?.clear();
    streamedTurnText.delete(turnKey);
    const errorPayload = asRecord(payload.error);
    if (stringValue(payload.turnPhase) === "compact") {
      return [
        compactFailureToTimelineEvent(
          params.taskId,
          traceId,
          eventInputId,
          stringValue(errorPayload.message) ?? "ZCode compact failed",
        ),
      ];
    }
    const attribution = errorAttributionSchema.safeParse(errorPayload.attribution);
    // dynamic task event 也会写入 task index；只修 snapshot 读路径仍会丢 live 归因。
    return [
      {
        type: "task_error",
        taskId: params.taskId,
        traceId,
        ...(eventInputId ? { inputId: eventInputId } : {}),
        error: stringValue(errorPayload.message) ?? "ZCode session failed",
        // type 是外层错误分类，code 才是 provider/subagent 要展示的真实错误码。
        code: stringValue(errorPayload.code) ?? stringValue(errorPayload.type),
        detail: stringValue(errorPayload.detail),
        ...(attribution.success ? { attribution: attribution.data } : {}),
      },
    ];
  }

  return mapSessionInfoLikePayload(
    params.taskId,
    traceId,
    eventInputId,
    event.eventId,
    payload,
    backgroundTaskControlsByTaskKey,
    `${resolveWorkspaceKey(params)}\u0000${params.taskId}`,
  );
}

function maybeBuildApiRetryClearOnModelProgress(
  hasActiveApiRetry: boolean,
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  payload: Record<string, unknown>,
): Extract<ZCodeStreamEvent, { type: "session_info_update" }> | null {
  if (!hasActiveApiRetry || !isZCodeModelRetryRecoveryProgressPayload(payload)) {
    return null;
  }
  // 重试请求开始不代表恢复成功，立即清会让输入栏闪烁；
  // 只有 retry attempt 真的产出模型内容，才清掉“重试中”运行态。
  return {
    type: "session_info_update",
    taskId,
    traceId,
    ...(inputId ? { inputId } : {}),
    apiRetry: null,
  };
}

function mapModelStreaming(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  payload: Record<string, unknown>,
  toolProjectionMemory?: ZCodeToolProjectionMemory,
): ZCodeStreamEvent | null {
  const kind = stringValue(payload.kind);
  const delta = stringValue(payload.delta);
  const parentToolUseId = parentToolUseIdFromToolPayload(payload);
  if (kind === "text_delta") {
    if (!delta) {
      return null;
    }
    return {
      type: "agent_message_chunk",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      ...(parentToolUseId ? { parentToolUseId } : {}),
      messageId: stringValue(payload.assistantMessageId),
      content: delta,
    };
  }
  if (kind === "reasoning_delta") {
    if (!delta) {
      return null;
    }
    return {
      type: "agent_thought_chunk",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      ...(parentToolUseId ? { parentToolUseId } : {}),
      content: delta,
    };
  }
  return mapToolInputStreaming(taskId, traceId, inputId, payload, toolProjectionMemory);
}

function mapToolInputStreaming(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  payload: Record<string, unknown>,
  toolProjectionMemory?: ZCodeToolProjectionMemory,
): ZCodeStreamEvent | null {
  const streamingToolInputById = toolProjectionMemory?.streamingToolInputById;
  const toolNameById = toolProjectionMemory?.toolNameById;
  const kind = stringValue(payload.kind);
  const toolId = stringValue(payload.toolCallId);
  if (!toolId) {
    return null;
  }
  const toolName = stringValue(payload.toolName) ?? toolNameById?.get(toolId);
  if (toolName) {
    toolNameById?.set(toolId, toolName);
  }
  const title = toolName ?? "tool";
  const parentToolUseId = parentToolUseIdFromToolPayload(payload);
  const buildRaw = (input: unknown, rawInput: string | undefined) => ({
    ...payload,
    ...(input !== undefined ? { input } : {}),
    ...(rawInput ? { streamingRawInputLength: rawInput.length } : {}),
  });

  if (kind === "tool_input_start") {
    streamingToolInputById?.set(toolId, { rawInput: "" });
    logStreamingToolInputProjection(traceId, {
      inputKeys: [],
      kind,
      projectedType: "tool_call",
      rawInputLength: 0,
      taskId,
      toolId,
      toolName,
    });
    return {
      type: "tool_call",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      toolId,
      parentToolUseId,
      input: {},
      toolName,
      kind: title,
      title,
      raw: buildRaw({}, undefined),
    };
  }

  if (kind === "tool_input_delta") {
    const state = appendZCodeStreamingToolInputDelta(
      streamingToolInputById?.get(toolId),
      stringValue(payload.delta) ?? "",
    );
    streamingToolInputById?.set(toolId, state);
    if (!shouldMaterializeZCodeStreamingToolInputPreview(state, { toolName })) {
      // 性能修复：services 兼容投影曾经每个 delta 都解析累计 JSON，并把 rawInput 全量塞进 raw。
      // 这里先只维护 tombstone buffer，达到预算或控制边界再 emit，避免 host/renderer 双端 O(n²)。
      return null;
    }
    const preview = buildZCodeStreamingToolInputPreview(state.rawInput);
    markZCodeStreamingToolInputPreviewMaterialized(state);
    const previewToolName = toolName ?? inferStreamingToolInputToolName(preview.input);
    const previewTitle = previewToolName ?? title;
    if (previewToolName && !toolName) {
      toolNameById?.set(toolId, previewToolName);
    }
    logStreamingToolInputProjection(traceId, {
      inputKeys: inputPreviewKeys(preview.input),
      kind,
      projectedType: "tool_call_update",
      rawInputLength: state.rawInput.length,
      taskId,
      toolId,
      toolName: previewToolName,
    });
    return {
      type: "tool_call_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      toolId,
      parentToolUseId,
      status: "pending",
      title: previewTitle,
      toolName: previewToolName,
      kind: previewTitle,
      input: preview.input,
      raw: buildRaw(preview.input, preview.rawInput),
    };
  }

  if (kind === "tool_input_end") {
    const state = streamingToolInputById?.get(toolId) ?? { rawInput: "" };
    const previewToolName = toolName ?? title;
    const previewTitle = previewToolName ?? title;
    logStreamingToolInputProjection(traceId, {
      inputKeys: [],
      kind,
      projectedType: "tool_call_update",
      rawInputLength: state.rawInput.length,
      taskId,
      toolId,
      toolName: previewToolName,
    });
    return {
      type: "tool_call_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      toolId,
      parentToolUseId,
      status: "pending",
      title: previewTitle,
      toolName: previewToolName,
      kind: previewTitle,
      // 性能修复：tool_input_end 与最终 tool_call 相邻时不再重复解析同一份大 JSON；
      // end 只作为生命周期边界，完整 input 交给 tool_call 一次性落库/渲染。
      raw: buildRaw(undefined, state.rawInput),
    };
  }

  if (kind === "tool_call") {
    const state = streamingToolInputById?.get(toolId);
    const rawInput = state?.rawInput ?? "";
    const hasCompleteInput = "input" in payload;
    const completeInput = hasCompleteInput ? payload.input : undefined;
    const preview = buildZCodeStreamingToolInputPreview(
      rawInput,
      hasCompleteInput ? completeInput : undefined,
    );
    const previewToolName = toolName ?? inferStreamingToolInputToolName(preview.input);
    const previewTitle = previewToolName ?? title;
    if (previewToolName && !toolName) {
      toolNameById?.set(toolId, previewToolName);
    }
    if ((hasCompleteInput || preview.complete) && toolProjectionMemory) {
      finalizeZCodeToolProjectionInput(toolId, preview.input, toolProjectionMemory);
    }
    streamingToolInputById?.set(toolId, {
      // 性能修复：最终 tool_call 已经持有完整 input，compat projection 不再长期保留
      // streaming raw buffer，避免并发长任务时 host 侧内存和序列化成本继续放大。
      rawInput: "",
      deltaCount: state?.deltaCount,
      lastPreviewAt: Date.now(),
      lastPreviewRawInputLength: rawInput.length,
    });
    logStreamingToolInputProjection(traceId, {
      inputKeys: inputPreviewKeys(preview.input),
      kind,
      projectedType: "tool_call_update",
      rawInputLength: rawInput.length,
      taskId,
      toolId,
      toolName: previewToolName,
    });
    return {
      type: "tool_call_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      toolId,
      parentToolUseId,
      status: "pending",
      title: previewTitle,
      toolName: previewToolName,
      kind: previewTitle,
      input: preview.input,
      raw: buildRaw(preview.input, preview.rawInput),
    };
  }

  return null;
}

function logStreamingToolInputProjection(
  traceId: TraceId,
  details: {
    inputKeys: string[];
    kind: string;
    projectedType: "tool_call" | "tool_call_update";
    rawInputLength: number;
    taskId: string;
    toolId: string;
    toolName?: string;
  },
): void {
  logger.debug(traceId, "ZCode streaming tool input projected", {
    ...details,
    event: "zcode.task.streaming_tool_input.projected",
  });
}

function inputPreviewKeys(input: unknown): string[] {
  return Object.keys(asRecord(input));
}

function inferStreamingToolInputToolName(input: unknown): string | undefined {
  const record = asRecord(input);
  const filePath = readStreamingToolInputStringField(record, [
    "file_path",
    "filePath",
    "path",
    "target_path",
    "targetPath",
    "filename",
    "file",
  ]);
  if (!filePath) {
    return undefined;
  }
  if (
    readStreamingToolInputStringField(record, ["old_string", "oldString", "old_text", "oldText"])
  ) {
    return "Edit";
  }
  if (
    readStreamingToolInputStringField(record, [
      "content",
      "new_string",
      "newString",
      "new_text",
      "newText",
    ]) !== undefined
  ) {
    return "Write";
  }
  return undefined;
}

function readStreamingToolInputStringField(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

function mapCompactTimelinePayload(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  payload: Record<string, unknown>,
): Extract<ZCodeStreamEvent, { type: "agent_message_chunk" }> | null {
  const timeline = compactTimelineMetaFromPayload(payload, inputId);
  if (!timeline) {
    return null;
  }
  const messageId = stringValue(payload.messageId);
  return {
    type: "agent_message_chunk",
    taskId,
    traceId,
    ...(inputId ? { inputId } : {}),
    ...(messageId ? { messageId } : {}),
    // compact lifecycle 是结构化状态事件，不是 assistant 正文。
    // 即使上游误带 text，也不能把内部 summary/prompt 投影到聊天区。
    content: "",
    zcodeTimeline: timeline,
  };
}

function mapSyntheticTimelinePartPayload(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  payload: Record<string, unknown>,
): Extract<ZCodeStreamEvent, { type: "agent_message_chunk" }> | null {
  const part = asRecord(payload.part);
  if (part.type !== "text") {
    return null;
  }
  const timeline = extractSyntheticTimelineFromTextPart(
    part as Extract<ZCodeMessagePart, { type: "text" }>,
  );
  if (!timeline) {
    return null;
  }
  const messageId = stringValue(part.messageId) ?? stringValue(payload.messageId);
  return {
    type: "agent_message_chunk",
    taskId,
    traceId,
    ...(inputId ? { inputId } : {}),
    ...(messageId ? { messageId } : {}),
    content: stringValue(part.text) ?? "",
    // fork notice 是 part.upserted 里的结构化 synthetic text，不是模型正文 delta。
    // 这里提前投成 timeline divider，避免 UI 按普通消息渲染后丢掉横线。
    zcodeTimeline: timeline,
  };
}

function compactTimelineMetaFromPayload(
  payload: Record<string, unknown>,
  inputId: InputId | undefined,
): ZCodeContextCompactionTimelineMeta | null {
  const operationId = stringValue(payload.operationId);
  const status = timelineStatusValue(payload.status ?? payload.timelineStatus);
  if (!operationId || !status) {
    return null;
  }
  const trigger = timelineTriggerValue(payload.trigger) ?? "manual";
  const replace = booleanValue(payload.replace);
  const reason = stringValue(payload.reason);
  const boundaryId = stringValue(payload.boundaryId);
  const summaryMessageId = stringValue(payload.summaryMessageId);
  const preCompactTokenCount = numberValue(payload.preCompactTokenCount);
  const postCompactTokenCount = numberValue(payload.postCompactTokenCount);
  const truePostCompactTokenCount = numberValue(payload.truePostCompactTokenCount);
  const attempt = numberValue(payload.attempt);
  const maxAttempts = numberValue(payload.maxAttempts);
  const startedAt = numberValue(payload.startedAt);
  const endedAt = numberValue(payload.endedAt);
  return {
    version: 1,
    kind: "synthetic",
    type: "context_compaction",
    operationId,
    status,
    trigger,
    display: "separator",
    ...(inputId ? { inputId } : {}),
    ...(replace !== undefined ? { replace } : {}),
    ...(reason ? { reason } : {}),
    ...(boundaryId ? { boundaryId } : {}),
    ...(summaryMessageId ? { summaryMessageId } : {}),
    ...(preCompactTokenCount !== undefined ? { preCompactTokenCount } : {}),
    ...(postCompactTokenCount !== undefined ? { postCompactTokenCount } : {}),
    ...(truePostCompactTokenCount !== undefined ? { truePostCompactTokenCount } : {}),
    ...(attempt !== undefined ? { attempt } : {}),
    ...(maxAttempts !== undefined ? { maxAttempts } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
  };
}

function compactFailureToTimelineEvent(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  reason: string,
): Extract<ZCodeStreamEvent, { type: "agent_message_chunk" }> {
  return {
    type: "agent_message_chunk",
    taskId,
    traceId,
    ...(inputId ? { inputId } : {}),
    content: "",
    zcodeTimeline: {
      version: 1,
      kind: "synthetic",
      type: "context_compaction",
      operationId: `compact-failed-${inputId ?? traceId}`,
      status: /abort|cancel|interrupt|stop/i.test(reason) ? "interrupted" : "failed",
      trigger: "manual",
      display: "separator",
      ...(inputId ? { inputId } : {}),
      reason,
      endedAt: Date.now(),
    },
  };
}

function mapToolUpdated(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  payload: Record<string, unknown>,
  toolProjectionMemory?: ZCodeToolProjectionMemory,
): ZCodeStreamEvent[] {
  const toolId = stringValue(payload.toolCallId);
  if (!toolId) {
    return [];
  }
  const parentToolUseId = parentToolUseIdFromToolPayload(payload);
  const memory = toolProjectionMemory ?? {};
  const toolNameById = memory.toolNameById;
  const rememberedTool = resolveZCodeToolProjectionMetadata(payload, toolId, memory);
  const rememberedToolName = rememberedTool.toolName;
  const rememberedInput = rememberedTool.hasInput ? rememberedTool.input : undefined;
  if ("input" in payload && "toolName" in payload) {
    const toolName = rememberedToolName ?? "tool";
    toolNameById?.set(toolId, toolName);
    finalizeZCodeToolProjectionInput(toolId, payload.input, memory);
    const toolEvent: ZCodeStreamEvent = {
      type: "tool_call",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      toolId,
      parentToolUseId,
      input: payload.input,
      toolName,
      kind: toolName,
      title: toolName,
      raw: payload,
    };
    const planSteps = isMainAgentToolProjectionSource(payload)
      ? extractPlanStepsFromToolInput({
          title: toolName,
          kind: toolName,
          input: payload.input,
        })
      : null;
    if (!planSteps) {
      return [toolEvent];
    }
    return [
      toolEvent,
      {
        type: "plan",
        taskId,
        traceId,
        ...(inputId ? { inputId } : {}),
        steps: planSteps,
      },
    ];
  }
  if ("result" in payload) {
    const result = asRecord(payload.result);
    // ZCode Protocol 的 ToolCallResult 只有 toolCallId/result，不再重复带 toolName。
    // 去掉 ZCode Agent 后如果不记住前序 ToolCallScheduled 的 TodoWrite 名称，result 里的 todos
    // 就只能当普通字符串输出，无法继续投射成顶部 todo/plan 事件。
    const toolName = rememberedToolName;
    const content = normalizeToolResultContent(toolName, result);
    const status = toolResultStatus(toolName, result);
    const toolEvent: ZCodeStreamEvent = {
      type: "tool_call_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      toolId,
      parentToolUseId,
      toolName,
      kind: toolName,
      title: toolName,
      ...(rememberedInput !== undefined ? { input: rememberedInput } : {}),
      status,
      content,
      error: stringValue(asRecord(result.error).message),
      raw: payload,
    };
    if (status !== "in_progress") {
      forgetZCodeToolProjectionMetadata(toolId, memory);
    }
    const planSteps = isMainAgentToolProjectionSource(payload)
      ? extractPlanStepsFromToolOutput({
          title: toolName,
          kind: toolName,
          output: content ?? result,
        })
      : null;
    if (!planSteps) {
      return [toolEvent];
    }
    return [
      toolEvent,
      {
        type: "plan",
        taskId,
        traceId,
        ...(inputId ? { inputId } : {}),
        steps: planSteps,
      },
    ];
  }
  if ("error" in payload) {
    forgetZCodeToolProjectionMetadata(toolId, memory);
    return [
      {
        type: "tool_call_update",
        taskId,
        traceId,
        ...(inputId ? { inputId } : {}),
        toolId,
        parentToolUseId,
        toolName: rememberedToolName,
        kind: rememberedToolName,
        title: rememberedToolName,
        ...(rememberedInput !== undefined ? { input: rememberedInput } : {}),
        status: "failed",
        error: stringValue(asRecord(payload.error).message) ?? "Tool failed",
        raw: payload,
      },
    ];
  }
  return [
    {
      type: "tool_call_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      toolId,
      parentToolUseId,
      toolName: rememberedToolName,
      kind: rememberedToolName,
      title: rememberedToolName,
      ...(rememberedInput !== undefined && payload.inputOmitted !== true
        ? { input: rememberedInput }
        : {}),
      status: "in_progress",
      raw: payload,
    },
  ];
}

function toolResultStatus(
  toolName: string | undefined,
  result: Record<string, unknown>,
): Extract<ZCodeStreamEvent, { type: "tool_call_update" }>["status"] {
  if (result.success === false) {
    return "failed";
  }
  if (isBackgroundAgentLaunchResult(toolName, result)) {
    // Agent 后台启动 ACK 只是子 agent 已创建，不代表子 agent 已完成；
    // 投影成 completed 会让前端在真实 completion 前把 subagent 卡片误标为完成。
    return "in_progress";
  }
  return "completed";
}

function isBackgroundAgentLaunchResult(
  toolName: string | undefined,
  result: Record<string, unknown>,
): boolean {
  const content = stringValue(result.content);
  if (!content) {
    return false;
  }
  if (
    (isSubagentDispatchToolName(toolName) || toolName === undefined) &&
    isBackgroundAgentLaunchAcknowledgement(content)
  ) {
    return true;
  }
  const parsed = parseJsonRecord(content);
  const parsedStatus = stringValue(parsed?.status);
  return (
    parsed !== null &&
    (isSubagentDispatchToolName(toolName) || stringValue(parsed.agentId) !== undefined) &&
    ((parsedStatus === "backgrounded" && stringValue(parsed.backgroundTaskId) !== undefined) ||
      (parsedStatus === "async_launched" &&
        stringValue(parsed.agentId) !== undefined &&
        stringValue(parsed.outputFile) !== undefined))
  );
}

function isBackgroundAgentLaunchAcknowledgement(content: string): boolean {
  // subagent async launch 的模型可见 ACK 从 backgroundTaskId/outputFile 文案迁到 output_file 文案；
  // service projection 需要同时识别新旧格式，否则会把启动确认当成已完成结果发给 UI。
  return (
    isLegacyBackgroundAgentLaunchAcknowledgement(content) ||
    isPreviousBackgroundAgentLaunchAcknowledgement(content) ||
    isCurrentBackgroundAgentLaunchAcknowledgement(content)
  );
}

function isLegacyBackgroundAgentLaunchAcknowledgement(content: string): boolean {
  return (
    content.includes("backgroundTaskId:") &&
    content.includes("Runtime will wait for this background Agent")
  );
}

function isPreviousBackgroundAgentLaunchAcknowledgement(content: string): boolean {
  return (
    content.startsWith("Agent ") &&
    content.includes(" started in background.") &&
    content.includes("agentId:") &&
    content.includes("outputFile:") &&
    content.includes("You will be notified when the Agent completes.")
  );
}

function isCurrentBackgroundAgentLaunchAcknowledgement(content: string): boolean {
  return (
    content.startsWith("Async agent launched successfully.") &&
    content.includes("agentId:") &&
    content.includes("The agent is working in the background.") &&
    content.includes("notified automatically when it completes")
  );
}

function isSubagentDispatchToolName(toolName: string | undefined): boolean {
  return toolName === "Agent" || toolName === "Task";
}

function parentToolUseIdFromToolPayload(payload: Record<string, unknown>): string | null {
  // ZCode Protocol 发送的父级字段叫 parentToolCallId；
  // UI stream 模型统一消费 parentToolUseId，必须在服务投影层完成一次性归一。
  return (
    stringValue(payload.parentToolUseId) ??
    stringValue(payload.parentToolCallId) ??
    rawClaudeParentToolUseId(payload)
  );
}

function rawClaudeParentToolUseId(raw: unknown): string | null {
  const meta = asRecord(raw)._meta;
  const claudeCode = asRecord(meta).claudeCode;
  return stringValue(asRecord(claudeCode).parentToolUseId) ?? null;
}

function normalizeToolResultContent(
  toolName: string | undefined,
  result: Record<string, unknown>,
): unknown {
  const content = result.content;
  const agentActivity = parseAgentActivityResultContent(toolName, content);
  return agentActivity ?? stringValue(content);
}

function parseAgentActivityResultContent(
  toolName: string | undefined,
  content: unknown,
): { kind: "agent_activity"; content: string; thought?: string } | null {
  if (typeof content !== "string" || content.trim().length === 0) {
    return null;
  }
  const parsed = parseJsonRecord(content);
  if (!parsed) {
    return null;
  }
  const isAgentResult =
    toolName === "Agent" ||
    toolName === "Task" ||
    stringValue(parsed.agentId) !== undefined ||
    stringValue(parsed.agentType) !== undefined;
  if (!isAgentResult) {
    return null;
  }
  // Agent 工具结果是 JSON 字符串，最终摘要在 content[].text；
  // 服务层先转成 agent_activity，避免 UI 每条渲染路径都猜原始 JSON。
  const output = agentTextFromContentField(parsed.content);
  if (!output) {
    return null;
  }
  const thought = stringValue(parsed.thought);
  return {
    kind: "agent_activity",
    content: output,
    ...(thought ? { thought } : {}),
  };
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function agentTextFromContentField(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const text = value
    .map((item) => stringValue(asRecord(item).text))
    .filter((item): item is string => Boolean(item))
    .join("\n");
  return text || undefined;
}

function permissionRequestToStreamEvent(
  taskId: string,
  request: ZCodePermissionRequestParams,
): ZCodePermissionRequest {
  return {
    type: "permission_request",
    taskId,
    traceId: generateTraceId(taskId),
    requestId: request.requestId,
    description: request.reason || request.toolName,
    kind: request.toolName,
    title: request.toolName,
    options: request.options,
    ...(request.origin ? { origin: request.origin } : {}),
    raw: request,
  };
}

function pendingPermissionToStreamEvent(
  taskId: string,
  permission: ZCodeSessionStateSnapshot["projection"]["pendingPermissions"][number],
): ZCodePermissionRequest {
  return {
    type: "permission_request",
    taskId,
    traceId: generateTraceId(taskId),
    requestId: permission.requestId,
    description: permission.reason || permission.toolName,
    kind: permission.toolName,
    title: permission.toolName,
    options: permission.options,
    ...(permission.origin ? { origin: permission.origin } : {}),
    raw: permission,
  };
}

function userInputRequestToElicitationStreamEvent(
  taskId: string,
  request: ZCodeUserInputRequestParams,
): ZCodeStreamEvent {
  const questions =
    request.questions?.map((question) => ({
      question: question.question,
      header: question.header,
      options: question.options.map((option) => ({
        value: option.value,
        label: option.label,
        description: option.description,
      })),
      ...(question.multiSelect ? { multiSelect: true } : {}),
    })) ?? [];
  const firstQuestion = questions[0];
  const requestSchema = asRecord(request.schema);
  const requestInput = asRecord(request.input);
  const plan =
    requestSchema.interaction === "plan_approval" &&
    typeof requestInput.plan === "string" &&
    requestInput.plan.trim()
      ? requestInput.plan.trim()
      : undefined;
  return {
    type: "elicitation_request",
    taskId,
    traceId: generateTraceId(taskId),
    requestId: request.requestId,
    message: firstQuestion?.question ?? request.prompt ?? "Input required",
    header: firstQuestion?.header,
    options: firstQuestion?.options ?? [],
    ...(firstQuestion?.multiSelect ? { multiSelect: true } : {}),
    ...(questions.length > 0 ? { questions } : {}),
    ...(request.origin ? { origin: request.origin } : {}),
    // ExitPlanMode 的 request 同时携带 schema 和 input；直接取 `schema ?? input`
    // 会丢掉 input.plan，审批投影因而缺少正文。
    // 这里只合入 plan，保持普通 elicitation 以及其他工具 input 的数据边界。
    schema: plan ? { ...requestSchema, plan } : (request.schema ?? request.input),
  };
}

function userInputResponseToElicitationStreamEvent(
  taskId: string,
  requestId: string,
  response: ZCodeUserInputResponse,
): Extract<ZCodeStreamEvent, { type: "elicitation_response" }> {
  return {
    type: "elicitation_response",
    taskId,
    traceId: generateTraceId(taskId),
    requestId,
    action: response.action,
    ...(response.content ? { content: response.content } : {}),
  };
}

type PendingElicitationQuestion = {
  question: string;
  header: string;
  options: Array<{ value: string; label: string; description?: string }>;
  multiSelect?: boolean;
};

function pendingUserInputBackedPermissionToElicitationEvent(
  taskId: string,
  permission: ZCodeSessionStateSnapshot["projection"]["pendingPermissions"][number],
): Extract<ZCodeStreamEvent, { type: "elicitation_request" }> | null {
  if (isAskUserQuestionToolName(permission.toolName)) {
    return pendingAskUserQuestionToElicitationEvent(taskId, permission);
  }
  if (isExitPlanModeToolName(permission.toolName)) {
    return pendingExitPlanModeToElicitationEvent(taskId, permission);
  }
  return null;
}

function pendingAskUserQuestionToElicitationEvent(
  taskId: string,
  permission: ZCodeSessionStateSnapshot["projection"]["pendingPermissions"][number],
): Extract<ZCodeStreamEvent, { type: "elicitation_request" }> | null {
  const questions = askUserQuestionInputToElicitationQuestions(permission.input);
  if (questions.length === 0) {
    return null;
  }
  const firstQuestion = questions[0];
  return {
    type: "elicitation_request",
    taskId,
    traceId: generateTraceId(taskId),
    requestId: permission.requestId,
    message: firstQuestion?.question ?? permission.reason,
    header: firstQuestion?.header,
    options: firstQuestion?.options ?? [],
    ...(firstQuestion?.multiSelect ? { multiSelect: true } : {}),
    questions,
    ...(permission.origin ? { origin: permission.origin } : {}),
    schema: permission.input,
  };
}

function pendingExitPlanModeToElicitationEvent(
  taskId: string,
  permission: ZCodeSessionStateSnapshot["projection"]["pendingPermissions"][number],
): Extract<ZCodeStreamEvent, { type: "elicitation_request" }> {
  const questions = createExitPlanModeApprovalQuestions();
  const firstQuestion = questions[0];
  const input = asRecord(permission.input);
  const plan = typeof input.plan === "string" && input.plan.trim() ? input.plan.trim() : undefined;
  return {
    type: "elicitation_request",
    taskId,
    traceId: generateTraceId(taskId),
    requestId: permission.requestId,
    message: firstQuestion.question,
    header: firstQuestion.header,
    options: firstQuestion.options,
    questions,
    ...(permission.origin ? { origin: permission.origin } : {}),
    // 计划审批投影必须展示本次 ExitPlanMode 对应的计划正文；
    // 这里只定向投影 plan，避免把其他 permission input 泄漏到通用 elicitation schema。
    schema: {
      interaction: "plan_approval",
      toolName: permission.toolName,
      ...(plan ? { plan } : {}),
    },
  };
}

function setTaskBackgroundTaskControlCache(
  cache: Map<string, ZCodeBackgroundTaskControlItem[]> | undefined,
  cacheKey: string,
  jobs: ZCodeBackgroundTaskControlItem[],
) {
  cache?.set(cacheKey, jobs);
}

function updateTaskBackgroundTaskControlCacheFromPayload(
  cache: Map<string, ZCodeBackgroundTaskControlItem[]> | undefined,
  cacheKey: string,
  payload: Record<string, unknown>,
): ZCodeBackgroundTaskControlItem[] | null {
  const parsedJobs = parseZCodeBackgroundTaskControlItems([payload]);
  if (parsedJobs.length === 0) {
    return null;
  }
  if (!cache) {
    return parsedJobs;
  }
  const nextJobs = mergeZCodeBackgroundTaskControlItems(cache.get(cacheKey) ?? [], parsedJobs);
  cache.set(cacheKey, nextJobs);
  return nextJobs;
}

function createExitPlanModeApprovalQuestions(): [PendingElicitationQuestion] {
  return [
    {
      header: "Plan",
      options: [
        {
          description: "Exit plan mode and start implementation.",
          label: "Approve",
          value: EXIT_PLAN_MODE_APPROVAL_APPROVE,
        },
      ],
      question: EXIT_PLAN_MODE_APPROVAL_QUESTION,
    },
  ];
}

function askUserQuestionInputToElicitationQuestions(input: unknown): PendingElicitationQuestion[] {
  type ElicitationOption = PendingElicitationQuestion["options"][number];
  const questions = asRecord(input).questions;
  if (!Array.isArray(questions)) {
    return [];
  }
  return questions
    .map((question) => {
      const record = asRecord(question);
      const questionText = stringValue(record.question);
      const header = stringValue(record.header) ?? questionText;
      const rawOptions = Array.isArray(record.options) ? record.options : [];
      const options: ElicitationOption[] = rawOptions
        .map((option) => {
          const optionRecord = asRecord(option);
          const label = stringValue(optionRecord.label);
          if (!label) {
            return null;
          }
          const description = stringValue(optionRecord.description);
          const parsedOption: ElicitationOption = {
            value: label,
            label,
            ...(description ? { description } : {}),
          };
          return parsedOption;
        })
        .filter((option): option is ElicitationOption => option !== null);
      if (!questionText || !header || options.length === 0) {
        return null;
      }
      const parsedQuestion: PendingElicitationQuestion = {
        question: questionText,
        header,
        options,
        ...(record.multiSelect === true ? { multiSelect: true } : {}),
      };
      return parsedQuestion;
    })
    .filter((question): question is PendingElicitationQuestion => question !== null);
}

function permissionPayloadToStreamEvent(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  payload: Record<string, unknown>,
): ZCodeStreamEvent {
  return {
    type: "permission_request",
    taskId,
    traceId,
    ...(inputId ? { inputId } : {}),
    requestId: stringValue(payload.requestId) ?? stringValue(payload.toolCallId) ?? "unknown",
    description:
      stringValue(payload.reason) ?? stringValue(payload.toolName) ?? "Permission required",
    kind: stringValue(payload.toolName) ?? "tool",
    title: stringValue(payload.toolName),
    options: permissionOptionsFromPayload(payload),
    raw: payload,
  };
}

function permissionOptionsFromPayload(payload: Record<string, unknown>): ZCodePermissionOption[] {
  return Array.isArray(payload.options) ? (payload.options as ZCodePermissionOption[]) : [];
}

function permissionResolvedPayloadToStreamEvents(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  payload: Record<string, unknown>,
  toolNameById?: Map<string, string>,
): ZCodeStreamEvent[] {
  const toolCallId = stringValue(payload.toolCallId);
  const toolName =
    stringValue(payload.toolName) ?? (toolCallId ? toolNameById?.get(toolCallId) : undefined);
  const decision = stringValue(payload.decision);
  const requestId = stringValue(payload.requestId) ?? toolCallId ?? "unknown";

  if (isUserInputBackedPermissionToolName(toolName)) {
    return [
      {
        type: "elicitation_response",
        taskId,
        traceId,
        ...(inputId ? { inputId } : {}),
        requestId,
        action: decision === "deny" ? "decline" : "accept",
      },
    ];
  }

  const permissionResponse = {
    type: "permission_response",
    taskId,
    traceId,
    ...(inputId ? { inputId } : {}),
    requestId,
    optionId: decision ?? "allow",
    response: {
      decision: decision === "deny" ? "deny" : "allow",
    },
  } as Extract<ZCodeStreamEvent, { type: "permission_response" }>;

  if (decision !== "deny" || !toolCallId) {
    return [permissionResponse];
  }

  // Plan mode 等运行时拒绝会先发 permission.resolved，
  // 但不一定有对应 tool.updated(error) 实时事件；只清权限请求会让已 started 的工具卡一直转。
  return [
    permissionResponse,
    {
      type: "tool_call_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      toolId: toolCallId,
      parentToolUseId: parentToolUseIdFromToolPayload(payload),
      status: "failed",
      toolName,
      kind: toolName,
      title: toolName,
      error: stringValue(payload.reason) ?? "Permission denied",
      raw: payload,
    },
  ];
}

function mapSessionInfoLikePayload(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  eventId: string | undefined,
  payload: Record<string, unknown>,
  backgroundTaskControlsByTaskKey?: Map<string, ZCodeBackgroundTaskControlItem[]>,
  cacheKey = taskId,
): ZCodeStreamEvent[] {
  const events: ZCodeStreamEvent[] = [];
  // event.taskId 是对外 session id；内部 cache 必须沿用 workspace-aware taskKey，
  // 否则 replayable snapshot seed 和后续 live update 会分裂成两份 background job 状态。
  const backgroundTaskControlCacheKey = cacheKey;
  const tokenUsageDelta = taskTokenUsageDeltaFromPayload(
    taskId,
    traceId,
    inputId,
    eventId,
    payload,
  );
  if (tokenUsageDelta) {
    events.push(tokenUsageDelta);
  }
  const networkDebugStatus = zcodeTaskNetworkDebugStatusFromPayload({
    taskId,
    traceId,
    ...(inputId ? { inputId } : {}),
    ...(eventId ? { eventId } : {}),
    payload,
  });
  if (networkDebugStatus) {
    events.push(networkDebugStatus);
  }
  const contextUsage = contextUsageFromPayload(payload);
  if (contextUsage) {
    events.push({
      type: "usage_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      used: contextUsage.used,
      size: contextUsage.size,
      cost: contextUsage.cost ?? null,
      ...(contextUsage.cache ? { cache: contextUsage.cache } : {}),
      ...(contextUsage.breakdown ? { breakdown: contextUsage.breakdown } : {}),
    });
  }
  const title = stringValue(payload.title);
  if (title) {
    events.push({
      type: "session_info_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      title,
    });
  }
  const apiRetry = apiRetryFromSessionInfoPayload(payload);
  if (apiRetry !== undefined) {
    events.push({
      type: "session_info_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      apiRetry,
    });
  }
  if ("target" in payload && ("action" in payload || "source" in payload)) {
    events.push({
      type: "session_info_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      target: {
        action: stringValue(payload.action) === "cleared" ? "cleared" : "set",
        source: stringValue(payload.source) === "tool" ? "tool" : "runtime",
        target: payload.target ? fromZCodeGoal(payload.target as never) : null,
        previousTarget: payload.previousTarget
          ? fromZCodeGoal(payload.previousTarget as never)
          : undefined,
      },
    });
  }
  const projection = asRecord(payload.projection);
  if (Array.isArray(projection.backgroundJobs)) {
    const jobs = parseZCodeBackgroundTaskControlItems(projection.backgroundJobs);
    setTaskBackgroundTaskControlCache(
      backgroundTaskControlsByTaskKey,
      backgroundTaskControlCacheKey,
      jobs,
    );
    events.push({
      type: "background_bash_jobs_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      jobs,
    });
  }
  const backgroundJobUpdate = updateTaskBackgroundTaskControlCacheFromPayload(
    backgroundTaskControlsByTaskKey,
    backgroundTaskControlCacheKey,
    payload,
  );
  if (backgroundJobUpdate) {
    events.push({
      type: "background_bash_jobs_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      jobs: backgroundJobUpdate,
    });
  }
  return events;
}

function taskTokenUsageDeltaFromPayload(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  eventId: string | undefined,
  payload: Record<string, unknown>,
): Extract<ZCodeStreamEvent, { type: "task_token_usage_delta" }> | null {
  if (!isModelCompleteUsagePayload(payload)) {
    return null;
  }
  const usage = usageFromPayload(payload.usage);
  if (!usage || usage.totalTokens <= 0) {
    return null;
  }
  const querySource = stringValue(payload.querySource);
  const queryId = stringValue(payload.queryId);
  // 累计 Token 要跟随每次模型完成实时更新，而不是等 task_complete 的整轮汇总；
  // eventId 是 protocol 流的稳定单事件标识，用它去重可避免前后台 monitor 重复记账。
  const eventKey =
    eventId ??
    `${traceId}:${inputId ?? "no-input"}:${queryId ?? "no-query"}:${querySource ?? "unknown"}:${usage.inputTokens}:` +
      `${usage.outputTokens}:${usage.totalTokens}`;
  return {
    type: "task_token_usage_delta",
    taskId,
    traceId,
    ...(inputId ? { inputId } : {}),
    ...(queryId ? { queryId } : {}),
    eventKey,
    ...(eventId ? { eventId } : {}),
    ...(querySource ? { querySource } : {}),
    usage,
  };
}

function isModelCompleteUsagePayload(payload: Record<string, unknown>): boolean {
  if (!("usage" in payload)) {
    return false;
  }
  return (
    stringValue(payload.stopReason) !== undefined ||
    "contextWindow" in payload ||
    stringValue(payload.querySource) !== undefined
  );
}

function apiRetryFromSessionInfoPayload(
  payload: Record<string, unknown>,
): ZCodeApiRetryStatus | null | undefined {
  if ("apiRetry" in payload) {
    return normalizeZCodeApiRetryStatus(payload.apiRetry);
  }

  const runtimeRetry = normalizeZCodeApiRetryStatus(asRecord(payload.runtime).apiRetry);
  if (runtimeRetry !== undefined) {
    return runtimeRetry;
  }

  const metaRetry = normalizeZCodeApiRetryStatus(asRecord(asRecord(payload._meta).zcode).apiRetry);
  if (metaRetry !== undefined) {
    return metaRetry;
  }

  return (
    zcodeApiRetryFromStreamRecoveryPayload(payload) ??
    zcodeApiRetryFromModelNetworkStatusPayload(payload)
  );
}

function recordAgentModelNetworkTelemetry(event: ZCodeSessionEvent): void {
  const observation = agentModelNetworkObservationFromEvent(event);
  if (!observation) {
    return;
  }
  try {
    emitNetworkTelemetryObservation(observation);
  } catch (error) {
    // 修复原因：agent 模型网络遥测属于旁路指标，sink 异常不能影响主会话消息流。
    logger.warn(undefined, "上报 agent 模型网络遥测失败", error);
  }
}

function agentModelNetworkObservationFromEvent(
  event: ZCodeSessionEvent,
): NetworkObservation | null {
  const payload = asRecord(event.payload);
  const type = stringValue(payload.type);
  if (type !== "model_request_completed" && type !== "model_request_failed") {
    return null;
  }
  // 修复原因：retryable failed 只是同一次逻辑请求的中间 attempt，最终 completed/failed 会带总 attempt。
  // 如果这里也计数，会把成功率、失败率和重试率同时放大。
  if (type === "model_request_failed" && booleanValue(payload.retryable) === true) {
    return null;
  }

  const durationMs = Math.max(0, Math.round(numberValue(payload.durationMs) ?? 0));
  const statusCode = nonNegativeIntegerValue(payload.statusCode);
  const ok = type === "model_request_completed";
  return {
    transport: "http",
    interface: buildAgentModelNetworkInterface(payload),
    durationMs,
    ok,
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(ok ? {} : { errorKind: classifyAgentModelNetworkError(payload, statusCode) }),
    attempt: positiveIntegerValue(payload.attempt) ?? 1,
  };
}

function buildAgentModelNetworkInterface(payload: Record<string, unknown>): string {
  const providerKind = safeNetworkDimension(stringValue(payload.providerKind)) ?? "unknown";
  const transport = safeNetworkDimension(stringValue(payload.transport)) ?? "unknown";
  const base = normalizeAgentModelBaseUrl(stringValue(payload.baseURL));
  return `zcode_agent.model.${providerKind}.${transport}.${base}`;
}

function normalizeAgentModelBaseUrl(value: string | undefined): string {
  if (!value) {
    return "unknown";
  }
  try {
    const parsed = new URL(value);
    const pathname = parsed.pathname.replace(/\/+$/u, "") || "/";
    const safePath = pathname.length > 80 ? `${pathname.slice(0, 80)}...` : pathname;
    return `${parsed.host}${safePath}`;
  } catch {
    return safeNetworkDimension(value, 120) ?? "unknown";
  }
}

function safeNetworkDimension(value: string | undefined, maxLength = 48): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const safe = trimmed.replace(/[?#[\]{}|\\^`"'<>\s]+/gu, "_");
  return safe.length > maxLength ? `${safe.slice(0, maxLength)}...` : safe;
}

function classifyAgentModelNetworkError(
  payload: Record<string, unknown>,
  statusCode: number | undefined,
): string {
  const reason = stringValue(payload.reason);
  switch (reason) {
    case "timeout":
    case "stream_idle_timeout":
      return "timeout";
    case "network_error":
    case "stale_connection":
      return "connection_reset";
    case "proxy_error":
      return "proxy_error";
    case "tls_error":
      return "tls_error";
    default:
      if (statusCode !== undefined && statusCode >= 500) {
        return "server_error";
      }
      if (statusCode !== undefined && statusCode >= 400) {
        return "client_error";
      }
      return "other";
  }
}

type ContextUsageUpdate = Pick<
  Extract<ZCodeStreamEvent, { type: "usage_update" }>,
  "used" | "size" | "cost" | "cache" | "breakdown"
>;

function contextUsageFromProjection(
  projection: ZCodeSessionStateSnapshot["projection"],
): ContextUsageUpdate | null {
  if (projection.contextWindow <= 0 || projection.contextUsed <= 0) {
    return null;
  }
  return {
    used: projection.contextUsed,
    size: projection.contextWindow,
    cost: null,
  };
}

function contextUsageFromRuntime(
  runtimeUsage: ZCodeSessionStateSnapshot["runtime"]["contextUsage"] | undefined,
): ContextUsageUpdate | null {
  if (!runtimeUsage || runtimeUsage.size <= 0 || runtimeUsage.used <= 0) {
    return null;
  }
  // session resume 时 protocol projection 可能还没重放主轮次 usage。
  // runtime.contextUsage 来自持久化 assistant token 记录，应优先用于恢复旧 task UI。
  return {
    used: runtimeUsage.used,
    size: runtimeUsage.size,
    cost: runtimeUsage.cost ?? null,
    ...(runtimeUsage.cache ? { cache: runtimeUsage.cache } : {}),
    ...(runtimeUsage.breakdown ? { breakdown: runtimeUsage.breakdown } : {}),
  };
}

function contextUsageFromPayload(payload: Record<string, unknown>): ContextUsageUpdate | null {
  const projection = asRecord(payload.projection);
  const usage = asRecord(payload.usage);
  const size = numberValue(payload.contextWindow ?? projection.contextWindow);
  const explicitUsed = numberValue(payload.contextUsed ?? projection.contextUsed);
  const useModelUsageForContext = shouldUseModelUsageForContext(payload);
  const modelUsageUsed = useModelUsageForContext ? contextUsageTokensFromPayload(usage) : undefined;
  const used =
    modelUsageUsed ??
    // 主轮次模型返回 usage 时必须以真实网络 token 统计为准；
    // context window 是 input + output 共享窗口，不能再只用 inputTokens 渲染 meter。
    // projection.contextUsed 是 runtime 估算/恢复事实源，只在缺少 usage 时兜底。
    explicitUsed;
  if (size === undefined || size <= 0) {
    return null;
  }
  // ZCode Protocol 的 session.updated 里 contextUsed/contextWindow 是 projection 事实源；
  // 旧 task stream 只认识 usage_update，adapter 不转换就会让右下角 context meter 永远拿不到数据。
  // used=0 只表示初始化或异常兜底，不能渲染成可用的 context meter。
  if (used === undefined || used <= 0) {
    return null;
  }
  return {
    used,
    size,
    cost: null,
    ...(useModelUsageForContext ? optionalContextCacheUsageFromPayload(payload, usage) : {}),
    ...(useModelUsageForContext ? optionalContextUsageBreakdownFromPayload(payload) : {}),
  };
}

function optionalContextUsageBreakdownFromPayload(
  payload: Record<string, unknown>,
): Pick<ContextUsageUpdate, "breakdown"> {
  const parsed = zcodeContextUsageBreakdownSchema.safeParse(payload.contextUsageBreakdown);
  return parsed.success && parsed.data.length > 0 ? { breakdown: parsed.data } : {};
}

function contextUsageTokensFromPayload(usage: Record<string, unknown>): number | undefined {
  const inputTokens = positiveIntegerValue(usage.inputTokens ?? usage.input);
  if (inputTokens !== undefined) {
    // AI SDK v6 已把 Anthropic cache read/write 并入 inputTokens。
    // adapter 只需要加 output；再加 cacheReadTokens 会把输入栏 context meter 算大。
    return inputTokens + (nonNegativeIntegerValue(usage.outputTokens ?? usage.output) ?? 0);
  }

  const totalTokens = positiveIntegerValue(usage.totalTokens ?? usage.total);
  if (totalTokens !== undefined) {
    return totalTokens;
  }

  const cacheTokens =
    (nonNegativeIntegerValue(usage.cachedReadTokens ?? usage.cacheReadTokens) ?? 0) +
    (nonNegativeIntegerValue(usage.cachedWriteTokens ?? usage.cacheWriteTokens) ?? 0);
  return cacheTokens > 0
    ? cacheTokens + (nonNegativeIntegerValue(usage.outputTokens ?? usage.output) ?? 0)
    : undefined;
}

function optionalContextCacheUsageFromPayload(
  payload: Record<string, unknown>,
  usage: Record<string, unknown>,
): Pick<ContextUsageUpdate, "cache"> {
  const cache = contextCacheUsageFromPayload(payload, usage);
  return cache ? { cache } : {};
}

function shouldUseModelUsageForContext(payload: Record<string, unknown>): boolean {
  const querySource = stringValue(payload.querySource);
  // 只有主会话模型请求的 inputTokens 才代表当前可见上下文。
  // 标题、压缩、prompt enhance 等 sidecar 请求即使带 contextWindow，也不能覆盖输入栏 context meter。
  return querySource === undefined || querySource === "main_turn";
}

function contextCacheUsageFromPayload(
  payload: Record<string, unknown>,
  usage: Record<string, unknown>,
): ContextUsageUpdate["cache"] {
  const aggregate = asRecord(payload.cacheHit);
  if (Object.keys(aggregate).length > 0) {
    const inputTokens = nonNegativeIntegerValue(aggregate.inputTokens) ?? 0;
    const cacheReadTokens = nonNegativeIntegerValue(aggregate.cacheReadTokens) ?? 0;
    const cacheWriteTokens = nonNegativeIntegerValue(aggregate.cacheWriteTokens) ?? 0;
    const latestHitRate = numberValue(aggregate.latestHitRate);
    const hitRate = numberValue(aggregate.hitRate);
    const hitRateRequestCount = nonNegativeIntegerValue(aggregate.hitRateRequestCount);
    const totalInputTokens = nonNegativeIntegerValue(aggregate.totalInputTokens);
    const totalCacheReadTokens = nonNegativeIntegerValue(aggregate.totalCacheReadTokens);
    const totalCacheWriteTokens = nonNegativeIntegerValue(aggregate.totalCacheWriteTokens);
    return {
      inputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      ...(latestHitRate !== undefined ? { latestHitRate: Math.max(0, latestHitRate) } : {}),
      ...(hitRateRequestCount !== undefined ? { hitRateRequestCount } : {}),
      ...(totalInputTokens !== undefined ? { totalInputTokens } : {}),
      ...(totalCacheReadTokens !== undefined ? { totalCacheReadTokens } : {}),
      ...(totalCacheWriteTokens !== undefined ? { totalCacheWriteTokens } : {}),
      hitRate: hitRate !== undefined ? Math.max(0, hitRate) : null,
    };
  }

  const hasCacheRead = "cachedReadTokens" in usage || "cacheReadTokens" in usage;
  const hasCacheWrite = "cachedWriteTokens" in usage || "cacheWriteTokens" in usage;
  const hasHitRate = "cacheHitRate" in usage || "hitRate" in usage;
  if (!hasCacheRead && !hasCacheWrite && !hasHitRate) {
    return undefined;
  }
  const inputTokens = nonNegativeIntegerValue(usage.inputTokens ?? usage.input) ?? 0;
  const cacheReadTokens =
    nonNegativeIntegerValue(usage.cachedReadTokens ?? usage.cacheReadTokens) ?? 0;
  const cacheWriteTokens =
    nonNegativeIntegerValue(usage.cachedWriteTokens ?? usage.cacheWriteTokens) ?? 0;
  const explicitHitRate = numberValue(usage.cacheHitRate ?? usage.hitRate);
  return {
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    latestHitRate:
      explicitHitRate !== undefined
        ? Math.max(0, explicitHitRate)
        : inputTokens > 0
          ? cacheReadTokens / inputTokens
          : null,
    // UI 展示的是 agent/app 协议返回的命中率；provider 没直接给时，
    // 在 adapter 侧按 provider usage 归一化一次，避免各 UI 入口重复理解 token 字段。
    hitRate:
      explicitHitRate !== undefined
        ? Math.max(0, explicitHitRate)
        : inputTokens > 0
          ? cacheReadTokens / inputTokens
          : null,
  };
}

function usageFromPayload(value: unknown): ZCodeUsage | undefined {
  const usage = asRecord(value);
  if (Object.keys(usage).length === 0) {
    return undefined;
  }
  const inputTokens = numberValue(usage.inputTokens ?? usage.input) ?? 0;
  const outputTokens = numberValue(usage.outputTokens ?? usage.output) ?? 0;
  const reasoningTokens = numberValue(usage.reasoningTokens ?? usage.reasoning);
  const cachedInputTokens = numberValue(usage.cachedReadTokens ?? usage.cacheReadTokens);
  const cachedWriteInputTokens = numberValue(usage.cachedWriteTokens ?? usage.cacheWriteTokens);
  const inputSideTokens =
    inputTokens > 0 ? inputTokens : (cachedInputTokens ?? 0) + (cachedWriteInputTokens ?? 0);
  const totalTokens =
    numberValue(usage.totalTokens ?? usage.total) ?? inputSideTokens + outputTokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    reasoningTokens,
    cachedInputTokens,
    cachedWriteInputTokens,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isAskUserQuestionToolName(value: string | undefined): boolean {
  return value === ASK_USER_QUESTION_TOOL_NAME;
}

function isExitPlanModeToolName(value: string | undefined): boolean {
  return value === EXIT_PLAN_MODE_TOOL_NAME;
}

function isUserInputBackedPermissionToolName(value: string | undefined): boolean {
  return isAskUserQuestionToolName(value) || isExitPlanModeToolName(value);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonNegativeIntegerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function positiveIntegerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function timelineStatusValue(value: unknown): ZCodeTimelineStatus | undefined {
  return value === "started" ||
    value === "retrying" ||
    value === "skipped" ||
    value === "completed" ||
    value === "failed" ||
    value === "interrupted"
    ? value
    : undefined;
}

function timelineTriggerValue(value: unknown): ZCodeTimelineTrigger | undefined {
  return value === "manual" ||
    value === "auto" ||
    value === "reactive" ||
    value === "partial" ||
    value === "session_memory"
    ? value
    : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function turnSteerSourceValue(value: unknown): ZCodeTurnSteerSource | undefined {
  return value === "plan_approval_feedback" || value === "workflow_refine_feedback"
    ? value
    : undefined;
}

function turnSteerCommandKindValue(value: unknown): ZCodeTurnSteerCommandKind | undefined {
  return value === "sendGoalCommand" || value === "sendText" || value === "compact"
    ? value
    : undefined;
}
