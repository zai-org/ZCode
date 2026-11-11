/* eslint-disable max-lines -- 保持既有 transcript → event 恢复 owner；本次只透传输入快照，不拆分恢复状态机。 */
// Transcript → SessionEvent 合成（「reduce(transcript) ≡ reduce(events)」）。
//
// 动机：v4 投影是事件溯源，但部分历史突变（纯对话 fork 复制 message 不复制 event、
// rewind 截断只动 message 库）会让 session 的事件日志无法覆盖可见 transcript。冷订阅
// hydration 从事件日志重建拿不到这些历史（「fork-child 历史」）。
//
// 本模块把 message 库的 transcript 反向合成为 reducer 能消费的 SessionEvent 序列——
// 从而复用整套 ProductProjection 归约逻辑，不必再写一份 message→row 的平行归约器。
// 合成事件是「视图重建」用途：只需产出与真实事件流「归约等价」的最小序列。
// v4 冷恢复只能重放 ProductProjection 认识的事件；如果 transcript 里的
// tool/reasoning/subagent/compact part 不反向合成，重启后历史可见运行态会从快照里消失。
import type {
  AssistantErrorInfo,
  BackgroundResultOriginMeta,
  CompactTimelineStatus as CompactTimelineStatusValue,
  MessagePart,
  MessageWithParts,
  ModelSelection,
  TurnFileChangeSummary,
  TurnInputIntentMetadata,
} from "@zcode/contracts";
import { INTERRUPT_MARKER_SOURCE, joinTaskNotificationBatch } from "@zcode/core";
import { isHighspeedProviderId } from "@zcode/shared";
import type { EventId, SessionEvent, SessionId, TraceId, TurnId } from "@zcode/contracts";
import {
  CompactTimelineStatus,
  CompactTrigger,
  CoreErrorType,
  createSessionId,
  ModelErrorCode,
  parseCompletedToolPartMetadata,
  SessionEventType,
  STREAM_RECOVERY_DISCARDED_ERROR_NAME,
} from "@zcode/contracts";
import {
  getConversationModelOnlyTurnTriggerSource,
  getConversationMessageProjectionPolicy,
  highspeedMessageMetaSchema,
  isConversationRealUserTurnStarter,
} from "@zcode/shared";
import {
  conversationInputIntentSchema,
  errorAttributionSchema,
  subagentResultMetaSchema,
  workflowBlockedMetaSchema,
  workflowLaunchMetaSchema,
  workflowNotificationMetaSchema,
  type ErrorAttribution,
  type WorkflowLaunchMeta,
} from "@zcode/shared/zcode-protocol-v4";
import { shouldHideInvalidToolCallFromProduct } from "../tool-call-product-visibility.js";
import { ProductProjection } from "./product-projection.js";
import { HYDRATION_TRACE_ID } from "./projection-state.js";

const SUBAGENT_TOOL_NAMES = new Set(["Agent", "Task", "subagent"]);
const LEGACY_MODEL_REQUEST_CANCELLED_MESSAGE = "Model request was cancelled.";
const LEGACY_PROTOCOL_SESSION_STOPPED_MESSAGE = "ZCode Protocol session stopped";
const PERSISTED_CANCELLATION_CODES = new Set<string>([
  CoreErrorType.TurnCancelled,
  ModelErrorCode.ModelRequestCancelled,
  "MODEL_REQUEST_CANCELLED",
  "ABORT_ERR",
]);

type PushEvent = (
  type: SessionEventType,
  payload: unknown,
  turnId?: string,
  sourceTimestampMs?: number,
) => void;

type TurnResultForHydration = "success" | "cancelled" | "error_during_execution";

interface AssistantSynthesisState {
  toolCallCount: number;
  resultType: TurnResultForHydration;
}

interface TranscriptFootprint {
  userTurnCount: number;
  assistantTexts: string[];
  reasoningTexts: string[];
  toolCallIds: string[];
  compactMarkerCount: number;
  subagentCount: number;
  forkTimelineCount: number;
  // 16-timeline-authority-plan P1：守恒判据曾对 goal verify / model change 全盲
  //（footprint 不计数 → 缺这两类 marker 的事件日志被误判为已覆盖）。
  goalVerificationCount: number;
  modelChangeCount: number;
  worktreeCreatedCount: number;
}

interface ParsedSubagentOutput {
  agentId?: string;
  agentType?: string;
  childSessionId?: string;
  description?: string;
  parentToolCallId?: string;
  prompt?: string;
  summaryText?: string;
}

interface SynthesizeOptions {
  sessionId: string;
  /**
   * 当前 session 实际选中模型的权威上下文窗口。
   * transcript 只持久化 token 用量，不持久化模型能力，必须由当前 workspace registry 注入。
   */
  contextWindow?: number;
  /** 合成基准时间戳（确定性：不用 Date.now，由调用方传入首条消息时间兜底）。 */
  baseTimestampMs?: number;
  /**
   * session_entry legacy 源的 goal verify 事实：
   * 有 anchor 的按 anchorAssistantMessageId 落到对应 assistant 之后，
   * 无 anchor/anchor 失配的落到已知时间线末尾；与 timeline part 按 key 去重。
   */
  goalVerificationEntries?: readonly HydratedGoalVerificationEntry[];
  /**
   * workspace checkpoint artifact 按真实 user messageId 重建出的单轮摘要。
   * transcript 没有该字段，必须显式注入合成 ModelComplete 才能保持 live/cold 等价。
   */
  fileChangeSummariesByMessageId?: ReadonlyMap<string, TurnFileChangeSummary>;
}

function isRealUserTurnStarter(message: MessageWithParts): boolean {
  return isConversationRealUserTurnStarter(message);
}

/**
 * 中枢直接启动工作流的启动轮消息。核心持久化时写
 * `source: "workflow_launch"` + `metadata.workflowLaunch`（冷恢复的权威来源）。它是 synthetic
 * 但语义上属于用户真实动作的可见消息，共享投影 policy 会把 synthetic user 归成 hiddenSynthetic，
 * 因此 `isConversationRealUserTurnStarter` 认不出它；冷路径据本判据在 real-user 分支之前显式重建
 * 与活投影同形的 controlOnly 启动轮（TurnStarted{inputSource, workflowLaunch, executionKind} +
 * TurnComplete），而不是被当作隐藏 synthetic 跳过。畸形 / 缺席元数据回 null（退回既有跳过语义）。
 */
function workflowLaunchOfMessage(message: MessageWithParts): WorkflowLaunchMeta | null {
  if (message.info.role !== "user") return null;
  if (message.info.source !== "workflow_launch") return null;
  const metadata = message.info.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const parsed = workflowLaunchMetaSchema.safeParse(
    (metadata as Record<string, unknown>).workflowLaunch,
  );
  return parsed.success ? parsed.data : null;
}

/** core 停止本轮时写的隐藏提醒记录（`interrupt-marker.ts`）。 */
function isInterruptMarkerMessage(message: MessageWithParts): boolean {
  const semantics = message.info.semantics;
  return semantics?.kind === "system_reminder" && semantics.source === INTERRUPT_MARKER_SOURCE;
}

function isProviderContextOnlyAssistant(message: MessageWithParts): boolean {
  return (
    message.info.role === "assistant" &&
    getConversationMessageProjectionPolicy(message) === "providerContextOnly"
  );
}

function textPartsOfMessage(parts: readonly MessagePart[]): string[] {
  return parts
    .filter(
      (part): part is Extract<MessagePart, { type: "text" }> =>
        part.type === "text" && part.ignored !== true,
    )
    .map((part) => part.text);
}

function textOfMessage(parts: readonly MessagePart[]): string {
  return textPartsOfMessage(parts).join("");
}

// 修复原因：空闲整批的每条通知存为一个文本 part，按 "" 连接时相邻通知粘在一起，
// 与 live 的轮输入不同。与 live 用同一个连接函数；旧版本只有一个 part，结果不变。
function backgroundWakeInputOfMessage(parts: readonly MessagePart[]): string {
  return joinTaskNotificationBatch(textPartsOfMessage(parts));
}

function finiteTimeMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function messageCreatedAtMs(message: MessageWithParts): number | undefined {
  return finiteTimeMs(message.info.time.created);
}

function intervalEndOrStartMs(time: { start: number } & Partial<{ end: number }>) {
  return finiteTimeMs(time.end) ?? finiteTimeMs(time.start);
}

function partEndAtMs(part: MessagePart): number | undefined {
  if (part.type === "reasoning") {
    return finiteTimeMs(part.time?.end) ?? finiteTimeMs(part.time?.start);
  }
  if (part.type === "tool" && "time" in part.state) {
    return intervalEndOrStartMs(part.state.time);
  }
  return undefined;
}

function messageEndAtMs(message: MessageWithParts): number | undefined {
  const time = message.info.time;
  // 冷恢复会同时处理 user/assistant message；user 只有 created，
  // assistant 才可能有 completed，所以这里必须按字段存在性收窄后再取结束时间。
  let end =
    ("completed" in time ? finiteTimeMs(time.completed) : undefined) ?? finiteTimeMs(time.created);
  for (const part of message.parts) {
    const partEnd = partEndAtMs(part);
    if (partEnd !== undefined) {
      end = end === undefined ? partEnd : Math.max(end, partEnd);
    }
  }
  return end;
}

function normalizeTurnResult(
  current: TurnResultForHydration,
  next: TurnResultForHydration,
): TurnResultForHydration {
  if (current === "cancelled" || next === "cancelled") {
    return "cancelled";
  }
  if (current === "error_during_execution" || next === "error_during_execution") {
    return "error_during_execution";
  }
  return "success";
}

function assistantErrorData(error: AssistantErrorInfo): Record<string, unknown> | undefined {
  return error.data && typeof error.data === "object" && !Array.isArray(error.data)
    ? error.data
    : undefined;
}

function persistedErrorAttribution(
  data: Record<string, unknown> | undefined,
): ErrorAttribution | undefined {
  const parsed = errorAttributionSchema.safeParse(data?.attribution);
  return parsed.success ? parsed.data : undefined;
}

function isPersistedAssistantCancellation(error: AssistantErrorInfo): boolean {
  const data = assistantErrorData(error);
  const code = typeof data?.code === "string" ? data.code : undefined;
  if (
    data?.turnResult === "cancelled" ||
    data?.resultType === "cancelled" ||
    (code !== undefined && PERSISTED_CANCELLATION_CODES.has(code)) ||
    error.name === "AbortError"
  ) {
    return true;
  }

  if (
    code === undefined &&
    error.name === "Error" &&
    data?.message === LEGACY_PROTOCOL_SESSION_STOPPED_MESSAGE
  ) {
    // 旧 session/stop 使用普通 Error 作为 AbortSignal.reason，transcript 又未持久化
    // cancelled result；冷恢复若只认 AbortError，会把用户停止重新合成为 TurnError 和错误 Banner。
    return true;
  }

  // 旧 transcript 的 AiSdkModelAdapterError 没有持久化 model error code，
  // 只能用 ZCode 自身生成的标准 name/message 二元组兼容恢复；不泛化匹配 provider 文案。
  return (
    code === undefined &&
    error.name === "AiSdkModelAdapterError" &&
    data?.message === LEGACY_MODEL_REQUEST_CANCELLED_MESSAGE
  );
}

