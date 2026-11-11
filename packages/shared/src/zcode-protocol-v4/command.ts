import { genUiModelContextSchema } from "../gen-ui/contract.js";
import { createSessionRequestedConfigSchema } from "./create-session-config.js";
import { localTtftContextSchema, localTtftClockSchema } from "../local-ttft/contract.js";
import { conversationQuotesSchema } from "../conversationSelection.js";
// Command 层：信封 / ACK / 命令全集 payload。
// conversation rewind 无独立命令（裁决：= editUserQuery 的 UI 入口）；
// workspace-only 文件撤销走 applyFileRewind，不截断聊天历史。
import { z } from "zod";
import {
  conversationRowTargetSchema,
  timestampSchema,
  v4ColdResumeWorkspaceSchema,
} from "./core.js";
import { attachmentRefSchema } from "./attachment-ref.js";
import { turnHeaderRowSchema } from "./rows.js";
import { v4ConversationFileRewindPreviewResultSchema } from "./transport.js";
import { modelSelectionSchema } from "../model-selection.js";
import { modelExecutionSchema } from "../model-execution.js";
import { submissionModeSchema } from "./submission.js";
import { botGroupInputSourceSchema, zcodeAutomationBotDeliveryTargetSchema } from "../bots.js";
import { DYNAMIC_WORKFLOW_MODES } from "../dynamic-workflow-feature.js";
import {
  amendWorkflowRunSettingsPayloadSchema,
  amendWorkflowRunSettingsResultSchema,
} from "./workflow-run-settings-command.js";
import {
  workspaceHookReviewCommandTargetSchema,
  workspaceHookReviewDecisionSchema,
  workspaceHookTrustRevokeTargetSchema,
  requestWorkspaceHookReviewTargetSchema,
} from "./workspace-hook-review.js";
import {
  zcodeBrowserAmbientContextSchema,
  zcodeProtocolMcpServerSchema,
} from "../zcode-protocol/index.js";
import { highspeedMessageMetaSchema } from "../highspeed.js";
import { sharedContextRefSchema } from "./shared-context-ref.js";
import { conversationInputSourceSchema } from "./input-intent.js";
export type { SharedContextRef } from "./shared-context-ref.js";
export * from "./workflow-command-rejections.js";

/**
 * 受管 worktree 的创建结果（docs/git/worktree.md §6.6.4）。CLI 把它写成会话历史中的
 * timeline part（timelineType = "worktree_creation"），V4 投影为 worktreeCreated 标记。
 */
export const worktreeCreationRecordSchema = z
  .object({
    /** worktree 根目录。 */
    path: z.string().trim().min(1),
    /** 检出的 commit。 */
    sha: z.string().trim().min(1),
    /** 用户选择的起点；null = 源目录当前 HEAD。 */
    ref: z.string().min(1).nullable(),
    /** git 与拷贝输出的末尾。 */
    output: z.string().max(64 * 1024),
  })
  .strict();
export type WorktreeCreationRecord = z.infer<typeof worktreeCreationRecordSchema>;

/**
 * forkAssistant 把子会话放到同一 workspace 下的另一个 cwd（受管 worktree，§8.2）。
 * childSessionId 由 Host 预分配。strict：未声明字段直接拒绝，不静默丢弃。
 */
export const forkTargetCwdSchema = z
  .object({
    cwd: z.string().trim().min(1),
    childSessionId: z.string().trim().min(1),
    worktreeCreation: worktreeCreationRecordSchema,
  })
  .strict();
export type ForkTargetCwd = z.infer<typeof forkTargetCwdSchema>;

// sendText / editUserQuery / sendQueuedNow 共用的执行材料不变量：modelExecution 只能依附
// 本次 modelSelection，禁止在缺 Selection 时单独补供凭据（历史消息 rewind 后不复用旧凭据）。
function requireModelSelectionForExecution(
  payload: { modelSelection?: unknown; modelExecution?: unknown },
  context: z.RefinementCtx,
): void {
  if (payload.modelExecution && !payload.modelSelection) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "modelExecution requires modelSelection",
      path: ["modelExecution"],
    });
  }
}

