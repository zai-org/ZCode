/**
 * 授权弹窗的用户应答结果（docs/monitoring/business-monitoring.md「授权弹窗结果」）。
 * 只记录桌面端用户在弹窗上的选择；Hook、规则、超时和手机远控的应答不经过这里。
 * 只输出枚举、计数和工具标识，不带反馈正文、命令或路径。
 */
import { redactTelemetryText } from "../telemetryRedaction.js";

export const PERMISSION_PROMPT_RESULT_EVENT = "permission_prompt_result";

/** V4 投影出的稳定 optionId → 埋点枚举；未知 optionId 按 kind 归类。 */
const OPTION_BY_ID: Readonly<Record<string, string>> = {
  allowOnce: "allow_once",
  allowAlways: "allow_project",
  allowSession: "allow_session",
  fullAccess: "allow_full_access",
  allowAndSwitchGuarded: "allow_switch_guarded",
  deny: "deny",
  workflowRefine: "workflow_refine",
};
const OPTION_BY_KIND: Readonly<Record<string, string>> = {
  allowOnce: "allow_once",
  allowAlways: "allow_always_other",
  deny: "deny",
};

const MAX_TOOL_IDENTIFIER_LENGTH = 128;
const TOOL_IDENTIFIER_PATTERN = /^[A-Za-z0-9_.:@-]+$/u;
const MODE_SWITCH_VALUES = new Set(["choose", "fullAccessOnly"]);

/** 与 agent_step.tool_name / tool_call_id 同一标识；不合规的值整体丢弃，不截断。 */
function safeIdentifier(value: string | undefined, fallback: string): string {
  if (
    !value ||
    value.length > MAX_TOOL_IDENTIFIER_LENGTH ||
    !TOOL_IDENTIFIER_PATTERN.test(value) ||
    redactTelemetryText(value) !== value
  ) {
    return fallback;
  }
  return value;
}

/**
 * 应答命令的 ACK：duplicate 是同一命令重投，选择已生效；noop 是命令收件箱 / 网关判定无事可做，单列不计入 accepted。
 * 注意：另一端（手机、Hook、超时）已先收口时，CLI 的 resolveInteraction 仍按幂等成功返回 accepted
 * （interaction-background.ts），客户端无法区分，这种晚到应答会记为 accepted。
 */
export function resolvePermissionPromptAck(status: string): "accepted" | "noop" | "failed" {
  if (status === "accepted" || status === "duplicate") return "accepted";
  return status === "noop" ? "noop" : "failed";
}

/**
 * 按 interactionId 记录弹窗在本窗口首次出现的时间，并决定一次应答要不要上报。由调用方在模块级持有一份：
 * 计时归属 interaction，不随会话切换、组件重挂载重置。
 * - 应答 accepted 后记为已应答：弹窗要等快照更新才消失，这期间的双击 / 连点会再发一次应答且 CLI 仍返回
 *   accepted，不能再记一次选择，也不重新计时。
 * - failed / noop 不算已应答（noop 来自收件箱或网关的 guard，不能证明应答已送达），之后的应答照常上报，
 *   并沿用原起点。
 * 有界：超出上限时丢弃最早的记录。被另一端、Hook 或超时收口的弹窗不会在这里收口，只靠上限回收；
 * 不能按「当前会话 pending 列表里没有」来清理——表跨会话共用，那样会清掉用户切走的会话里仍挂着的弹窗。
 */
export function createPermissionPromptShownClock(maxEntries = 256) {
  const shownAt = new Map<string, number>();
  const answered = new Set<string>();
  const trim = (store: {
    size: number;
    keys(): Iterator<string>;
    delete(key: string): boolean;
  }) => {
    if (store.size > maxEntries) store.delete(store.keys().next().value!);
  };
  return {
    markShown(interactionId: string, now: number): void {
      if (shownAt.has(interactionId) || answered.has(interactionId)) return;
      shownAt.set(interactionId, now);
      trim(shownAt);
    },
    /**
     * 一次应答返回后调用：返回是否上报及计时起点；accepted 时同时收口该 interaction。
     * 已收口过的 interaction 返回 report=false。
     */
    claimReport(
      interactionId: string,
      ackStatus: string,
    ): { report: false } | { report: true; shownAt: number | undefined } {
      if (answered.has(interactionId)) return { report: false };
      const startedAt = shownAt.get(interactionId);
      if (resolvePermissionPromptAck(ackStatus) === "accepted") {
        shownAt.delete(interactionId);
        answered.add(interactionId);
        trim(answered);
      }
      return { report: true, shownAt: startedAt };
    },
  };
}

export function resolvePermissionPromptOption(option: { optionId: string; kind?: string }): string {
  return OPTION_BY_ID[option.optionId] ?? OPTION_BY_KIND[option.kind ?? ""] ?? "other";
}

export function buildPermissionPromptResultTelemetryEvent(input: {
  sessionId: string;
  /** 弹窗所在轮次的 sourceCommandId；取不到时为空，数据侧可用 tool_call_id 关联 agent_step。 */
  messageId?: string;
  toolName: string;
  toolCallId: string;
  option: { optionId: string; kind?: string };
  feedback?: string;
  /** 请求来自子 agent（在父会话的弹窗里应答）。 */
  fromSubagent: boolean;
  askMode?: string;
  modeSwitch?: string;
  /** 弹窗在本窗口首次出现的时间与应答时间（渲染端时钟），毫秒。 */
  shownAt?: number;
  respondedAt: number;
  /** resolveInteraction 的 ACK 状态；传输异常时传 "failed"。 */
  ackStatus: string;
}): {
  elementName: typeof PERMISSION_PROMPT_RESULT_EVENT;
  eventRegion: "chat";
  eventType: "result";
  eventExtraDetail: Record<string, string>;
  talkId: string;
  messageId?: string;
} {
  const option = resolvePermissionPromptOption(input.option);
  const waitMs =
    typeof input.shownAt === "number" && Number.isFinite(input.shownAt)
      ? String(Math.max(0, Math.round(input.respondedAt - input.shownAt)))
      : "";
  return {
    elementName: PERMISSION_PROMPT_RESULT_EVENT,
    eventRegion: "chat",
    eventType: "result",
    talkId: input.sessionId,
    ...(input.messageId ? { messageId: input.messageId } : {}),
    eventExtraDetail: {
      option,
      // 只记有没有写理由；空白不算。反馈只在拒绝 / Refine 时交给模型，批准时填写的会被忽略。
      has_feedback:
        (option === "deny" || option === "workflow_refine") && input.feedback?.trim() ? "1" : "0",
      tool_name: safeIdentifier(input.toolName, "other"),
      tool_call_id: safeIdentifier(input.toolCallId, ""),
      from_subagent: input.fromSubagent ? "1" : "0",
      ask_mode: safeIdentifier(input.askMode, ""),
      mode_switch: MODE_SWITCH_VALUES.has(input.modeSwitch ?? "") ? input.modeSwitch! : "",
      wait_ms: waitMs,
      ack: resolvePermissionPromptAck(input.ackStatus),
    },
  };
}