/**
 * stream recovery 把作废的半截 assistant 持久化成带 error 的消息，随后从锚点
 * 重发并正常完成；live 投影只把它收口为 interrupted 行，不产生 TurnError。旧冷恢复却把
 * 任何带 error 的 assistant 都当本轮失败，重开会话后凭空弹出「Partial assistant output
 * was discarded」的错误 Banner。这个标记只服务压缩/fork 边界隔离，对本轮结果必须透明。
 */
function isPersistedStreamRecoveryDiscard(error: AssistantErrorInfo): boolean {
  return error.name === STREAM_RECOVERY_DISCARDED_ERROR_NAME;
}

function stableToolSchedule(toolCallId: string) {
  return {
    executionOrder: [toolCallId],
    parallelGroups: [[toolCallId]],
  };
}

function compactEventType(status: CompactTimelineStatusValue): SessionEventType {
  if (status === CompactTimelineStatus.Started || status === CompactTimelineStatus.Retrying) {
    return SessionEventType.CompactStarted;
  }
  if (status === CompactTimelineStatus.Completed || status === CompactTimelineStatus.Skipped) {
    return SessionEventType.CompactCompleted;
  }
  return SessionEventType.CompactFailed;
}

function normalizeCompactTimelineStatus(
  status: string | undefined,
): CompactTimelineStatusValue | null {
  switch (status) {
    case CompactTimelineStatus.Started:
    case CompactTimelineStatus.Retrying:
    case CompactTimelineStatus.Skipped:
    case CompactTimelineStatus.Completed:
    case CompactTimelineStatus.Failed:
    case CompactTimelineStatus.Interrupted:
      return status;
    case "cancelled":
      return CompactTimelineStatus.Interrupted;
    default:
      return null;
  }
}

function compactTriggerOfPart(part: Extract<MessagePart, { type: "compaction" }>) {
  return part.trigger ?? (part.auto ? CompactTrigger.Auto : CompactTrigger.Manual);
}

function compactPayloadFromTimelinePart(part: Extract<MessagePart, { type: "timeline" }>) {
  if (part.timelineType !== "context_compaction") return null;
  const status = normalizeCompactTimelineStatus(part.status);
  if (!status) return null;
  return {
    status,
    payload: {
      operationId: part.operationId,
      messageId: String(part.messageID),
      partId: part.id,
      status,
      trigger: part.trigger,
      display: part.display,
      ...(part.sourceCommandId ? { sourceCommandId: part.sourceCommandId } : {}),
      ...(part.anchorMessageId ? { anchorMessageId: part.anchorMessageId } : {}),
      ...(part.anchorTurnId ? { anchorTurnId: part.anchorTurnId } : {}),
      ...(part.phase ? { phase: part.phase } : {}),
      ...(part.compactReason ? { compactReason: part.compactReason } : {}),
      ...(part.reason ? { reason: part.reason } : {}),
      ...(part.boundaryId ? { boundaryId: part.boundaryId } : {}),
      ...(part.summaryMessageId ? { summaryMessageId: part.summaryMessageId } : {}),
      ...(part.preCompactTokenCount !== undefined
        ? { preCompactTokenCount: part.preCompactTokenCount }
        : {}),
      ...(part.postCompactTokenCount !== undefined
        ? { postCompactTokenCount: part.postCompactTokenCount }
        : {}),
      ...(part.truePostCompactTokenCount !== undefined
        ? { truePostCompactTokenCount: part.truePostCompactTokenCount }
        : {}),
      ...(part.attempt !== undefined ? { attempt: part.attempt } : {}),
      ...(part.maxAttempts !== undefined ? { maxAttempts: part.maxAttempts } : {}),
      ...(part.time?.start !== undefined ? { startedAt: part.time.start } : {}),
      ...(part.time?.end !== undefined ? { endedAt: part.time.end } : {}),
    },
  };
}

function compactPayloadFromLegacyCompactionPart(
  part: Extract<MessagePart, { type: "compaction" }>,
) {
  const status = normalizeCompactTimelineStatus(part.timelineStatus);
  if (!status) return null;
  return {
    status,
    payload: {
      operationId: part.operationId ?? part.boundaryId ?? `legacy-compact-${String(part.id)}`,
      messageId: String(part.messageID),
      partId: part.id,
      status,
      trigger: compactTriggerOfPart(part),
      display: part.timelineDisplay ?? "separator",
      ...(part.phase ? { phase: part.phase } : {}),
      ...(part.compactReason ? { compactReason: part.compactReason } : {}),
      ...(part.reason ? { reason: part.reason } : {}),
      ...(part.boundaryId ? { boundaryId: part.boundaryId } : {}),
      ...(part.summaryMessageId ? { summaryMessageId: part.summaryMessageId } : {}),
      ...(part.tail_start_id ? { tailStartMessageId: part.tail_start_id } : {}),
      ...(part.preCompactTokenCount !== undefined
        ? { preCompactTokenCount: part.preCompactTokenCount }
        : {}),
      ...(part.postCompactTokenCount !== undefined
        ? { postCompactTokenCount: part.postCompactTokenCount }
        : {}),
      ...(part.truePostCompactTokenCount !== undefined
        ? { truePostCompactTokenCount: part.truePostCompactTokenCount }
        : {}),
      ...(part.attempt !== undefined ? { attempt: part.attempt } : {}),
      ...(part.maxAttempts !== undefined ? { maxAttempts: part.maxAttempts } : {}),
      ...(part.time?.start !== undefined ? { startedAt: part.time.start } : {}),
      ...(part.time?.end !== undefined ? { endedAt: part.time.end } : {}),
    },
  };
}