// ── §6.4 命令 payload 全集 ──
export const commandPayloadSchemas = {
  // firstInput 缺省 → phase=draft 空会话；携带 → 直接 turnHeader+userInput rows。
  createSession: z.object({
    // Host 预留归属使用稳定 ID；CLI 仍负责拒绝覆盖既有会话。
    sessionId: z.string().min(1).optional(),
    additionalDirectories: z.array(z.string().min(1)).max(256).optional(),
    workspaceId: z.string(),
    // 会话 cwd 与 workspace 不同（受管 worktree，docs/git/worktree.md §1.1）。只允许本地
    // workspace；只有 Host 的 worktree 服务能设置，renderer 发出的 createSession 带此字段时
    // Host 拒绝。旧 CLI 的 z.object 会静默丢弃，所以 Host 必须先确认 capabilities.worktreeCwd。
    cwd: z.string().trim().min(1).optional(),
    // 与 cwd 同时出现：CLI 把它写成第一轮的 "已创建 worktree" timeline part。
    worktreeCreation: worktreeCreationRecordSchema.optional(),
    permissionScope: z.literal("session").optional(),
    firstInput: z
      .object({
        text: z.string(),
        attachments: z.array(attachmentRefSchema).optional(),
        modelSelection: modelSelectionSchema.optional(),
        mode: submissionModeSchema.optional(),
        planEnabled: z.boolean().optional(),
        // 与 sendText.source 同一契约（扩展代建会话的首条消息）。旧 CLI 的 z.object 会静默剥掉它，
        // 消息照常创建却没有来源，所以带 extension 来源时 Host 必须先确认
        // runtime/capabilities.extensionInputSource。
        source: conversationInputSourceSchema.optional(),
      })
      .optional(),
    config: createSessionRequestedConfigSchema.optional(),
    // MCP 是 runtime 启动期配置，必须随 create 一次性进入 record，不能在首发后补写。
    mcpServers: z.array(zcodeProtocolMcpServerSchema).optional(),
    // Off-Peak 工具面 flag，与 legacy session/create 等价——V4 createSession 是桌面
    // 新会话的实际创建路径，不透传则 OffPeakCreate/OffPeakList 永不注册。additive，
    // 旧 CLI 的 z.object 会静默丢弃该键（fail-closed）。
    offPeakToolEnabled: z.boolean().optional(),
    // 动态工作流灰度 flag，与 offPeakToolEnabled 同一模式。
    dynamicWorkflowEnabled: z.boolean().optional(),
    // 灰度 mode 与布尔同行（launch.md「On demand: activation」）；旧 CLI 的 z.object 静默丢弃。
    dynamicWorkflowMode: z.enum(DYNAMIC_WORKFLOW_MODES).optional(),
  }),
  // 父会话由 envelope.sessionId 指定；服务端从父 record 派生完整运行配置。
  // firstInput 存在时，child 创建完成后立即启动首条普通输入；缺省则保持空副屏。
  createSelectionSideSession: z.object({
    firstInput: z
      .object({
        text: z.string().trim().min(1),
        // 提交推荐只覆盖新 child 的完整选择，缺省保留父 runtime 继承。
        modelSelection: modelSelectionSchema.optional(),
      })
      .optional(),
  }),
  // 按 inputRouting 裁决：startNow / enqueue / guide / choice。
  // heldQueueDisposition：held 状态（inputRouting.mode=choice）下必带；
  // clear→清空 queue 后 startNow，keep→保留 queue 立即 startNow。
  sendText: z
    .object({
      text: z.string(),
      attachments: z.array(attachmentRefSchema).optional(),
      // Desktop Cmd/Ctrl+Enter 只覆盖本次 busy input，不改 session followupMode。
      // startNow 由 CLI 原子抢占当前 turn，不经过 queue admission。
      requestedDelivery: z.enum(["startNow", "queue", "guide"]).optional(),
      genUiContext: genUiModelContextSchema.optional(),
      browserAmbientContext: zcodeBrowserAmbientContextSchema.optional(),
      // Share handover 只允许当前 session 的一个已导入上下文；完整正文由 runtime 从
      // 持久化 provenance 解析，不能随 command 从 renderer 传入。
      context_refs: z.array(sharedContextRefSchema).max(1).optional(),
      // 结构化来源（插件 UI、交互视图、会话、扩展）；随 intent 持久化并投影到 userInput row。
      source: conversationInputSourceSchema.optional(),
      heldQueueDisposition: z.enum(["clearQueueAndSend", "keepQueueAndSend"]).optional(),
      // 暂停队列确认框打开时看到的 queueItemId 集合。CLI 在执行 clear/keep 前校验，
      // 防止桌面/手机并发增删后把用户没确认过的新队列一并处置。
      expectedHeldQueueItemIds: z.array(z.string().min(1)).optional(),
      // 迁移期允许旧发送端缺省；CLI admission 会把当前 Session Selection 固定进
      // canonical intent。Renderer 切换完成后，第一方用户提交始终显式携带这两项。
      modelSelection: modelSelectionSchema.optional(),
      // Bot 异步解析的读取依据；接纳时若已变化，固定最新 Session Selection。
      modelSelectionBasis: modelSelectionSchema.optional(),
      mode: submissionModeSchema.optional(),
      planEnabled: z.boolean().optional(),
      // 本次执行仍使用上面的标准 Selection；这里只携带不持久化语义、动态鉴权和 child 策略。
      // 仅 idle startNow 接受，防止 Secret/Ticket 进入普通 CommandInbox。
      modelExecution: modelExecutionSchema.optional(),
      // Highspeed 卡快照随输入事实进入 message.data；不包含 runtime 凭据或 header。
      // 加速本轮的模型与凭据走上面的 modelSelection + modelExecution，见
      // docs/highspeed/highspeed-access-mode-migration.md。
      highspeedMeta: highspeedMessageMetaSchema.optional(),
      automationId: z.string().min(1).optional(),
      offPeakTaskId: z.string().min(1).optional(),
      offPeakRunType: z.enum(["init", "resume"]).optional(),
      // Bot 来源只由 Host 注入，用于 CronCreate 在当前 turn 内读取并持久化回推地址。
      botDeliveryTarget: zcodeAutomationBotDeliveryTargetSchema.optional(),
      inputOrigin: z.enum(["desktop", "mobile"]).optional(),
      botGroupSource: botGroupInputSourceSchema.optional(),
      conversationQuotes: conversationQuotesSchema.optional(),
      // 定时任务会话的后续用户输入也必须保持 turn-scoped 工具面隔离；不能借用
      // automationId，否则会把普通用户输入误标成一次 automation 派发。
      toolDisallowlist: z.array(z.string().min(1)).optional(),
    })
    .superRefine((payload, context) => {
      if (payload.automationId && payload.offPeakTaskId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "automationId and offPeakTaskId are mutually exclusive",
        });
      }
      if (payload.offPeakRunType && !payload.offPeakTaskId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "offPeakRunType requires offPeakTaskId",
          path: ["offPeakRunType"],
        });
      }
      requireModelSelectionForExecution(payload, context);
    }),
  sendGoalCommand: z.object({
    text: z.string(),
    displayText: z.string().optional(),
    modelSelection: modelSelectionSchema.optional(),
    mode: submissionModeSchema.optional(),
    planEnabled: z.boolean().optional(),
    heldQueueDisposition: z.enum(["clearQueueAndSend", "keepQueueAndSend"]).optional(),
    expectedHeldQueueItemIds: z.array(z.string().min(1)).optional(),
  }),
  stop: z.object({
    // 来自 activeWorks；CLI 用它拒绝会误杀后续无关执行的迟到 Stop。
    expectedForegroundExecutionId: z.string().min(1).optional(),
  }),
  stopSubagent: z
    .object({
      taskId: z.string().min(1),
      executionId: z.string().min(1),
    })
    .strict(),
  // compact 是输入型维护命令：idle 时立即执行，busy/held 时进入 FIFO。
  // 因为 admission 与当前 revision 无关，不走 CAS；sourceCommandId 提供幂等边界。
  compact: z.object({ modelSelection: modelSelectionSchema.optional() }),
  // running 时对稳定 assistant row 可用。
  forkAssistant: z.object({
    target: conversationRowTargetSchema,
    // 子会话留在同一 workspace，cwd 换成新的受管 worktree（docs/git/worktree.md §8.2）。
    // 缺省 = 父会话 cwd，行为不变。旧 CLI 会静默丢弃该字段并 fork 到父目录，
    // 所以 Host 必须先确认 runtime/capabilities.worktreeCwd 再发送。
    // 附加目录不在这里下发：由 Host 在子会话 create/resume/subscribe 时统一下发（I16）。
    targetCwd: forkTargetCwdSchema.optional(),
  }),
  applyFileRewind: z.object({ target: conversationRowTargetSchema }),
  editUserQuery: z
    .object({
      target: conversationRowTargetSchema,
      newText: z.string(),
      conversationQuotes: conversationQuotesSchema.optional(),
      attachments: z.array(attachmentRefSchema).optional(),
      // 编辑重发按新的主动发送处理：只接受本次重新 prepare 得到的卡与执行材料，
      // 不从被 rewind 的历史消息复用旧凭据。
      modelSelection: modelSelectionSchema.optional(),
      modelExecution: modelExecutionSchema.optional(),
      highspeedMeta: highspeedMessageMetaSchema.optional(),
      // 缺省 preserve：仅切 conversation branch；rewind 会先安全恢复该轮文件。
      workspaceMode: z.enum(["preserve", "rewind"]).optional(),
      // composer 编辑态复用普通发送的工具栏：与 sendText 同语义，缺省沿用原 intent。
      mode: submissionModeSchema.optional(),
      planEnabled: z.boolean().optional(),
    })
    .superRefine(requireModelSelectionForExecution),
  retryTurn: z.object({ target: conversationRowTargetSchema }),
  // （2026-09-12）：原 setToolWidgetState / setSessionPluginUiState 已删除——插件 UI widgetState
  // 回退为宿主 renderer 内存保存，不再写 CLI 会话存储；模型可见信息改走 ui/update-model-context。
  setAssistantFeedback: z.object({
    target: conversationRowTargetSchema,
    feedback: z.enum(["like", "dislike"]).nullable(),
  }),
  setHighspeedMetrics: z.object({
    target: conversationRowTargetSchema,
    regularTps: z.number().positive(),
    outputTokens: z.number().int().nonnegative(),
    durationMs: z.number().nonnegative(),
    highspeedTps: z.number().positive(),
    savedDurationMs: z.number().nonnegative(),
    modelDurationMs: z.number().nonnegative().optional(),
    toolDurationMs: z.number().nonnegative().optional(),
    otherDurationMs: z.number().nonnegative().optional(),
  }),
  sendQueuedNow: z
    .object({
      queueItemId: z.string(),
      // 手动提升允许 Renderer 为原队列项补充同卡执行材料；凭据不入队列持久化面。
      modelSelection: modelSelectionSchema.optional(),
      modelExecution: modelExecutionSchema.optional(),
      highspeedMeta: highspeedMessageMetaSchema.optional(),
    })
    .superRefine(requireModelSelectionForExecution),
  // 冻结编辑（docs/ui/composer-edit-mode.md）：lock 只对 queued 且无锁的项成功；
  // editQueueItem 携带 editorId 时必须持有锁，原地替换后同一命令释放锁。
  // attachments/modelSelection/mode/planEnabled 缺省 = 保留原值；attachments=[] 表示清空。
  lockQueueItemEdit: z.object({ queueItemId: z.string(), editorId: z.string().min(1) }),
  releaseQueueItemEdit: z.object({ queueItemId: z.string() }),
  editQueueItem: z.object({
    queueItemId: z.string(),
    newText: z.string(),
    editorId: z.string().min(1).optional(),
    attachments: z.array(attachmentRefSchema).optional(),
    conversationQuotes: conversationQuotesSchema.optional(),
    modelSelection: modelSelectionSchema.optional(),
    mode: submissionModeSchema.optional(),
    planEnabled: z.boolean().optional(),
  }),
  // 编辑提交后把新模型/mode 应用到其他排队项（docs/ui/composer-edit-mode.md）：正文与 Plan 不变；
  // 不存在、非 queued、compact、有编辑锁的项跳过，全部跳过 = noop。不走 CAS，理由同 editQueueItem。
  applyQueueItemsConfig: z
    .object({
      queueItemIds: z.array(z.string()).min(1),
      modelSelection: modelSelectionSchema.optional(),
      mode: submissionModeSchema.optional(),
    })
    .refine((value) => value.modelSelection !== undefined || value.mode !== undefined, {
      message: "applyQueueItemsConfig requires modelSelection or mode",
    }),
  // beforeQueueItemId = null → 移到队尾。
  reorderQueueItem: z.object({
    queueItemId: z.string(),
    beforeQueueItemId: z.string().nullable(),
  }),
  deleteQueueItem: z.object({ queueItemId: z.string() }),
  setAutoDrain: z.object({ autoDrain: z.boolean() }),
  // 先到先得，晚到 noop（reasonCode=proto.alreadyResolved）。
  resolveInteraction: z.object({
    interactionId: z.string(),
    answer: z.object({
      optionId: z.string().optional(),
      freeText: z.string().optional(),
      // （elicitation 回执收敛）：AskUserQuestion/plan-approval 的
      // 多题答案与注解无损承载。action 存在时 CLI broker 按 accept/decline/cancel
      // 精确映射（content 直传旧 userInput response 语义）；缺省沿用
      // optionId/freeText 兼容路径，旧客户端行为不变。
      action: z.enum(["accept", "decline", "cancel"]).optional(),
      content: z.record(z.string(), z.unknown()).optional(),
    }),
  }),
  respondWorkspaceHookReview: workspaceHookReviewCommandTargetSchema.extend({
    decision: workspaceHookReviewDecisionSchema,
  }),
  toggleWorkspaceHookReviewItem: workspaceHookReviewCommandTargetSchema.extend({
    reviewItemId: z.string().trim().min(1),
    enabled: z.boolean(),
  }),
  revokeWorkspaceHookTrust: z.union([
    workspaceHookReviewCommandTargetSchema.extend({
      reviewItemIds: z.array(z.string().trim().min(1)).min(1),
    }),
    workspaceHookTrustRevokeTargetSchema,
  ]),
  // 软门禁：按需开审核 flow,克隆 revoke non-flow target 但不带 hookDeclarationDigests。
  requestWorkspaceHookReview: requestWorkspaceHookReviewTargetSchema,
  // AskUserQuestion 首次有效操作永久暂停本次自动结束；重复/迟到调用为幂等 noop。
  snoozeInteractionAutoResolution: z.object({
    interactionId: z.string(),
  }),
  switchModelConfig: z.object({
    provider: z.string(),
    model: z.string(),
    thought: z.string(),
  }),
  // additive（冻结面按黄金测试背书演进）：agent 协作模式切换。
  // 值域 = core CollaborationMode 的可切换子集（auto 非用户可切，不进 UI 命令面）。
  switchCollaborationMode: z.object({
    mode: z.enum(["build", "edit", "plan", "yolo", "guarded"]),
  }),
  setFollowupMode: z.object({ mode: z.enum(["queue", "guide"]) }),
  pauseGoal: z.object({}),
  resumeGoal: z.object({}),
  cancelBackgroundWork: z.object({ workId: z.string() }),
  // cancel & resume：恢复一个已取消 / 被进程死亡
  // 打断的 dwf run。workId ≡ runId（与 cancelBackgroundWork 同一个身份等式）；`name` 可选，
  // 喂恢复后完成通知的主题（重启后原 CreateWorkflow 工具 input 不可得）。刻意不携
  // baseRevision：与 cancelBackgroundWork 同类（workflowRuns 面免 revision，假 CAS 失败
  // 只会误伤）。门在 CLI 侧（可恢复集 = cancelled ∪ failed+Interrupted），拒绝以
  // fault.command.workflowRunResumeRejected.<reason> 回 ACK。
  resumeWorkflowRun: z.object({ workId: z.string(), name: z.string().optional() }),
  // startSavedWorkflow：中枢「运行」不再合成
  // 对话文案，直接请 agent 在新会话里启动已保存工作流。与 cancelBackgroundWork / resumeWorkflowRun
  // 同类：不携 baseRevision（workflowRuns 面免 revision，假 CAS 失败只会误伤）。name 由 agent 从
  // 解析结果填（不变式 6），命令不收 name 覆盖。
  // 拒绝以 fault.command.savedWorkflowStartRejected.<reason> 回 ACK（词表见下方
  // workflow-command-rejections.ts 的 savedWorkflowStartRejectionReasonSchema）；能力缺席（无 dwf 端口）→ V4CapabilityUnsupportedError
  // （与 resumeWorkflowRun 同一条错误）。
  startSavedWorkflow: z.object({
    name: z.string().min(1),
    scope: z.enum(["project", "global"]).optional(),
    args: z.record(z.string(), z.unknown()).optional(),
  }),
  // amendWorkflowRunSettings：run 卡 / 详情页的「配置」直接请 agent 以新设置修订 run，不经模型轮。载荷、结果与拒绝
  // 词表见 workflow-run-settings-command.ts；能力缺席 → V4CapabilityUnsupportedError。
  amendWorkflowRunSettings: amendWorkflowRunSettingsPayloadSchema,
  renameSession: z.object({ title: z.string() }),
  deleteSession: z.object({}),
  discardSharedContext: z.object({ contextId: z.string().trim().min(1) }).strict(),
} as const;

