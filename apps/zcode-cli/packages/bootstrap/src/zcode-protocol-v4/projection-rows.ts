// SessionEvent payload → ConversationRow 的构造纯函数。
// row 自包含原则：这里产出的每一行都必须不依赖其它行即可渲染。
import type {
  CompactTimelineStatus,
  CompactTrigger,
  GoalStatus,
  SyntheticUserMessageSource,
  ToolResultPayload,
  TurnResultType,
  TurnStartedPayload,
} from "@zcode/contracts";
import type {
  GoalState,
  TimelineMarkerPayload,
  ToolOutput,
  TurnHeaderRow,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import { PROTOCOL_V4_LIMITS } from "@zcode/shared/zcode-protocol-v4";

export interface RowBaseInput {
  rowId: number;
  turnId: string;
  createdAt: number;
  createdAtSeq: number;
}

// inputSource → turnHeader.origin（10 §4.4.2）。
export function mapTurnHeaderOrigin(
  source: SyntheticUserMessageSource | undefined,
): TurnHeaderRow["origin"] {
  switch (source) {
    case "background_task":
      return "backgroundResult";
    case "goal-continuation":
      return "goalContinuation";
    case "rewind":
      return "editRerun";
    default:
      return "userInput";
  }
}

// inputSource → userInput.origin（10 §4.4.3）。
export function mapUserInputOrigin(
  source: SyntheticUserMessageSource | undefined,
): UserInputRow["origin"] {
  switch (source) {
    case "background_task":
      return "backgroundResult";
    case "goal-continuation":
      return "goalContinuation";
    case "subagent":
    case "subagent_message":
      return "mailbox";
    case "fork":
    case "plugin_reference":
    case "rewind":
    case "todo_reminder":
      return "synthetic";
    default:
      return "realUser";
  }
}

export function buildTurnHeaderRow(base: RowBaseInput, payload: TurnStartedPayload): TurnHeaderRow {
  return {
    ...base,
    kind: "turnHeader",
    origin: mapTurnHeaderOrigin(payload.inputSource),
    executionKind: payload.executionKind ?? "agent",
    ...(payload.originMeta ? { originMeta: payload.originMeta } : {}),
    state: "running",
    startedAt: base.createdAt,
  };
}

/**
 * userInput 行的提交配置（docs/ui/composer-edit-mode.md「内容与配置」）：编辑这条消息时载入工具栏。
 * 所有 userInput 行构造点（TurnStarted、queue/guide drain）必须经此投影，避免某条路径漏字段后
 * 编辑时被误当作旧消息、沿用当前工具栏。
 */
export function userInputSubmittedConfig(
  intent: Pick<UserInputRow, "modelSelection" | "mode" | "planEnabled"> | undefined,
): Pick<UserInputRow, "modelSelection" | "mode" | "planEnabled"> {
  return {
    ...(intent?.modelSelection ? { modelSelection: structuredClone(intent.modelSelection) } : {}),
    ...(intent?.mode ? { mode: intent.mode } : {}),
    ...(intent?.planEnabled !== undefined ? { planEnabled: intent.planEnabled } : {}),
  };
}

export function buildUserInputRow(base: RowBaseInput, payload: TurnStartedPayload): UserInputRow {
  // 附件渲染：TurnStarted 携带的展示元信息 → row.attachments。
  // ref 是内容引用占位（本地路径/artifact URI）；无稳定引用时以行内序号占位，
  // 展示层只用 fileName/mime/bytes，不据 ref 取内容（attachment/get query 属后续）。
  const attachments =
    payload.intent?.attachmentRefs ??
    payload.attachments?.map((meta, index) => ({
      ref: meta.ref ?? `turn-attachment/${base.rowId}/${index}`,
      fileName: meta.fileName,
      mime: meta.mime,
      bytes: meta.bytes,
    }));
  const sourceCommandId = payload.intent?.sourceCommandId ?? payload.inputId;
  const rootSourceCommandId = payload.intent?.provenance?.sourceCommandId ?? sourceCommandId;
  return {
    ...base,
    kind: "userInput",
    ...(payload.intent?.inputOrigin ? { inputOrigin: payload.intent.inputOrigin } : {}),
    ...(payload.intent?.conversationQuotes
      ? { conversationQuotes: payload.intent.conversationQuotes }
      : {}),
    ...(payload.intent?.botGroupSource ? { botGroupSource: payload.intent.botGroupSource } : {}),
    ...userInputSubmittedConfig(payload.intent),
    text:
      payload.intent?.conversationQuotes || payload.intent?.botGroupSource
        ? (payload.intent.text ?? payload.input)
        : payload.input,
    origin: mapUserInputOrigin(payload.inputSource),
    ...(sourceCommandId ? { sourceCommandId } : {}),
    ...(rootSourceCommandId ? { rootSourceCommandId } : {}),
    ...(payload.intent?.clientId ? { clientId: payload.intent.clientId } : {}),
    ...(payload.intent?.highspeed ? { highspeed: payload.intent.highspeed } : {}),
    ...(payload.epilogueStart === undefined ? {} : { epilogueStart: payload.epilogueStart }),
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
  };
}

export function mapTurnResultToHeaderState(
  resultType: TurnResultType,
): Exclude<TurnHeaderRow["state"], "running"> {
  switch (resultType) {
    case "success":
      return "completedSuccess";
    case "cancelled":
      return "completedInterrupted";
    default:
      return "failed";
  }
}

// CompactTimelineStatus → compact marker.status。
// 语义映射：retrying 仍是运行中；skipped = 无事发生（noop）；interrupted = 被 stop（cancelled）。
export function mapCompactMarkerStatus(
  status: CompactTimelineStatus,
): Extract<TimelineMarkerPayload, { type: "compact" }>["status"] {
  switch (status) {
    case "started":
    case "retrying":
      return "running";
    case "completed":
      return "success";
    case "skipped":
      return "noop";
    case "interrupted":
      return "cancelled";
    default:
      return "failed";
  }
}

// CompactTrigger → marker.origin：manual 之外（auto/partial/reactive/session_memory）
// 一律归 auto —— UI 只区分「用户点的」与「系统触发的」。
export function mapCompactMarkerOrigin(
  trigger: CompactTrigger,
): Extract<TimelineMarkerPayload, { type: "compact" }>["origin"] {
  return trigger === "manual" ? "manual" : "auto";
}

// 旧 GoalStatus → v4 GoalState.status。
// budget_limited 归 paused：预算耗尽与被 stop 一样等待用户显式 resume；
// complete 归 verified：旧词表没有 verifying/notSatisfied 细分，终态语义等价。
export function mapGoalStatus(status: GoalStatus): GoalState["status"] {
  switch (status) {
    case "active":
      return "active";
    case "complete":
      return "verified";
    default:
      return "paused";
  }
}

// 终态截断全档统一：head+tail 各 32K，超出部分以 truncated.ref 按需拉取。
// 阶段 ref 先用 toolCallId 占位（artifact 存取属传输外壳期）。
export function buildToolOutput(result: ToolResultPayload, toolCallId: string): ToolOutput {
  const text = result.content;
  // 模型可见文本只保留图片占位符，若 V4 output 不独立携带 display，
  // 实时投影和冷恢复都会丢失 CUA 截图。Node REPL 图片仍走 ToolCallRow.display 专用通道。
  const display = result.display?.kind === "node_repl_images" ? undefined : result.display;
  const headBytes = PROTOCOL_V4_LIMITS.toolOutputFinalHeadBytes;
  const tailBytes = PROTOCOL_V4_LIMITS.toolOutputFinalTailBytes;
  const totalBytes = Buffer.byteLength(text, "utf8");
  if (totalBytes <= headBytes + tailBytes) {
    return { text, ...(display ? { display } : {}) };
  }
  const buffer = Buffer.from(text, "utf8");
  const head = buffer.subarray(0, headBytes).toString("utf8");
  const tail = buffer.subarray(buffer.length - tailBytes).toString("utf8");
  return {
    text: `${head}\n…\n${tail}`,
    ...(display ? { display } : {}),
    truncated: { totalBytes, ref: `tool-output/${toolCallId}` },
  };
}