function parseJsonObject(input: string | undefined): Record<string, unknown> | null {
  if (!input) return null;
  try {
    const parsed = JSON.parse(input) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function stringField(
  source: Record<string, unknown> | undefined | null,
  key: string,
): string | undefined {
  const value = source?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function inputIntentOfMessage(message: MessageWithParts): TurnInputIntentMetadata | undefined {
  const persistedHighspeed = highspeedMessageMetaSchema.safeParse(message.info.metadata?.highspeed);
  const fullIntent = conversationInputIntentSchema.safeParse(
    message.info.metadata?.conversationInputIntent,
  );
  if (fullIntent.success) {
    const value = fullIntent.data;
    return {
      sourceCommandId: value.sourceCommandId,
      queueItemId: value.queueItemId,
      clientId: value.clientId,
      kind: value.kind,
      // 可见 text 是展示事实；goal 的 canonical objective 只能读取持久 intent.text，
      // 禁止从 `/goal replace ...` 文案再做大小写/关键字解析。
      text: value.text,
      genUiContext: value.genUiContext,
      ...(value.modelSelection ? { modelSelection: value.modelSelection } : {}),
      ...(value.mode ? { mode: value.mode } : {}),
      ...(value.planEnabled !== undefined ? { planEnabled: value.planEnabled } : {}),
      admissionSeq: value.order.admissionSeq,
      admittedAt: value.admittedAt,
      requestedDelivery: value.delivery.requested,
      admittedDelivery: value.delivery.admitted,
      ...(value.order.queuePosition !== undefined
        ? { queuePosition: value.order.queuePosition }
        : {}),
      ...(value.delivery.fallbackReasonCode
        ? { fallbackReasonCode: value.delivery.fallbackReasonCode }
        : {}),
      ...(value.attachments.length > 0 ? { attachmentRefs: value.attachments } : {}),
      ...(value.highspeed
        ? { highspeed: value.highspeed }
        : persistedHighspeed.success
          ? { highspeed: persistedHighspeed.data }
          : {}),
      ...(value.inputOrigin ? { inputOrigin: value.inputOrigin } : {}),
      ...(value.conversationQuotes ? { conversationQuotes: value.conversationQuotes } : {}),
      ...(value.botGroupSource ? { botGroupSource: value.botGroupSource } : {}),
      ...(value.provenance ? { provenance: value.provenance } : {}),
      ...(value.source ? { source: value.source } : {}),
    };
  }

  // 兼容之前只持久化 metadata seed 的 transcript；新写入一律走上面的完整事实。
  const value = message.info.metadata?.inputIntent;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const intent = value as Record<string, unknown>;
  if (
    typeof intent.sourceCommandId !== "string" ||
    typeof intent.queueItemId !== "string" ||
    typeof intent.clientId !== "string" ||
    (intent.kind !== "sendText" && intent.kind !== "sendGoalCommand") ||
    typeof intent.admissionSeq !== "number" ||
    typeof intent.admittedAt !== "number" ||
    (intent.requestedDelivery !== "auto" &&
      intent.requestedDelivery !== "startNow" &&
      intent.requestedDelivery !== "queue" &&
      intent.requestedDelivery !== "guide") ||
    (intent.admittedDelivery !== "startNow" &&
      intent.admittedDelivery !== "queue" &&
      intent.admittedDelivery !== "guide")
  ) {
    return undefined;
  }
  return {
    ...(value as unknown as TurnInputIntentMetadata),
    ...(persistedHighspeed.success ? { highspeed: persistedHighspeed.data } : {}),
  };
}

function executionKindOfMessage(message: MessageWithParts): "agent" | "controlOnly" | undefined {
  const value = message.info.metadata?.executionKind;
  return value === "agent" || value === "controlOnly" ? value : undefined;
}

/**
 * 引擎附加文本的起点：热路径它在 TurnStarted 上，
 * 冷路径从用户消息 metadata 读回同一个字段。只认非负整数——别的形状按缺席处理（宁可多显示）。
 */
function epilogueStartOfMessage(message: MessageWithParts): number | undefined {
  const value = message.info.metadata?.epilogueStart;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function contentBlocksToText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const chunks = value
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const text = (block as Record<string, unknown>).text;
      return typeof text === "string" ? text : "";
    })
    .filter((text) => text.length > 0);
  return chunks.length > 0 ? chunks.join("\n\n") : undefined;
}

function subagentInfoFromToolPart(
  part: Extract<MessagePart, { type: "tool" }>,
): ParsedSubagentOutput | null {
  if (!SUBAGENT_TOOL_NAMES.has(part.tool)) return null;
  const input =
    part.state.input && typeof part.state.input === "object"
      ? (part.state.input as Record<string, unknown>)
      : {};
  const output = part.state.status === "completed" ? parseJsonObject(part.state.output) : null;
  const metadata = part.metadata && typeof part.metadata === "object" ? part.metadata : {};
  const explicitAgentId =
    stringField(output, "agentId") ??
    stringField(metadata, "agentId") ??
    agentIdFromToolOutput(part.state.status === "completed" ? part.state.output : undefined);
  const agentId = explicitAgentId ?? part.callID;
  return {
    agentId,
    agentType:
      stringField(output, "agentType") ??
      stringField(metadata, "agentType") ??
      // 历史 Agent 输入使用 subagent_type；漏读会让通用回退覆盖 App 中的真实名称。
      stringField(input, "subagent_type") ??
      stringField(input, "agent") ??
      stringField(input, "agentType") ??
      "subagent",
    childSessionId:
      stringField(output, "childSessionId") ??
      stringField(metadata, "childSessionId") ??
      // 后台 Agent 的持久化 tool output 是人类可读文本而非 JSON；cold merge
      // 会抑制重复 durable spawned，若不从稳定 agentId 行恢复 child session，侧栏入口会丢失。
      (explicitAgentId ? createSessionId(`subagent_${agentId}`) : undefined),
    description:
      stringField(output, "description") ??
      stringField(input, "description") ??
      stringField(metadata, "description"),
    parentToolCallId: part.callID,
    prompt: stringField(output, "prompt") ?? stringField(input, "prompt"),
    summaryText:
      contentBlocksToText(output?.content) ??
      stringField(output, "result") ??
      stringField(output, "summary") ??
      stringField(input, "description") ??
      stringField(input, "prompt"),
  };
}

function agentIdFromToolOutput(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return /(?:^|\r?\n)agentId:\s*([^\s(]+)/u.exec(value)?.[1];
}

function subagentStatusFromToolPart(
  part: Extract<MessagePart, { type: "tool" }>,
): "completed" | "failed" | "cancelled" {
  switch (part.state.status) {
    case "completed":
      return "completed";
    case "error":
      return "failed";
    default:
      return "cancelled";
  }
}

/**
 * 附件渲染：FilePart → TurnStarted 附件展示元信息（TurnAttachmentMeta）。
 * 冷订阅/fork-child 的历史附件由 transcript 反向合成——与 live 事件同一投影入口
 * （buildUserInputRow），保证冷/热路径行内容一致。
 */
function attachmentMetasOfMessage(
  parts: readonly MessagePart[],
): Array<{ fileName: string; mime: string; bytes: number; ref?: string }> {
  const fileParts = parts.filter(
    (part): part is Extract<MessagePart, { type: "file" }> => part.type === "file",
  );
  return fileParts.map((part, index) => {
    const urlIsStableRef = part.url.length > 0 && !part.url.startsWith("data:");
    const basenameFromUrl = urlIsStableRef ? (part.url.split(/[\\/]/).pop() ?? "") : "";
    return {
      fileName: part.filename ?? (basenameFromUrl || `attachment-${index + 1}`),
      mime: part.mime,
      bytes: part.metadata?.sizeBytes ?? 0,
      ...(urlIsStableRef ? { ref: part.url } : {}),
    };
  });
}

function forkContextOfMessage(message: MessageWithParts):
  | {
      parentSessionId: string;
      restoredFileCount?: number;
      targetCheckpointId?: string;
      targetMessageId?: string;
    }
  | undefined {
  for (const part of message.parts) {
    if (part.type === "timeline" && part.timelineType === "session_fork") {
      return {
        parentSessionId: String(part.parentSessionId),
        ...(typeof part.restoredFileCount === "number"
          ? { restoredFileCount: part.restoredFileCount }
          : {}),
        ...(part.targetCheckpointId ? { targetCheckpointId: part.targetCheckpointId } : {}),
        ...(part.targetMessageId ? { targetMessageId: String(part.targetMessageId) } : {}),
      };
    }
    const metadata = part.type === "text" ? part.metadata : undefined;
    const context = forkContextFromMetadata(metadata);
    if (context) return context;
  }
  return message.info.role === "user" ? forkContextFromMetadata(message.info.metadata) : undefined;
}

function forkContextFromMetadata(metadata: Record<string, unknown> | undefined):
  | {
      parentSessionId: string;
      restoredFileCount?: number;
      targetCheckpointId?: string;
      targetMessageId?: string;
    }
  | undefined {
  const forkContext = metadata?.forkContext;
  if (typeof forkContext !== "object" || forkContext === null || Array.isArray(forkContext)) {
    return undefined;
  }
  const context = forkContext as Record<string, unknown>;
  if (context.kind !== "session_fork" || typeof context.parentSessionId !== "string") {
    return undefined;
  }
  return {
    parentSessionId: context.parentSessionId,
    ...(typeof context.restoredFileCount === "number"
      ? { restoredFileCount: context.restoredFileCount }
      : {}),
    ...(typeof context.targetCheckpointId === "string"
      ? { targetCheckpointId: context.targetCheckpointId }
      : {}),
    ...(typeof context.targetMessageId === "string"
      ? { targetMessageId: context.targetMessageId }
      : {}),
  };
}

// ── 冷恢复合并的事件词汇表（cold-event-merge 按它决定每类事件的权威来源）──
// 新增 SessionEventType 时在这里归类；未归类的事件仍被兜底保留，但每次冷恢复会记一条
// unclassified 诊断。
export const LIVE_ONLY_EVENT_TYPES = new Set<string>([
  SessionEventType.PluginUiResourceUpdated,
  SessionEventType.PluginUiResourceListChanged,
  SessionEventType.PluginUiAppToolCallRequested,
  SessionEventType.PluginUiInstanceClosed,
]);

export const MEMORY_ONLY_EVENT_TYPES = new Set<string>([
  SessionEventType.SessionResumed,
  SessionEventType.SessionTitleUpdated,
  SessionEventType.SessionModeChanged,
  SessionEventType.PermissionRequested,
  SessionEventType.PermissionResolved,
  SessionEventType.PermissionDenied,
  SessionEventType.UserInputAutoResolutionUpdated,
  SessionEventType.BackgroundTaskStarted,
  SessionEventType.BackgroundTaskUpdated,
  SessionEventType.BackgroundTaskCompleted,
  // workflow run 进度：权威事实在 dwf_event journal 与内存事件里，durable transcript（message/part）
  // 从不合成它，所以它与 BackgroundTask* 同类——memory-only 权威。不分类的后果不是丢事件
  // （兜底分支同样保留），而是每次冷恢复刷一条 unclassified 诊断，把"真的漏了词汇表"这个
  // 信号淹掉。
  SessionEventType.DynamicWorkflowRunProgress,
  SessionEventType.TargetChanged,
  SessionEventType.RewindTriggered,
  SessionEventType.TurnExecutionModelFallback,
]);

export const TRANSCRIPT_DERIVED_EVENT_TYPES = new Set<string>([
  SessionEventType.SessionCreated,
  // 受管 worktree 创建结果：权威事实是 transcript 中的 worktree_creation timeline part。
  SessionEventType.WorktreeCreated,
  SessionEventType.TurnStarted,
  SessionEventType.ModelSelected,
  SessionEventType.ModelStreaming,
  SessionEventType.ModelComplete,
  SessionEventType.ToolCallScheduled,
  SessionEventType.ToolCallStarted,
  SessionEventType.ToolCallResult,
  SessionEventType.ToolCallError,
  SessionEventType.TurnComplete,
  SessionEventType.TurnError,
  SessionEventType.CompactStarted,
  SessionEventType.CompactCompleted,
  SessionEventType.CompactFailed,
  SessionEventType.TargetCompletionVerification,
  SessionEventType.SessionForked,
  SessionEventType.SubagentSpawned,
  SessionEventType.SubagentMessage,
  SessionEventType.SubagentStopped,
]);

export const HOOK_LIFECYCLE_EVENT_TYPES = new Set<string>([
  SessionEventType.HookRunStarted,
  SessionEventType.HookRunProgress,
  SessionEventType.HookRunCompleted,
  SessionEventType.HookRunFailed,
  SessionEventType.HookRunBlocked,
]);

/** 受管 worktree 的创建结果（docs/git/worktree.md §6.6.4）；新建会话首轮前或 fork 分隔标记后。 */
function worktreeCreationOfMessage(
  message: MessageWithParts,
): Extract<MessagePart, { type: "timeline"; timelineType: "worktree_creation" }>["worktreeCreation"] | undefined {
  if (getConversationMessageProjectionPolicy(message) !== "timelineOnly") return undefined;
  for (const part of message.parts) {
    if (part.type === "timeline" && part.timelineType === "worktree_creation") {
      return part.worktreeCreation;
    }
  }
  return undefined;
}

function isForkTimelineMessage(message: MessageWithParts): boolean {
  return (
    getConversationMessageProjectionPolicy(message) === "timelineOnly" &&
    forkContextOfMessage(message) !== undefined
  );
}

function synthesizeTextPart(
  part: Extract<MessagePart, { type: "text" }>,
  assistantMessageId: string,
  assistantMessageCreatedAtMs: number | undefined,
  push: PushEvent,
  turnId: string,
): void {
  if (part.ignored === true || part.text.length === 0) return;
  push(
    SessionEventType.ModelStreaming,
    {
      kind: "text_start",
      delta: "",
      done: false,
      assistantMessageId,
      partId: part.id,
    },
    turnId,
    // cold 合成事件不能统一用“首条消息时间 + seq”：刷新后
    // assistant 动作栏会把不同历史回复显示成接近同一时间。text row 创建时必须
    // 保留所属 transcript assistant message 的真实创建时间；事件顺序仍由 seq 裁决。
    assistantMessageCreatedAtMs,
  );
  push(
    SessionEventType.ModelStreaming,
    {
      kind: "text_delta",
      delta: part.text,
      done: false,
      assistantMessageId,
      partId: part.id,
    },
    turnId,
  );
  push(
    SessionEventType.ModelStreaming,
    { kind: "text_end", delta: "", done: false, partId: part.id },
    turnId,
  );
}

function synthesizeReasoningPart(
  part: Extract<MessagePart, { type: "reasoning" }>,
  assistantMessageId: string,
  push: PushEvent,
  turnId: string,
): void {
  if (part.text.length === 0) return;
  push(
    SessionEventType.ModelStreaming,
    {
      kind: "reasoning_start",
      delta: "",
      done: false,
      assistantMessageId,
      partId: part.id,
    },
    turnId,
  );
  push(
    SessionEventType.ModelStreaming,
    {
      kind: "reasoning_delta",
      delta: part.text,
      done: false,
      partId: part.id,
    },
    turnId,
  );
  push(
    SessionEventType.ModelStreaming,
    { kind: "reasoning_end", delta: "", done: false, partId: part.id },
    turnId,
  );
}

function synthesizeSubagentLifecycle(
  info: ParsedSubagentOutput,
  status: "completed" | "failed" | "cancelled",
  push: PushEvent,
  turnId: string,
): void {
  const agentId = info.agentId ?? `subagent-${turnId}`;
  push(
    SessionEventType.SubagentSpawned,
    {
      agentId,
      agentType: info.agentType ?? "subagent",
      childSessionId: info.childSessionId,
      description: info.description ?? info.summaryText ?? info.prompt ?? agentId,
      parentToolCallId: info.parentToolCallId,
      prompt: info.prompt,
      status: "running",
    },
    turnId,
  );
  push(
    SessionEventType.SubagentStopped,
    {
      agentId,
      agentType: info.agentType ?? "subagent",
      childSessionId: info.childSessionId,
      description: info.description,
      parentToolCallId: info.parentToolCallId,
      prompt: info.prompt,
      summaryText: info.summaryText,
      status,
    },
    turnId,
  );
}

function synthesizeToolPart(
  part: Extract<MessagePart, { type: "tool" }>,
  assistantMessageId: string,
  push: PushEvent,
  turnId: string,
): AssistantSynthesisState {
  if (shouldHideInvalidToolCallFromProduct(part.tool, part.metadata)) {
    // footprint 过滤只决定是否需要补事件，不能阻止实际合成；这里必须在事件源头
    // 跳过带原始空名 metadata 的恢复 part，避免 cold hydration 重新物化工具行。
    return { resultType: "success", toolCallCount: 0 };
  }
  const toolCallId = part.callID;
  const persistedMetadata = parseCompletedToolPartMetadata(
    "metadata" in part.state ? part.state.metadata : part.metadata,
  );
  push(
    SessionEventType.ToolCallScheduled,
    {
      toolCallId,
      assistantMessageId,
      toolName: part.tool,
      input: part.state.input,
      ...(persistedMetadata?.display ? { display: persistedMetadata.display } : {}),
      schedule: stableToolSchedule(toolCallId),
    },
    turnId,
  );

  const started =
    part.state.status === "running" ||
    part.state.status === "completed" ||
    part.state.status === "error";
  if (started) {
    push(
      SessionEventType.ToolCallStarted,
      {
        toolCallId,
        toolName: part.tool,
        ...(persistedMetadata?.display ? { display: persistedMetadata.display } : {}),
        startedAt: new Date(
          "time" in part.state && typeof part.state.time.start === "number"
            ? part.state.time.start
            : 0,
        ),
      },
      turnId,
    );
  }

  // （2026-09-12）：历史 transcript 里残留的 metadata.widgetState 不再合成事件，
  // 冷恢复直接忽略（widgetState 只留 renderer 内存）。

  const subagentInfo = subagentInfoFromToolPart(part);
  if (subagentInfo && started) {
    synthesizeSubagentLifecycle(subagentInfo, subagentStatusFromToolPart(part), push, turnId);
  }

  if (part.state.status === "completed") {
    push(
      SessionEventType.ToolCallResult,
      {
        toolCallId,
        duration: Math.max(0, part.state.time.end - part.state.time.start),
        result: {
          success: true,
          content: part.state.output,
          ...(persistedMetadata?.display ? { display: persistedMetadata.display } : {}),
        },
      },
      turnId,
    );
    return { resultType: "success", toolCallCount: 1 };
  }

  if (part.state.status === "error") {
    push(
      SessionEventType.ToolCallResult,
      {
        toolCallId,
        duration: Math.max(0, part.state.time.end - part.state.time.start),
        result: {
          success: false,
          content: part.state.error,
          error: {
            type: "fault.runtime.toolFailed",
            message: part.state.error,
          },
        },
      },
      turnId,
    );
    return { resultType: "success", toolCallCount: 1 };
  }

  // CLI 重启后无法证明历史 pending/running 工具仍在运行，不能把
  // active work / stop 按钮复活；让 TurnComplete(cancelled) 统一收口成只读历史。
  return { resultType: "cancelled", toolCallCount: 1 };
}

function synthesizeCompactPart(
  part: MessagePart,
  emittedCompactOperations: Set<string>,
  durableCompactPartsByOperation: ReadonlyMap<string, Extract<MessagePart, { type: "compaction" }>>,
  push: PushEvent,
  turnId: string,
): boolean {
  let compact =
    part.type === "timeline"
      ? compactPayloadFromTimelinePart(part)
      : part.type === "compaction"
        ? compactPayloadFromLegacyCompactionPart(part)
        : null;
  if (!compact) return false;
  const operationId = String(compact.payload.operationId);
  const durablePart = durableCompactPartsByOperation.get(operationId);
  if (durablePart) {
    // 同 operation 的 timeline part 通常排在 durable compaction part 前面。
    // 旧“先到先得”会丢 tail_start_id；优先采用带 coverage boundary 的 durable payload。
    const durablePayload = compactPayloadFromLegacyCompactionPart(durablePart);
    compact = durablePayload ?? {
      ...compact,
      payload: {
        ...compact.payload,
        ...(durablePart.tail_start_id ? { tailStartMessageId: durablePart.tail_start_id } : {}),
        ...(durablePart.boundaryId ? { boundaryId: durablePart.boundaryId } : {}),
        ...(durablePart.summaryMessageId ? { summaryMessageId: durablePart.summaryMessageId } : {}),
      },
    };
  }
  if (emittedCompactOperations.has(operationId)) return true;
  emittedCompactOperations.add(operationId);
  push(compactEventType(compact.status), compact.payload, turnId);
  return true;
}

// ── goal verification timeline part──
// 持久化契约（core events.ts persistDurableSessionEvent）：verifier 每次生命周期变化
// upsert 同一个 timeline part，身份 targetId_goalIteration，status 为最终生命周期态。
// 反向合成为 started(+终态) 事件对，复用投影既有 goalVerify marker 状态机。
// 旧 hydration 只认 context_compaction，goal_verification part 落入无人
// 消费的分支——每次冷恢复 goalVerify marker 都消失。
function goalVerificationKeyOfPart(part: Extract<MessagePart, { type: "timeline" }>): string {
  if (part.timelineType !== "goal_verification") return String(part.id);
  return part.goalIteration !== undefined
    ? `${part.targetId}_${part.goalIteration}`
    : part.verificationId;
}

// 冷恢复无法证明历史 verifier 仍在运行（同 pending tool 收口为 cancelled 的先例）：
// started/未知态收口为 cancelled；completed/failed_closed 原样还原。
function goalVerificationTerminalStatus(
  status: string | undefined,
): "completed" | "failed_closed" | "cancelled" {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
    case "failed_closed":
      return "failed_closed";
    default:
      return "cancelled";
  }
}

/** goal verify 事实的归一形态：timeline part（新契约）与 session_entry（legacy 主体）共用。 */
interface GoalVerificationFact {
  key: string;
  targetId: string;
  verificationId: string;
  goalIteration?: number;
  anchorAssistantMessageId?: string;
  anchorTurnId?: string;
  status?: string;
  verification?: unknown;
}

function pushGoalVerificationFact(
  fact: GoalVerificationFact,
  emittedGoalVerifications: Set<string>,
  push: PushEvent,
  turnId: string | undefined,
): boolean {
  if (emittedGoalVerifications.has(fact.key)) return false;
  emittedGoalVerifications.add(fact.key);
  const base = {
    targetId: fact.targetId,
    verificationId: fact.verificationId,
    ...(fact.goalIteration !== undefined ? { goalIteration: fact.goalIteration } : {}),
    ...(fact.anchorAssistantMessageId
      ? { anchorAssistantMessageId: fact.anchorAssistantMessageId }
      : {}),
    ...(fact.anchorTurnId ? { anchorTurnId: fact.anchorTurnId } : {}),
  };
  push(SessionEventType.TargetCompletionVerification, { ...base, status: "started" }, turnId);
  push(
    SessionEventType.TargetCompletionVerification,
    {
      ...base,
      status: goalVerificationTerminalStatus(fact.status),
      ...(fact.verification ? { verification: fact.verification } : {}),
    },
    turnId,
  );
  return true;
}

function goalVerificationFactOfPart(
  part: Extract<MessagePart, { type: "timeline" }>,
): GoalVerificationFact | null {
  if (part.timelineType !== "goal_verification") return null;
  return {
    key: goalVerificationKeyOfPart(part),
    targetId: part.targetId,
    verificationId: part.verificationId,
    ...(part.goalIteration !== undefined ? { goalIteration: part.goalIteration } : {}),
    ...(part.anchorMessageId ? { anchorAssistantMessageId: String(part.anchorMessageId) } : {}),
    ...(part.anchorTurnId ? { anchorTurnId: String(part.anchorTurnId) } : {}),
    ...(part.status ? { status: part.status } : {}),
    ...(part.verification ? { verification: part.verification } : {}),
  };
}

function synthesizeGoalVerificationPart(
  part: MessagePart,
  emittedGoalVerifications: Set<string>,
  push: PushEvent,
  turnId: string,
): boolean {
  if (part.type !== "timeline") return false;
  const fact = goalVerificationFactOfPart(part);
  if (!fact) return false;
  pushGoalVerificationFact(fact, emittedGoalVerifications, push, turnId);
  return true;
}

// ── session_entry legacy 源──
// 历史上 goal verify 主要持久化在 session_entry（本机观测 1,402 行 vs timeline part
// 仅 10 行）；entry.data 保留了原始事件 payload。读取端跨源按 targetId_goalIteration
// 去重：timeline part 与 entry 表达同一事实时只发一次（先到先得，anchor 语义一致）。
export interface HydratedGoalVerificationEntry {
  payload: {
    targetId: string;
    status?: string;
    verificationId: string;
    verification?: unknown;
    goalIteration?: number;
    anchorAssistantMessageId?: string;
    anchorTurnId?: string;
  };
  sequenceNumber?: number;
  timeCreated: number;
}

/** SessionEntryInfo（target_completion_verification）→ 归一 entry；非法数据静默剔除。 */
export function goalVerificationEntriesFromSessionEntries(
  entries: readonly { data: unknown; time: { created: number } }[],
): HydratedGoalVerificationEntry[] {
  const parsed: HydratedGoalVerificationEntry[] = [];
  for (const entry of entries) {
    const data =
      entry.data && typeof entry.data === "object" && !Array.isArray(entry.data)
        ? (entry.data as Record<string, unknown>)
        : null;
    const payload =
      data?.payload && typeof data.payload === "object" && !Array.isArray(data.payload)
        ? (data.payload as Record<string, unknown>)
        : null;
    if (!payload) continue;
    const targetId = typeof payload.targetId === "string" ? payload.targetId : null;
    const verificationId =
      typeof payload.verificationId === "string" ? payload.verificationId : null;
    if (!targetId || !verificationId) continue;
    parsed.push({
      payload: {
        targetId,
        verificationId,
        ...(typeof payload.status === "string" ? { status: payload.status } : {}),
        ...(typeof payload.goalIteration === "number"
          ? { goalIteration: payload.goalIteration }
          : {}),
        ...(typeof payload.anchorAssistantMessageId === "string"
          ? { anchorAssistantMessageId: payload.anchorAssistantMessageId }
          : {}),
        ...(typeof payload.anchorTurnId === "string" ? { anchorTurnId: payload.anchorTurnId } : {}),
        ...(payload.verification !== undefined ? { verification: payload.verification } : {}),
      },
      ...(typeof data?.sequenceNumber === "number" ? { sequenceNumber: data.sequenceNumber } : {}),
      timeCreated: entry.time.created,
    });
  }
  // 同一 key 多条（started/terminal 各一条 entry）：按事件序取最新终态。
  parsed.sort(
    (left, right) =>
      (left.sequenceNumber ?? left.timeCreated) - (right.sequenceNumber ?? right.timeCreated),
  );
  return parsed;
}

function goalVerificationFactOfEntry(entry: HydratedGoalVerificationEntry): GoalVerificationFact {
  const payload = entry.payload;
  return {
    key:
      payload.goalIteration !== undefined
        ? `${payload.targetId}_${payload.goalIteration}`
        : payload.verificationId,
    targetId: payload.targetId,
    verificationId: payload.verificationId,
    ...(payload.goalIteration !== undefined ? { goalIteration: payload.goalIteration } : {}),
    ...(payload.anchorAssistantMessageId
      ? { anchorAssistantMessageId: payload.anchorAssistantMessageId }
      : {}),
    ...(payload.anchorTurnId ? { anchorTurnId: payload.anchorTurnId } : {}),
    ...(payload.status ? { status: payload.status } : {}),
    ...(payload.verification !== undefined ? { verification: payload.verification } : {}),
  };
}

/** 同一 key 的多条 entry（生命周期各一条）合并为单个 fact：终态覆盖 started。 */
function mergeGoalVerificationEntryFacts(
  entries: readonly HydratedGoalVerificationEntry[],
): GoalVerificationFact[] {
  const byKey = new Map<string, GoalVerificationFact>();
  for (const entry of entries) {
    const fact = goalVerificationFactOfEntry(entry);
    const existing = byKey.get(fact.key);
    if (!existing) {
      byKey.set(fact.key, fact);
      continue;
    }
    // entries 已按事件序排序：后到的生命周期态（终态）覆盖，anchor 取先有值。
    byKey.set(fact.key, {
      ...existing,
      ...fact,
      anchorAssistantMessageId: existing.anchorAssistantMessageId ?? fact.anchorAssistantMessageId,
      anchorTurnId: existing.anchorTurnId ?? fact.anchorTurnId,
      verification: fact.verification ?? existing.verification,
    });
  }
  return [...byKey.values()];
}

// ── 轮次选型事实──
// modelChange marker 由投影在 TurnStarted 时对比 lastTurnModel 与 config 生成；
// 冷恢复没有 ModelSelected 事件，这里按每轮的持久化选型事实重建。
// 来源优先级：user prompt 的 model 快照（恒在场、与提交时 config 一致）；
// preface 轮（无 user）取 assistant 消息事实。合成 timeline 宿主消息
// （semantics.kind=timeline_event）的 model 是宿主兼容占位，不是本轮事实。
interface HydratedTimelineModel {
  modelSelection: ModelSelection;
  previousModelSelection?: ModelSelection | null;
}

function hydratedModelKey(modelSelection: ModelSelection): string {
  return `${modelSelection.providerId}\u0000${modelSelection.modelId}\u0000${modelSelection.options?.reasoningLevel ?? ""}`;
}

function sessionModelSelectionOfHydratedMessage(
  modelSelection: ModelSelection,
): ModelSelection | null {
  // Bug 原因：加速卡是单轮执行 Selection（selectionScope=execution），消息保留它用于记录
  // 真实执行模型；但冷恢复曾把该字段误当成会话选型，重启后因此生成「加速 → 原模型」的
  // 虚假切换提示。live 路径的 execution 作用域本就不发 ModelSelected，cold 必须同语义。
  return isHighspeedProviderId(modelSelection.providerId) ? null : modelSelection;
}

function turnModelSelectionOfUserMessage(message: MessageWithParts): ModelSelection | null {
  if (message.info.role !== "user") return null;
  const modelSelection = message.info.modelSelection;
  return modelSelection ? sessionModelSelectionOfHydratedMessage(modelSelection) : null;
}

function assistantModelSelectionOf(message: MessageWithParts): ModelSelection | null {
  if (message.info.role !== "assistant") return null;
  if (message.info.semantics?.kind === "timeline_event") return null;
  if (!message.info.providerId || !message.info.modelId) return null;
  return sessionModelSelectionOfHydratedMessage({
    providerId: String(message.info.providerId),
    modelId: String(message.info.modelId),
    ...(message.info.reasoningLevel
      ? { options: { reasoningLevel: message.info.reasoningLevel } }
      : {}),
  });
}

function modelChangeToModelOf(message: MessageWithParts): HydratedTimelineModel | null {
  for (let index = message.parts.length - 1; index >= 0; index -= 1) {
    const part = message.parts[index]!;
    if (part.type !== "timeline" || part.timelineType !== "model_change") continue;
    if (!part.toModel) return null;
    return {
      modelSelection: {
        providerId: part.toModel.providerId,
        modelId: part.toModel.modelId,
        ...(part.toModel.options ? { options: part.toModel.options } : {}),
      },
      previousModelSelection: part.fromModel
        ? {
            providerId: part.fromModel.providerId,
            modelId: part.fromModel.modelId,
            ...(part.fromModel.options ? { options: part.fromModel.options } : {}),
          }
        : null,
    };
  }
  return null;
}

function modelChangeKeyOfPart(
  part: Extract<MessagePart, { type: "timeline" }> & { timelineType: "model_change" },
): string {
  const from = part.fromModel
    ? `${part.fromModel.providerId}/${part.fromModel.modelId}/${part.fromModel.options?.reasoningLevel ?? ""}`
    : "<unknown>";
  const to = part.toModel
    ? `${part.toModel.providerId}/${part.toModel.modelId}/${part.toModel.options?.reasoningLevel ?? ""}`
    : "<unknown>";
  return `${String(part.anchorMessageId ?? part.messageID)}\u0000${from}\u0000${to}`;
}

// preface 轮开轮门槛：只含 model_change/session_fork 宿主等不可渲染内容的 assistant
// 消息不开轮，避免合成出只有「已工作」壳的空轮。
function assistantMessageHasSynthesizableContent(message: MessageWithParts): boolean {
  return message.parts.some((part) => {
    switch (part.type) {
      case "text":
        return part.ignored !== true && part.text.length > 0;
      case "reasoning":
        return part.text.length > 0;
      case "tool":
        return !shouldHideInvalidToolCallFromProduct(part.tool, part.metadata);
      case "subtask":
      case "compaction":
        return true;
      case "timeline":
        return (
          part.timelineType === "context_compaction" || part.timelineType === "goal_verification"
        );
      default:
        return false;
    }
  });
}

function synthesizeSubtaskPart(
  part: Extract<MessagePart, { type: "subtask" }>,
  push: PushEvent,
  turnId: string,
): void {
  synthesizeSubagentLifecycle(
    {
      agentId: String(part.id),
      agentType: part.agent,
      description: part.description,
      prompt: part.prompt,
      summaryText: part.description,
    },
    "completed",
    push,
    turnId,
  );
}

function synthesizeAssistantParts(
  message: MessageWithParts,
  emittedCompactOperations: Set<string>,
  durableCompactPartsByOperation: ReadonlyMap<string, Extract<MessagePart, { type: "compaction" }>>,
  emittedGoalVerifications: Set<string>,
  push: PushEvent,
  turnId: string,
): AssistantSynthesisState {
  let resultType: TurnResultForHydration =
    message.info.role === "assistant" && message.info.error
      ? isPersistedAssistantCancellation(message.info.error)
        ? "cancelled"
        : isPersistedStreamRecoveryDiscard(message.info.error)
          ? "success"
          : "error_during_execution"
      : message.info.role === "assistant" && message.info.time.completed === undefined
        ? // Bug 根因：进程退出可能只持久化 step-start/partial，却没有 assistant error；
          // 旧 cold hydration 默认 success，伪造正常 TurnComplete 并让异常 Worked 被收起。
          "cancelled"
        : "success";
  let toolCallCount = 0;
  for (const part of message.parts) {
    switch (part.type) {
      case "text":
        synthesizeTextPart(
          part,
          String(message.info.id),
          messageCreatedAtMs(message),
          push,
          turnId,
        );
        break;
      case "reasoning":
        // cold hydration 过去没有把 transcript assistant message 身份带到
        // reasoning_start，导致恢复后的 ReasoningRow 无法复用 live projection 的 response 边界。
        synthesizeReasoningPart(part, String(message.info.id), push, turnId);
        break;
      case "tool": {
        const state = synthesizeToolPart(part, String(message.info.id), push, turnId);
        toolCallCount += state.toolCallCount;
        resultType = normalizeTurnResult(resultType, state.resultType);
        break;
      }
      case "timeline":
        if (synthesizeGoalVerificationPart(part, emittedGoalVerifications, push, turnId)) {
          break;
        }
        synthesizeCompactPart(
          part,
          emittedCompactOperations,
          durableCompactPartsByOperation,
          push,
          turnId,
        );
        break;
      case "compaction":
        synthesizeCompactPart(
          part,
          emittedCompactOperations,
          durableCompactPartsByOperation,
          push,
          turnId,
        );
        break;
      case "subtask":
        synthesizeSubtaskPart(part, push, turnId);
        break;
      default:
        break;
    }
  }
  const assistantFeedback = message.info.metadata?.assistantFeedback;
  if (assistantFeedback === "like" || assistantFeedback === "dislike") {
    push(
      SessionEventType.AssistantFeedbackUpdated,
      { entityId: String(message.info.id), feedback: assistantFeedback },
      turnId,
    );
  }
  return { resultType, toolCallCount };
}

// ── model-only 唤醒轮──
// live 路径的 background wake / goal continuation 以 TurnStarted(inputVisibility=
// model-only) 开独立轮；冷路径不能把这类 synthetic user 跳过、让其后的 assistant 并进
// 上一轮——live/cold 必须结构一致。触发 source 由 shared projection policy
// 唯一维护；compact summary / rewind notice 等非触发型 synthetic context 照旧不开轮。

// ── guide steer 内联──
// drain 持久化的 user message 带 metadata.turnSteerDelivery：guide=内联当前轮
// （不是轮边界），queue=独立轮（真实 starter，与 live 切分一致）。legacy 无标记按 queue。
function steerDeliveryOfMessage(message: MessageWithParts): "guide" | "queue" | null {
  if (message.info.role !== "user") return null;
  const metadata = (message.info as { metadata?: unknown }).metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const delivery = (metadata as Record<string, unknown>).turnSteerDelivery;
  return delivery === "guide" || delivery === "queue" ? delivery : null;
}

/**
 * 轮边界判定：真实 user starter（guide steer 除外——内联当前轮）或 model-only
 * 唤醒触发（background wake / goal continuation 各开一轮）。
 * 注：live 的「合流」场景（active loop 未结束时通知并入当前轮）冷路径无法从持久
 * 事实区分，统一按边界处理——内容不丢、无气泡，仅轮归属与 live 合流场景有已知差异。
 */
function isTurnBoundaryStarter(message: MessageWithParts): boolean {
  if (isRealUserTurnStarter(message)) {
    return steerDeliveryOfMessage(message) !== "guide";
  }
  // 启动轮是可见 controlOnly 用户轮，必须作为边界让前一轮输出收集在此停下（一会话一 run 下
  // 它本就是首条消息，但语义上仍是独立轮边界，不能被并进上一轮）。
  if (workflowLaunchOfMessage(message)) return true;
  return getConversationModelOnlyTurnTriggerSource(message) !== null;
}

function backgroundResultOriginMetaOfMessage(
  message: MessageWithParts,
): BackgroundResultOriginMeta | undefined {
  const messageMetadata = message.info.metadata;
  const partMetadata = message.parts.find((part) => part.type === "text")?.metadata;
  const candidate = messageMetadata?.originMeta ?? partMetadata?.originMeta;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
  const record = candidate as Record<string, unknown>;
  const backgroundSource = record.backgroundSource;
  const workId = typeof record.workId === "string" ? record.workId.trim() : "";
  const title = typeof record.title === "string" ? record.title.trim() : "";
  // 三个取值与 BackgroundResultOriginMeta 保持同步（contracts/src/events/session.events.ts）。
  // "workflow" 是 workflow run（workId ≡ runId）：漏掉它，workflow 的后台结果轮在冷恢复后会
  // 静默退化成一条无标题 model-only 消息，工具卡→详情页的关联键随之丢失。
  if (
    (backgroundSource !== "bash" &&
      backgroundSource !== "subagent" &&
      backgroundSource !== "workflow") ||
    !workId ||
    !title
  ) {
    return undefined;
  }
  // manifest 载荷（workflowNotification）也要过冷恢复：这里若只回读三基字段，冷恢复后
  // 载荷就丢了——manifest 条目退回裸标题行。用 shared 的 zod schema 校验，畸形就**只丢载荷**
  // 保基字段，绝不抛：这是投影重建路径，一个坏载荷不该打挂整条冷恢复。
  const workflowNotification = parseWorkflowNotificationMeta(record.workflowNotification);
  // 空闲提醒的载荷在它自己的键上（contracts 的 WorkflowBlockedMeta），同样畸形只丢载荷。
  const workflowBlocked = workflowBlockedMetaSchema.safeParse(record.workflowBlocked);
  // 后台 Agent 的结构化终态也要过冷恢复，否则恢复后失败详情退回整句 summary。
  const subagentResult = subagentResultMetaSchema.safeParse(record.subagentResult);
  return {
    backgroundSource,
    title,
    workId,
    ...(workflowNotification ? { workflowNotification } : {}),
    ...(workflowBlocked.success ? { workflowBlocked: workflowBlocked.data } : {}),
    ...(subagentResult.success ? { subagentResult: subagentResult.data } : {}),
  };
}

/** 防御性解析 manifest 载荷：畸形 / 缺席都回 undefined（调用方据此让字段缺席），绝不抛。 */
function parseWorkflowNotificationMeta(
  value: unknown,
): BackgroundResultOriginMeta["workflowNotification"] {
  if (value === undefined || value === null) return undefined;
  const parsed = workflowNotificationMetaSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function isLegacyCompactMaintenanceInput(
  message: MessageWithParts,
  nextMessage: MessageWithParts | undefined,
): boolean {
  if (message.info.role !== "user") return false;
  // 只修复缺 canonical policy 的旧数据；显式 user-visible `/compact` 必须原样下发，
  // UI 不得再靠文本覆盖 CLI visibility authority。
  if (message.info.visibility !== undefined || message.info.semantics !== undefined) return false;
  const text = textOfMessage(message.parts).trim();
  if (text !== "/compact" && !text.startsWith("/compact ")) return false;
  if (!nextMessage || nextMessage.info.role !== "assistant") return false;
  return nextMessage.parts.some(
    (part) =>
      part.type === "compaction" ||
      (part.type === "timeline" && part.timelineType === "context_compaction"),
  );
}

interface TurnOutputCollection {
  failure?: {
    type: string;
    message: string;
    attribution?: ErrorAttribution;
    retryable?: boolean;
    data?: unknown;
  };
  nextIndex: number;
  resultType: TurnResultForHydration;
  toolCallCount: number;
  historyRoundCount: number;
  turnEndedAtMs: number;
}

/** 收集一轮的 assistant 输出（直到下一个轮边界）；普通轮与 preface 轮共用。 */
function collectTurnOutput(options: {
  messages: readonly MessageWithParts[];
  startIndex: number;
  turnId: string;
  turnStartedAtMs: number;
  emittedCompactOperations: Set<string>;
  durableCompactPartsByOperation: ReadonlyMap<string, Extract<MessagePart, { type: "compaction" }>>;
  emittedGoalVerifications: Set<string>;
  goalVerificationsByAnchor: ReadonlyMap<string, GoalVerificationFact[]>;
  onModelChange: (selection: HydratedTimelineModel) => void;
  push: PushEvent;
}): TurnOutputCollection {
  const { messages, turnId, push } = options;
  let index = options.startIndex;
  let resultType: TurnResultForHydration = "success";
  let failure: TurnOutputCollection["failure"];
  // 被 stream recovery 作废的 tail 若是本轮最后一条 assistant，说明恢复请求没有落盘
  //（进程在重发前退出），本轮按 interrupted 收口；后续 assistant 出现则由它决定结果。
  let awaitingStreamRecovery = false;
  let toolCallCount = 0;
  let historyRoundCount = 0;
  let turnEndedAtMs = options.turnStartedAtMs;
  while (index < messages.length && !isTurnBoundaryStarter(messages[index]!)) {
    const message = messages[index]!;
    if (isProviderContextOnlyAssistant(message)) {
      // selection side chat 会把继承的 assistant 历史标成 model-only，
      // 旧 cold hydration 却只隐藏 user carrier，随后把 assistant 当作 preface/上一轮输出合成，
      // 导致副屏首次打开和冷恢复都泄漏父时间线。统一服从 projection policy，整条跳过。
      index += 1;
      continue;
    }
    if (isForkTimelineMessage(message)) {
      const forkContext = forkContextOfMessage(message);
      if (forkContext) {
        push(
          SessionEventType.SessionForked,
          {
            forkPoint: 0,
            originalSessionId: forkContext.parentSessionId,
            restoredFileCount: forkContext.restoredFileCount,
            targetCheckpointId: forkContext.targetCheckpointId,
            targetMessageId: forkContext.targetMessageId,
          },
          turnId,
        );
      }
      const worktreeCreation = worktreeCreationOfMessage(message);
      if (worktreeCreation) push(SessionEventType.WorktreeCreated, { ...worktreeCreation }, turnId);
      index += 1;
      continue;
    }
    const innerWorktreeCreation = worktreeCreationOfMessage(message);
    if (innerWorktreeCreation) {
      push(SessionEventType.WorktreeCreated, { ...innerWorktreeCreation }, turnId);
      index += 1;
      continue;
    }
    // guide steer：内联进当前轮——合成 TurnSteerDrained（带 drainedInputs），
    // 投影按 delivery=guide 走内联 userInput 行，与 live 同一归约入口。
    if (message.info.role === "user" && steerDeliveryOfMessage(message) === "guide") {
      const intent = inputIntentOfMessage(message);
      // cold guide 过去只凭 messageId 临时拼 pendingInputId，且没有把
      // transcript 中已持久化的 ConversationInputIntent 带回事件；恢复后 row 会丢
      // sourceCommandId/clientId/attachments，命令去重与展示也不再和 live 等价。
      // 新数据优先复用原 queueItemId，legacy 才使用可诊断的 hydration fallback。
      const pendingInputId = intent?.queueItemId ?? `hydrate-steer-${String(message.info.id)}`;
      push(
        SessionEventType.TurnSteerDrained,
        {
          pendingInputIds: [pendingInputId],
          injectedMessageIds: [String(message.info.id)],
          drainedInputs: [
            {
              pendingInputId,
              messageId: String(message.info.id),
              text: textOfMessage(message.parts),
              delivery: "guide",
              ...(intent ? { intent } : {}),
            },
          ],
          targetTurnId: turnId,
        },
        turnId,
        messageCreatedAtMs(message),
      );
      index += 1;
      continue;
    }
    if (message.info.role !== "assistant") {
      // 修复原因：最终文本已完整输出后再停止时，assistant 是 finish=stop、没有 error，
      // live 记为 cancelled，冷恢复却按 success 收口。中断标记是停止的持久化事实，以它为准；
      // 已有持久化错误时 finishTurn 仍优先显示错误（宿主故障也写标记）。
      if (isInterruptMarkerMessage(message)) {
        resultType = normalizeTurnResult(resultType, "cancelled");
      }
      index += 1;
      continue;
    }
    awaitingStreamRecovery =
      message.info.error !== undefined && isPersistedStreamRecoveryDiscard(message.info.error);
    if (
      message.info.error &&
      !isPersistedAssistantCancellation(message.info.error) &&
      !awaitingStreamRecovery
    ) {
      const data = assistantErrorData(message.info.error);
      const attribution = persistedErrorAttribution(data);
      failure = {
        type: message.info.error.name,
        message: (typeof data?.message === "string" && data.message) || message.info.error.name,
        // 旧 cold hydration 只把归因留在 data 内，TurnError 投影无法读取，重启后退化成 runtime。
        ...(attribution ? { attribution } : {}),
        ...(typeof data?.retryable === "boolean" ? { retryable: data.retryable } : {}),
        ...(message.info.error.data !== undefined ? { data: message.info.error.data } : {}),
      };
    }
    const timelineModel = modelChangeToModelOf(message);
    if (timelineModel) {
      options.onModelChange(timelineModel);
      index += 1;
      continue;
    }
    // Host 不能从 toolCallCount 或裁剪后的 history 长度反推模型轮次。
    // 新 transcript 在最终 assistant anchor 固化精确值；旧 transcript 才按独立
    // assistant history 条目做兼容计数。
    historyRoundCount = message.info.anchor?.historyRoundCount ?? historyRoundCount + 1;
    const messageEnd = messageEndAtMs(message);
    if (messageEnd !== undefined) {
      turnEndedAtMs = Math.max(turnEndedAtMs, messageEnd);
    }
    // live 每次模型请求都有 start 流事件；cold 为每条 assistant 消息合成同一个事件。
    // 修复原因：没有可见内容的 assistant 不产生任何事件，投影看不到两次 guide 取出之间的
    // 模型 step，会把后一次取出的 guide 并进前一段工作段。
    push(
      SessionEventType.ModelStreaming,
      { kind: "start", delta: "", done: false, assistantMessageId: String(message.info.id) },
      turnId,
    );
    const synthesized = synthesizeAssistantParts(
      message,
      options.emittedCompactOperations,
      options.durableCompactPartsByOperation,
      options.emittedGoalVerifications,
      push,
      turnId,
    );
    resultType = normalizeTurnResult(resultType, synthesized.resultType);
    toolCallCount += synthesized.toolCallCount;
    if (
      message.info.role === "assistant" &&
      message.info.finish?.trim().toLowerCase() === "length" &&
      synthesized.toolCallCount === 0
    ) {
      // live ProductProjection 能从逐请求 ModelComplete 识别 output-token
      // Continue，但 cold transcript 过去只在整轮末尾合成一次 end_turn，导致刷新后
      // 同一句又退化成多条 assistant row。持久化 finish 是请求终止事实；用零 usage
      // 的 hydration-only ModelComplete 恢复资格，不重复累计 token 或注入 Continue user。
      push(
        SessionEventType.ModelComplete,
        {
          content: "",
          stopReason: "length",
          querySource: "main_turn",
          toolCallCount: 0,
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        },
        turnId,
        messageEnd,
      );
    }
    // session_entry 源的 goal verify：锚定本条 assistant 的事实紧随其后落位
    //（与 timeline part 同 key 去重，先到先得）。
    const anchored = options.goalVerificationsByAnchor.get(String(message.info.id));
    if (anchored) {
      for (const fact of anchored) {
        pushGoalVerificationFact(fact, options.emittedGoalVerifications, push, turnId);
      }
    }
    index += 1;
  }
  if (awaitingStreamRecovery) {
    resultType = normalizeTurnResult(resultType, "cancelled");
  }
  return {
    ...(failure ? { failure } : {}),
    nextIndex: index,
    resultType,
    toolCallCount,
    historyRoundCount,
    turnEndedAtMs,
  };
}

/**
 * 把 transcript（按时间/parentID 顺序的 MessageWithParts）合成为归约等价的 SessionEvent 序列。
 * 轮次分组：user message 开一轮，紧随其后的 assistant message（同轮输出）直到下一个 user message。
 */
export function synthesizeEventsFromMessages(
  messages: readonly MessageWithParts[],
  options: SynthesizeOptions,
): SessionEvent[] {
  const sessionId = options.sessionId as SessionId;
  const traceId = HYDRATION_TRACE_ID as TraceId;
  let seq = 0;
  const baseMs = options.baseTimestampMs ?? messages[0]?.info.time.created ?? 0;
  const events: SessionEvent[] = [];

  const push = (
    type: SessionEventType,
    payload: unknown,
    turnId?: string,
    sourceTimestampMs?: number,
  ): void => {
    seq += 1;
    events.push({
      id: `hydrate-${seq}` as EventId,
      sessionId,
      turnId: turnId as TurnId | undefined,
      type,
      // source timestamp 仅恢复 row.createdAt 等展示事实；事件全序始终由 sequenceNumber 裁决。
      timestamp: new Date(sourceTimestampMs ?? baseMs + seq),
      traceId,
      sequenceNumber: seq,
      payload,
    });
  };

  // 历史消息不声明模型容量；调用方未知时保持未知，不能合成默认分母。
  const contextWindow = options.contextWindow;
  push(SessionEventType.SessionCreated, {
    mode: "default",
    contextWindow,
  });

  let turnNumber = 0;
  let index = 0;
  const emittedCompactOperations = new Set<string>();
  const durableCompactPartsByOperation = new Map<
    string,
    Extract<MessagePart, { type: "compaction" }>
  >();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "compaction") continue;
      if (!part.timelineStatus && !part.tail_start_id && !part.compactBoundary) continue;
      const operationId = String(
        part.operationId ?? part.boundaryId ?? `legacy-compact-${String(part.id)}`,
      );
      const existing = durableCompactPartsByOperation.get(operationId);
      if (!existing || (!existing.tail_start_id && part.tail_start_id)) {
        durableCompactPartsByOperation.set(operationId, part);
      }
    }
  }
  const emittedGoalVerifications = new Set<string>();
  let lastTurnId: string | undefined;

  const entryFacts = mergeGoalVerificationEntryFacts(options.goalVerificationEntries ?? []);
  const goalVerificationsByAnchor = new Map<string, GoalVerificationFact[]>();
  for (const fact of entryFacts) {
    if (!fact.anchorAssistantMessageId) continue;
    const list = goalVerificationsByAnchor.get(fact.anchorAssistantMessageId) ?? [];
    list.push(fact);
    goalVerificationsByAnchor.set(fact.anchorAssistantMessageId, list);
  }

  // MC-cold：modelChange marker 由投影在 TurnStarted 时
  // 对比 lastTurnModel 与 config 生成；冷恢复按每轮持久化选型事实在 TurnStarted 前
  // 合成 ModelSelected——普通首轮静默，显式 source-less 与后续 A→B 边界恒重建。
  // 该合成事件带 HYDRATION_TRACE_ID，不声明 种子权威（见 onModelSelected）。
  let lastSelectedModelKey: string | null = null;
  let pendingTimelineModel: HydratedTimelineModel | null = null;
  const selectTurnModel = (selection: HydratedTimelineModel | null): void => {
    if (!selection) return;
    const key = hydratedModelKey(selection.modelSelection);
    if (key === lastSelectedModelKey) return;
    lastSelectedModelKey = key;
    push(SessionEventType.ModelSelected, {
      modelSelection: selection.modelSelection,
      ...(selection.previousModelSelection !== undefined
        ? {
            previousModelSelection: selection.previousModelSelection
              ? selection.previousModelSelection
              : null,
          }
        : {}),
    });
  };
  const selectAcceptedTurnModel = (fallback: ModelSelection | null): void => {
    const selected = pendingTimelineModel ?? (fallback ? { modelSelection: fallback } : null);
    pendingTimelineModel = null;
    selectTurnModel(selected);
  };
  const recordTimelineModel = (selection: HydratedTimelineModel): void => {
    pendingTimelineModel = selection;
    selectTurnModel(selection);
  };

  const finishTurn = (input: {
    failure?: TurnOutputCollection["failure"];
    fileChanges?: TurnFileChangeSummary;
    turnId: string;
    resultType: TurnResultForHydration;
    toolCallCount: number;
    historyRoundCount: number;
    turnStartedAtMs: number;
    turnEndedAtMs: number;
  }): void => {
    if (input.failure) {
      // provider 首字前失败只持久化在 assistant.info.error，旧 cold 路径
      // 折成 TurnComplete(error_during_execution)，导致 lastError 的 code/message 全丢。
      // 这里复用 live 的 TurnError 状态机，避免另建 cold-only 错误 reducer。
      push(
        SessionEventType.TurnError,
        { error: input.failure, turnPhase: "model" },
        input.turnId,
        input.turnEndedAtMs,
      );
      return;
    }
    push(
      SessionEventType.ModelComplete,
      {
        content: "",
        stopReason: "end_turn",
        querySource: "main_turn",
        // 冷恢复曾把合成事件的窗口固定成 20 万，覆盖同一模型在
        // workspace provider registry 中的 1M 能力；这里沿用调用方解析出的当前模型真值。
        contextWindow,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        ...(input.fileChanges ? { fileChanges: input.fileChanges } : {}),
      },
      input.turnId,
      input.turnEndedAtMs,
    );
    push(
      SessionEventType.TurnComplete,
      {
        response: "",
        tokenCount: 0,
        toolCallCount: input.toolCallCount,
        historyRoundCount: input.historyRoundCount,
        // 冷恢复是从 message transcript 反向合成事件，不能像 live
        // 事件一样依赖运行时 startedAt；固定 0 会让历史轮次显示成 1 秒。
        duration: Math.max(0, input.turnEndedAtMs - input.turnStartedAtMs),
        resultType: input.resultType,
      },
      input.turnId,
      input.turnEndedAtMs,
    );
  };

  while (index < messages.length) {
    const message = messages[index]!;
    if (isProviderContextOnlyAssistant(message)) {
      index += 1;
      continue;
    }
    if (isLegacyCompactMaintenanceInput(message, messages[index + 1])) {
      // 旧手动 compact 的 user 宿主只是维护命令，不是 real-user intent；跳过宿主后，
      // 下一条 assistant compact fact 会走 preface model-only 轮并生成 canonical marker。
      index += 1;
      continue;
    }
    if (isForkTimelineMessage(message)) {
      const forkContext = forkContextOfMessage(message);
      if (forkContext) {
        push(SessionEventType.SessionForked, {
          forkPoint: 0,
          originalSessionId: forkContext.parentSessionId,
          restoredFileCount: forkContext.restoredFileCount,
          targetCheckpointId: forkContext.targetCheckpointId,
          targetMessageId: forkContext.targetMessageId,
        });
      }
      const worktreeCreation = worktreeCreationOfMessage(message);
      if (worktreeCreation) push(SessionEventType.WorktreeCreated, { ...worktreeCreation });
      index += 1;
      continue;
    }
    const worktreeCreation = worktreeCreationOfMessage(message);
    if (worktreeCreation) {
      // 新建 worktree 会话：首轮之前的宿主消息；投影暂存到首个 TurnStarted 落在轮顶。
      push(SessionEventType.WorktreeCreated, { ...worktreeCreation });
      index += 1;
      continue;
    }
    const timelineModel = modelChangeToModelOf(message);
    if (timelineModel) {
      // model_change timeline part 是已接受轮的持久边界事实；
      // 宿主消息不能完全跳过、只靠后续 user message model 快照碰巧重建：
      // 快照缺失/滞后时 marker 就会消失，所以先消费显式 toModel，
      // 下一个 TurnStarted 仅使用该权威选型，不再被滞后快照覆盖。
      recordTimelineModel(timelineModel);
      index += 1;
      continue;
    }
    const workflowLaunch = workflowLaunchOfMessage(message);
    if (workflowLaunch) {
      // 中枢直接启动的启动轮：可见 controlOnly 用户轮，冷恢复须与活投影同形——同一 messageId、
      // origin workflowLaunch（由 inputSource 映射）、同一份 workflowLaunch 元数据、无助手输出。
      // 放在 real-user 分支之前，避免这条 synthetic user 被 hiddenSynthetic 跳过。
      turnNumber += 1;
      const turnId = `hydrate-turn-${turnNumber}`;
      lastTurnId = turnId;
      const launchText = textOfMessage(message.parts);
      const turnStartedAtMs = messageCreatedAtMs(message) ?? baseMs + seq;
      selectAcceptedTurnModel(turnModelSelectionOfUserMessage(message));
      push(
        SessionEventType.TurnStarted,
        {
          turnNumber,
          // 文本仍进 userInput.text（旧客户端 / TUI 的降级呈现）；GUI 用元数据画启动卡。
          input: launchText,
          // 持久 messageId 是该轮权威 target，与活投影同用，否则 productTurn 身份冷热分叉。
          messageId: String(message.info.id),
          // 启动轮不执行 Agent（controlOnly，无工时）；source 驱动 origin=workflowLaunch。
          executionKind: "controlOnly",
          inputSource: "workflow_launch",
          workflowLaunch,
        },
        turnId,
        turnStartedAtMs,
      );
      index += 1;
      const collected = collectTurnOutput({
        messages,
        startIndex: index,
        turnId,
        turnStartedAtMs,
        emittedCompactOperations,
        durableCompactPartsByOperation,
        emittedGoalVerifications,
        goalVerificationsByAnchor,
        onModelChange: recordTimelineModel,
        push,
      });
      index = collected.nextIndex;
      finishTurn({
        failure: collected.failure,
        turnId,
        resultType: collected.resultType,
        toolCallCount: collected.toolCallCount,
        historyRoundCount: collected.historyRoundCount,
        turnStartedAtMs,
        turnEndedAtMs: collected.turnEndedAtMs,
      });
      continue;
    }
    if (!isRealUserTurnStarter(message)) {
      // model-only 唤醒轮：background wake /
      // goal continuation 触发的 synthetic user 开独立 model-only 轮（无可见气泡，
      // 通知文本不进 rows），其后 assistant 归本轮——与 live 的 TurnStarted
      // (inputVisibility=model-only) 结构一致，不再并进上一轮。
      const wakeSource = getConversationModelOnlyTurnTriggerSource(message);
      if (wakeSource) {
        turnNumber += 1;
        const turnId = `hydrate-turn-${turnNumber}`;
        lastTurnId = turnId;
        const turnStartedAtMs = messageCreatedAtMs(message) ?? baseMs + seq;
        selectAcceptedTurnModel(turnModelSelectionOfUserMessage(message));
        push(
          SessionEventType.TurnStarted,
          {
            turnNumber,
            // cold hydration 曾把 model-only background wake 的原文清空，
            // 导致 ProductProjection 即使能消费 task-notification，恢复时也拿不到
            // tool-use-id 与失败详情。输入仍是 model-only，不会生成用户气泡。
            input:
              wakeSource === "background_task" ? backgroundWakeInputOfMessage(message.parts) : "",
            inputVisibility: "model-only",
            inputSource: wakeSource,
            ...(wakeSource === "background_task"
              ? { originMeta: backgroundResultOriginMetaOfMessage(message) }
              : {}),
            // model-only trigger 同样是持久 user 实体；若不传 messageId，
            // cold 会退化到 hydrate-turn-N，live/cold productTurn 身份再次分叉。
            messageId: String(message.info.id),
          },
          turnId,
          turnStartedAtMs,
        );
        index += 1;
        const collected = collectTurnOutput({
          messages,
          startIndex: index,
          turnId,
          turnStartedAtMs,
          emittedCompactOperations,
          durableCompactPartsByOperation,
          emittedGoalVerifications,
          goalVerificationsByAnchor,
          onModelChange: recordTimelineModel,
          push,
        });
        index = collected.nextIndex;
        finishTurn({
          failure: collected.failure,
          fileChanges: options.fileChangeSummariesByMessageId?.get(String(message.info.id)),
          turnId,
          resultType: collected.resultType,
          toolCallCount: collected.toolCallCount,
          historyRoundCount: collected.historyRoundCount,
          turnStartedAtMs,
          turnEndedAtMs: collected.turnEndedAtMs,
        });
        continue;
      }
      // assistant-head-skip 修复（「assistant 回复整段消失」冷路径向量）：
      // 首条真实用户消息之前的消息不能一律跳过——会话头部是 rewind notice /
      // compact summary 等非真实用户消息时，其后 assistant 回复刷新后会整段消失。
      // 因此为头部 assistant 输出合成 preface model-only 轮（无可见 user 气泡，
      // 内容照常渲染）。user 角色的非触发型 synthetic context 仍按设计不可见，照旧跳过。
      if (message.info.role !== "assistant" || !assistantMessageHasSynthesizableContent(message)) {
        index += 1;
        continue;
      }
      turnNumber += 1;
      const turnId = `hydrate-turn-${turnNumber}`;
      lastTurnId = turnId;
      const turnStartedAtMs = messageCreatedAtMs(message) ?? baseMs + seq;
      selectAcceptedTurnModel(assistantModelSelectionOf(message));
      push(
        SessionEventType.TurnStarted,
        { turnNumber, input: "", inputVisibility: "model-only" },
        turnId,
        turnStartedAtMs,
      );
      const collected = collectTurnOutput({
        messages,
        startIndex: index,
        turnId,
        turnStartedAtMs,
        emittedCompactOperations,
        durableCompactPartsByOperation,
        emittedGoalVerifications,
        goalVerificationsByAnchor,
        onModelChange: recordTimelineModel,
        push,
      });
      index = collected.nextIndex;
      finishTurn({
        failure: collected.failure,
        turnId,
        resultType: collected.resultType,
        toolCallCount: collected.toolCallCount,
        historyRoundCount: collected.historyRoundCount,
        turnStartedAtMs,
        turnEndedAtMs: collected.turnEndedAtMs,
      });
      continue;
    }

    turnNumber += 1;
    const turnId = `hydrate-turn-${turnNumber}`;
    lastTurnId = turnId;
    const userText = textOfMessage(message.parts);
    const attachments = attachmentMetasOfMessage(message.parts);
    const intent = inputIntentOfMessage(message);
    const executionKind = executionKindOfMessage(message);
    const epilogueStart = epilogueStartOfMessage(message);
    const turnStartedAtMs = messageCreatedAtMs(message) ?? baseMs + seq;
    // timeline part 与下一个 accepted turn 之间可以夹着 legacy synthetic
    // context，不能靠「紧邻前一条」猜测；持有显式边界直到真正开轮。
    selectAcceptedTurnModel(turnModelSelectionOfUserMessage(message));
    push(
      SessionEventType.TurnStarted,
      {
        turnNumber,
        input: userText,
        ...(epilogueStart === undefined ? {} : { epilogueStart }),
        // 根因：cold hydration 过去只重建可见 user row，遗漏持久 messageId，导致
        // 同一条历史消息在 UI 中可见却无法被 edit/rewind 命令寻址。真实 user
        // transcript message 就是该 row 的权威 target，必须与 live TurnStarted
        // 使用同一个 messageId 字段进入 ProductProjection。
        messageId: String(message.info.id),
        ...(executionKind ? { executionKind } : {}),
        ...(message.info.anchor?.sourceCommandId
          ? { inputId: message.info.anchor.sourceCommandId }
          : {}),
        ...(intent ? { intent } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      },
      turnId,
      turnStartedAtMs,
    );
    index += 1;

    const collected = collectTurnOutput({
      messages,
      startIndex: index,
      turnId,
      turnStartedAtMs,
      emittedCompactOperations,
      durableCompactPartsByOperation,
      emittedGoalVerifications,
      goalVerificationsByAnchor,
      onModelChange: recordTimelineModel,
      push,
    });
    index = collected.nextIndex;
    finishTurn({
      failure: collected.failure,
      fileChanges: options.fileChangeSummariesByMessageId?.get(String(message.info.id)),
      turnId,
      resultType: collected.resultType,
      toolCallCount: collected.toolCallCount,
      historyRoundCount: collected.historyRoundCount,
      turnStartedAtMs,
      turnEndedAtMs: collected.turnEndedAtMs,
    });
  }

  // anchor 缺失或指向未在 transcript 中出现的消息的 entry 事实：落到已知时间线末尾
  //（已按 key 去重，锚定成功的在上面循环里已发射；不猜 timestamp，不静默丢）。
  for (const fact of entryFacts) {
    pushGoalVerificationFact(fact, emittedGoalVerifications, push, lastTurnId);
  }

  return events;
}