export type CommandType = keyof typeof commandPayloadSchemas;
export type CommandPayloadMap = {
  [T in CommandType]: T extends "sendText"
    ? z.infer<(typeof commandPayloadSchemas)[T]> &
        import("../zcode-task-types-core.js").ZCodeBackgroundTurnAttribution
    : z.infer<(typeof commandPayloadSchemas)[T]>;
};

export const commandTypeSchema = z.enum(
  Object.keys(commandPayloadSchemas) as [CommandType, ...CommandType[]],
);

// cancelBackgroundWork 的拒绝：core 明确回「没有取消任何东西」时（任务不存在 / 已终结 / 类型不支持）
// 以前缀 + reason 上行，而不是一个假装成功的 accepted——详情页据此告诉用户这个 run 并不在跑。
// reason 即 core 的 stopBackgroundTask reason 去掉 `background_task_` 前缀：not_found /
// not_running / cancel_not_supported。
export const BACKGROUND_WORK_CANCEL_REJECTED_FAULT_PREFIX =
  "fault.command.backgroundWorkCancelRejected." as const;

// CAS ✓ 的命令：信封必带 baseRevision。
export const COMMANDS_REQUIRING_BASE_REVISION: ReadonlySet<CommandType> = new Set([
  "applyFileRewind",
  "forkAssistant",
  "editUserQuery",
  "retryTurn",
  "setAssistantFeedback",
  "sendQueuedNow",
  // editQueueItem 不走 CAS：运行中 revision 随 control/queue 投影频繁递增，用户编辑排队消息的提交
  // 会被 proto.staleRevision 误拒。冻结编辑的并发保护是 CLI 编辑锁（editorId 必须仍持锁）。
  "reorderQueueItem",
  "deleteQueueItem",
  "setAutoDrain",
  "switchModelConfig",
  "switchCollaborationMode",
  "setFollowupMode",
  "pauseGoal",
  "resumeGoal",
]);