function transcriptFootprint(
  messages: readonly MessageWithParts[],
  goalVerificationEntries: readonly HydratedGoalVerificationEntry[] = [],
): TranscriptFootprint {
  const compactOperations = new Set<string>();
  const goalVerificationKeys = new Set<string>();
  const modelChangeKeys = new Set<string>();
  for (const fact of mergeGoalVerificationEntryFacts(goalVerificationEntries)) {
    goalVerificationKeys.add(fact.key);
  }
  const footprint: TranscriptFootprint = {
    userTurnCount: 0,
    assistantTexts: [],
    reasoningTexts: [],
    toolCallIds: [],
    compactMarkerCount: 0,
    subagentCount: 0,
    forkTimelineCount: 0,
    goalVerificationCount: 0,
    modelChangeCount: 0,
    worktreeCreatedCount: 0,
  };
  // 模型切换 footprint = 相邻真实 user 轮持久化选型快照的变化次数（与投影 marker 的
  // 生成条件同源：本轮实际选型 ≠ 上一轮）。
  let lastModelKey: string | null = null;

  for (const message of messages) {
    if (isForkTimelineMessage(message)) {
      footprint.forkTimelineCount += 1;
    }
    if (isRealUserTurnStarter(message)) {
      footprint.userTurnCount += 1;
      const model = turnModelSelectionOfUserMessage(message);
      if (model) {
        const key = hydratedModelKey(model);
        if (lastModelKey !== null && key !== lastModelKey) {
          footprint.modelChangeCount += 1;
        }
        lastModelKey = key;
      }
    }
    if (message.info.role !== "assistant" || isProviderContextOnlyAssistant(message)) {
      continue;
    }
    for (const part of message.parts) {
      if (part.type === "text" && part.ignored !== true && part.text.length > 0) {
        footprint.assistantTexts.push(part.text);
        continue;
      }
      if (part.type === "reasoning" && part.text.length > 0) {
        footprint.reasoningTexts.push(part.text);
        continue;
      }
      if (part.type === "tool") {
        if (shouldHideInvalidToolCallFromProduct(part.tool, part.metadata)) continue;
        footprint.toolCallIds.push(part.callID);
        const subagentInfo = subagentInfoFromToolPart(part);
        if (subagentInfo && part.state.status !== "pending") {
          footprint.subagentCount += 1;
        }
        continue;
      }
      if (part.type === "subtask") {
        footprint.subagentCount += 1;
        continue;
      }
      if (part.type === "timeline" && part.timelineType === "goal_verification") {
        goalVerificationKeys.add(goalVerificationKeyOfPart(part));
        continue;
      }
      if (part.type === "timeline" && part.timelineType === "model_change") {
        modelChangeKeys.add(modelChangeKeyOfPart(part));
        continue;
      }
      if (part.type === "timeline" && part.timelineType === "worktree_creation") {
        footprint.worktreeCreatedCount += 1;
        continue;
      }
      const compact =
        part.type === "timeline"
          ? compactPayloadFromTimelinePart(part)
          : part.type === "compaction"
            ? compactPayloadFromLegacyCompactionPart(part)
            : null;
      if (compact) {
        compactOperations.add(String(compact.payload.operationId));
      }
    }
  }
  footprint.compactMarkerCount = compactOperations.size;
  footprint.goalVerificationCount = goalVerificationKeys.size;
  // 新数据的 timeline part 是显式 boundary authority；旧数据无 part 时才依赖
  // 相邻轮 model 快照变化数。两者表达同一批边界，取 max 避免重复计数。
  footprint.modelChangeCount = Math.max(footprint.modelChangeCount, modelChangeKeys.size);
  return footprint;
}