export const ROW_TARGETING_COMMANDS: ReadonlySet<CommandType> = new Set([
  "applyFileRewind",
  "forkAssistant",
  "editUserQuery",
  "retryTurn",
  "setAssistantFeedback",
  "setHighspeedMetrics",
]);

// ── 信封 ──
export const commandEnvelopeSchema = z.object({
  workspace: v4ColdResumeWorkspaceSchema,
  /** 仅 Host 根据当前附件握手注入；未知 CLI 不发送。 */
  pluginDiscoveryUi: z.literal(true).optional(),
  /** Host 可信 attachment 注入；CLI 保留到原 input intent。 */
  inputOrigin: z.enum(["desktop", "mobile"]).optional(),
  ttft: localTtftContextSchema.optional(),
  // uuid v7，客户端生成，重试不变。
  commandId: z.string(),
  clientId: z.string(),
  // createSession 时为 null。
  sessionId: z.string().nullable(),
  baseRevision: z.number().optional(),
  baseLogEpoch: z.string().trim().min(1).optional(),
  type: commandTypeSchema,
  payload: z.unknown(),
  // 客户端时钟，仅遥测；服务端不用于任何裁决。
  issuedAt: timestampSchema,
});
export type CommandEnvelope = z.infer<typeof commandEnvelopeSchema>;

/** 校验信封并按 type 校验 payload（信封 schema 无法静态关联 payload，收口在这里）。 */
export function parseCommandEnvelope(
  value: unknown,
): { ok: true; envelope: CommandEnvelope } | { ok: false; error: z.ZodError } {
  const envelope = commandEnvelopeSchema.safeParse(value);
  if (!envelope.success) return { ok: false, error: envelope.error };
  const payload = commandPayloadSchemas[envelope.data.type].safeParse(envelope.data.payload);
  if (!payload.success) return { ok: false, error: payload.error };
  if (
    (COMMANDS_REQUIRING_BASE_REVISION.has(envelope.data.type) &&
      envelope.data.baseRevision === undefined) ||
    (ROW_TARGETING_COMMANDS.has(envelope.data.type) && envelope.data.baseLogEpoch === undefined)
  ) {
    return {
      ok: false,
      error: new z.ZodError([
        {
          code: "custom",
          path: [envelope.data.baseRevision === undefined ? "baseRevision" : "baseLogEpoch"],
          message: "CAS commands require baseRevision and baseLogEpoch",
        },
      ]),
    };
  }
  return {
    ok: true,
    envelope: { ...envelope.data, payload: payload.data },
  };
}

// ── ACK ──
/** 同一审批已提交后的重试原因码。只有原权限可继续发布，不得据失败回执更新偏好。 */
export const permissionGrantCommittedReasons = {
  guarded: "fault.permissionGrant.committed.guarded",
  yolo: "fault.permissionGrant.committed.yolo",
} as const;
export function committedPermissionGrantMode(reasonCode: string | undefined) {
  if (reasonCode === permissionGrantCommittedReasons.guarded) return "guarded";
  if (reasonCode === permissionGrantCommittedReasons.yolo) return "yolo";
  return undefined;
}