function projectionFootprint(
  events: readonly SessionEvent[],
  sessionId: string,
): TranscriptFootprint {
  const projection = new ProductProjection(sessionId, "hydrate-footprint");
  for (const event of events) {
    projection.applyEvent(event);
  }
  const rows = projection.getSnapshot().rows.window;
  return {
    userTurnCount: rows.filter((row) => row.kind === "userInput").length,
    assistantTexts: rows
      .filter((row) => row.kind === "assistantText")
      .map((row) => (row.kind === "assistantText" ? row.text : "")),
    reasoningTexts: rows
      .filter((row) => row.kind === "reasoning")
      .map((row) => (row.kind === "reasoning" ? row.text : "")),
    toolCallIds: rows
      .filter((row) => row.kind === "toolCall")
      .map((row) => (row.kind === "toolCall" ? row.toolCallId : "")),
    compactMarkerCount: rows.filter(
      (row) => row.kind === "timelineMarker" && row.marker.type === "compact",
    ).length,
    subagentCount: rows.filter((row) => row.kind === "subagent").length,
    forkTimelineCount: rows.filter(
      (row) =>
        row.kind === "timelineMarker" &&
        (row.marker.type === "forkNotice" || row.marker.type === "forkCreated"),
    ).length,
    goalVerificationCount: rows.filter(
      (row) => row.kind === "timelineMarker" && row.marker.type === "goalVerify",
    ).length,
    modelChangeCount: rows.filter(
      (row) => row.kind === "timelineMarker" && row.marker.type === "modelChange",
    ).length,
    worktreeCreatedCount: rows.filter(
      (row) => row.kind === "timelineMarker" && row.marker.type === "worktreeCreated",
    ).length,
  };
}

function valuesCover(expected: readonly string[], actual: readonly string[]): boolean {
  const remaining = [...actual];
  for (const value of expected) {
    const index = remaining.indexOf(value);
    if (index < 0) return false;
    remaining.splice(index, 1);
  }
  return true;
}

function footprintCovered(expected: TranscriptFootprint, actual: TranscriptFootprint): boolean {
  return (
    actual.userTurnCount >= expected.userTurnCount &&
    actual.compactMarkerCount >= expected.compactMarkerCount &&
    actual.subagentCount >= expected.subagentCount &&
    actual.forkTimelineCount >= expected.forkTimelineCount &&
    actual.goalVerificationCount >= expected.goalVerificationCount &&
    actual.modelChangeCount >= expected.modelChangeCount &&
    actual.worktreeCreatedCount >= expected.worktreeCreatedCount &&
    valuesCover(expected.assistantTexts, actual.assistantTexts) &&
    valuesCover(expected.reasoningTexts, actual.reasoningTexts) &&
    valuesCover(expected.toolCallIds, actual.toolCallIds)
  );
}

/**
 * 判断事件日志是否足以覆盖 transcript 的可见产品态。
 * 修复原因：旧判据只数 user turn，事件日志即使缺 tool/reasoning/compact/subagent
 * 也会被误判为完整，导致冷恢复 snapshot 没有对应 rows。
 */
export function eventsCoverTranscript(
  events: readonly SessionEvent[],
  messages: readonly MessageWithParts[],
  options: {
    goalVerificationEntries?: readonly HydratedGoalVerificationEntry[];
  } = {},
): boolean {
  const expected = transcriptFootprint(messages, options.goalVerificationEntries ?? []);
  if (
    expected.userTurnCount === 0 &&
    expected.assistantTexts.length === 0 &&
    expected.reasoningTexts.length === 0 &&
    expected.toolCallIds.length === 0 &&
    expected.compactMarkerCount === 0 &&
    expected.subagentCount === 0 &&
    expected.forkTimelineCount === 0 &&
    expected.goalVerificationCount === 0 &&
    expected.modelChangeCount === 0
  ) {
    return true;
  }
  const sessionId = String(messages[0]?.info.sessionID ?? events[0]?.sessionId ?? "unknown");
  return footprintCovered(expected, projectionFootprint(events, sessionId));
}