export const commandResultSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.enum(["createSession", "createSelectionSideSession", "forkAssistant"]),
    sessionId: z.string(),
    input: z
      .object({
        delivery: z.enum(["startNow", "queue", "guide"]),
        inputId: z.string(),
        // Core admission ACK 不等待 TurnStarted；messageId 可能由后续事件补齐。
        messageId: z.string().optional(),
      })
      .optional(),
  }),
  z.object({
    type: z.literal("resolveInteraction"),
    resolvedBy: z.object({
      clientId: z.string(),
      optionId: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal("applyFileRewind"),
    applied: z.boolean(),
    preview: v4ConversationFileRewindPreviewResultSchema,
    response: z.string(),
  }),
  z.object({
    type: z.literal("editUserQuery"),
    // fork 仅保留旧 ACK 解码兼容；新 editUserQuery 不再生成 child session。
    disposition: z.enum(["rewind", "fork", "blocked"]),
    sessionId: z.string().min(1),
    reasonCode: z.string().min(1).optional(),
    preview: v4ConversationFileRewindPreviewResultSchema.optional(),
  }),
  z.object({
    // startSavedWorkflow accepted ACK：
    // runId 联接启动轮 run 卡状态 / 通知 / 侧板；toolCallId = launch-<uuid>，联接合成 CreateWorkflow 轮。
    type: z.literal("startSavedWorkflow"),
    runId: z.string().min(1),
    toolCallId: z.string().min(1),
  }),
  amendWorkflowRunSettingsResultSchema,
  z.object({
    // messageId 只在 TurnStarted 后作为旁路归因补齐；Core admission ACK 不等待
    // projection commit，不能把 messageId 作为输入 accepted 的必要条件。
    type: z.literal("inputAccepted"),
    delivery: z.enum(["startNow", "queue", "guide"]),
    inputId: z.string(),
    messageId: z.string().optional(),
  }),
  z.object({
    // restart discarded 过去只返回一个无差别 fault，renderer 无法区分
    // runtime-local queue 与仍需人工确认的 startNow。delivery 来自 session_input
    // 持久事实，不能由客户端按当前 UI phase 猜测。
    type: z.literal("inputDisposition"),
    delivery: z.enum(["startNow", "queue", "guide"]),
  }),
]);
export type CommandResult = z.infer<typeof commandResultSchema>;

export const commandAckSchema = z.object({
  /** 会话创建期采用的 App Memory 开关；旧发送端缺省表示未知。 */
  memoryEnabled: z.boolean().optional(),
  ttftExcluded: z.literal("capacity").optional(),
  commandId: z.string(),
  // accepted 不承诺跨 CLI 进程存活；最终收口以权威数据（sourceCommandId）为准。
  status: z.enum(["accepted", "rejected", "stale", "duplicate", "noop", "failed"]),
  // rejected/stale/noop/failed 必带；= guard id 或 fault code（命名空间）。
  reasonCode: z.string().optional(),
  message: z.string().optional(),
  revisionAtDecision: z.number(),
  // duplicate 回放缓存结果；accepted 亦可即时带（fork）。
  result: commandResultSchema.optional(),
});
export type CommandAck = z.infer<typeof commandAckSchema>;

// ── commands/query ──
/**
 * commands/query 读取命令记录失败时的 reasonCode（status 为 failed）。它表示"无法确认命令是否执行"，
 * 不表示命令执行失败；调用方不能据此做破坏性清理（docs/git/worktree.md §3.5）。
 */
export const COMMAND_QUERY_UNAVAILABLE_REASON = "fault.command.queryUnavailable" as const;
export const commandKeySchema = z
  .object({
    // null 只属于全局/createSession 幂等桶；session 命令必须携带 sessionId。
    sessionId: z.string().nullable(),
    commandId: z.string().min(1),
  })
  .strict();
export type CommandKey = z.infer<typeof commandKeySchema>;

export const commandsQueryParamsSchema = z
  .object({
    commands: z.array(commandKeySchema).min(1).max(64),
    clock: z.literal(true).optional(),
  })
  .strict()
  .refine(
    (params) => !params.clock || params.commands.every((key) => key.sessionId === null),
    "clock probes cannot query session commands",
  );
export type CommandsQueryParams = z.infer<typeof commandsQueryParamsSchema>;

// 命令对应回合的当前状态：owner 全量投影中 sourceCommandId 匹配的第一个 turnHeader。
// 修复原因：快照只下发 60 行尾窗，长回合的 header 会滚出窗口，客户端据此判定 wait 结果会得到
// unknown，审批也匹配不到回合。由 owner 直接给出，不受尾窗限制；只出现在 session bucket。
export const commandQueryTurnSchema = z
  .object({
    turnId: turnHeaderRowSchema.shape.turnId,
    state: turnHeaderRowSchema.shape.state,
  })
  .strict();
export type CommandQueryTurn = z.infer<typeof commandQueryTurnSchema>;

export const commandQueryItemSchema = z
  .object({
    key: commandKeySchema,
    result: z.union([commandAckSchema, z.literal("unknown")]),
    turn: commandQueryTurnSchema.optional(),
  })
  .strict()
  .refine((item) => !item.turn || item.key.sessionId !== null, "global commands carry no turn");
export type CommandQueryItem = z.infer<typeof commandQueryItemSchema>;

export const commandsQueryResultSchema = z
  .object({
    results: z.array(commandQueryItemSchema).min(1).max(64),
    clock: localTtftClockSchema.optional(),
  })
  .strict();
export type CommandsQueryResult = z.infer<typeof commandsQueryResultSchema>;
