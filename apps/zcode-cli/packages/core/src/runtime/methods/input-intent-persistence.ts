import type { SessionStorePort, SessionId } from "@zcode/contracts";
import type { TurnInputIntentMetadata } from "../deps.js";

/**
 * 把 runtime 的协议无关参数组装成 transcript/ledger 共用的完整输入事实。
 *
 * 只分别保存 text 与一组 metadata 的话，恢复端必须再次推断 delivery、
 * steer 和 dispatch，容易让 live projection 与 cold snapshot 出现不同状态。这里在
 * admission/drain 边界一次性固化，后续消费者只能读取，不能重新猜测。
 */
export function buildPersistedConversationInputIntent(
  text: string,
  intent: TurnInputIntentMetadata | undefined,
  dispatchState: "queued" | "drained",
): Record<string, unknown> | undefined {
  if (!intent) return undefined;

  const steer = intent.fallbackReasonCode
    ? { state: "fellBack", reasonCode: intent.fallbackReasonCode }
    : intent.admittedDelivery === "guide"
      ? { state: dispatchState === "drained" ? "guided" : "steering" }
      : { state: "notRequested" };

  return {
    ...(intent.inputOrigin ? { inputOrigin: intent.inputOrigin } : {}),
    ...(intent.conversationQuotes ? { conversationQuotes: intent.conversationQuotes } : {}),
    ...(intent.botGroupSource ? { botGroupSource: intent.botGroupSource } : {}),
    sourceCommandId: intent.sourceCommandId,
    queueItemId: intent.queueItemId,
    clientId: intent.clientId,
    kind: intent.kind,
    // goal 的 message text 可以是 `/goal ...` 展示文案；admission 已持有 runtime
    // 解析后的 canonical objective，持久化必须优先使用它以保证 live/cold 等价。
    text: intent.text ?? text,
    attachments: intent.attachmentRefs ?? [],
    ...(intent.modelSelection ? { modelSelection: intent.modelSelection } : {}),
    ...(intent.mode ? { mode: intent.mode } : {}),
    ...(intent.planEnabled !== undefined ? { planEnabled: intent.planEnabled } : {}),
    ...(intent.genUiContext !== undefined ? { genUiContext: intent.genUiContext } : {}),
    ...(intent.sharedContextRefs ? { sharedContextRefs: intent.sharedContextRefs } : {}),
    delivery: {
      requested: intent.requestedDelivery,
      admitted: intent.admittedDelivery,
      ...(intent.fallbackReasonCode ? { fallbackReasonCode: intent.fallbackReasonCode } : {}),
    },
    order: {
      admissionSeq: intent.admissionSeq,
      ...(intent.queuePosition !== undefined ? { queuePosition: intent.queuePosition } : {}),
    },
    steer,
    dispatch: { state: dispatchState },
    admittedAt: intent.admittedAt,
    ...(intent.highspeed ? { highspeed: intent.highspeed } : {}),
    ...(intent.provenance ? { provenance: intent.provenance } : {}),
    ...(intent.source ? { source: intent.source } : {}),
  };
}

/** 在工具执行前收紧群任务授权；普通正文不能改变这个可信 metadata 标记。 */
export async function ensureGroupTaskPermissionScope(
  store: SessionStorePort | undefined,
  sessionId: SessionId,
  intent: TurnInputIntentMetadata | undefined,
): Promise<void> {
  if (!intent?.botGroupSource) return;
  if (!store) throw new Error("Group task permission scope requires persistence");
  const session = await store.getSession(sessionId);
  if (!session) throw new Error("Group task permission scope requires a persisted session");
  if (session.permission?.scope === "session") return;
  await store.updateSession({
    id: sessionId,
    permission: { version: 1, scope: "session", mode: "build" },
  });
}

/** 仅沿当前执行的因果 trace 传播，不从 session 最后使用端推断。 */
export const TELEMETRY_INPUT_ORIGIN_ATTRIBUTE = "telemetry.inputOrigin";
export function telemetryInputOrigin(
  intent: TurnInputIntentMetadata | undefined,
  attributes?: Record<string, string | number | boolean>,
): "desktop" | "mobile" | undefined {
  const value = intent?.inputOrigin ?? attributes?.[TELEMETRY_INPUT_ORIGIN_ATTRIBUTE];
  return value === "desktop" || value === "mobile" ? value : undefined;
}
export function backgroundBatchTelemetryAttributes(
  traces: readonly { attributes?: Record<string, string | number | boolean> }[],
): Record<string, string | number | boolean> {
  const origins = traces.map((trace) => telemetryInputOrigin(undefined, trace.attributes));
  const origin = origins[0];
  return {
    ...traces[0]?.attributes,
    [TELEMETRY_INPUT_ORIGIN_ATTRIBUTE]:
      // 同批只生成一个后台轮；只要包含手机触发就保留 mobile，避免合批吞掉远控统计。
      origins.includes("mobile")
        ? "mobile"
        : origin && origins.every((value) => value === origin)
          ? origin
          : "unknown",
  };
}

/** 接纳账本是唯一来源；运行轮数会因重开/回退改变，不能当作消息序号。 */
export async function readFirstMessageAttribution(
  store: SessionStorePort | undefined,
  sessionID: SessionId,
  inputId: string | undefined,
  turnNumber: number,
): Promise<boolean | undefined> {
  if (!store?.getSessionInputById || !inputId) return undefined;
  // 只按主键读当前接纳记录，避免每条消息扫描、解码整段会话输入。
  const input = await store.getSessionInputById(inputId);
  if (!input || input.sessionID !== sessionID) return undefined;
  if (input.admittedSequence > 0) return false;
  // 旧会话可能只有新版本的接纳记录；不能把迁移后的第一条误报为会话首条。
  // 持久接纳序号与运行 turnNumber 均从 0 开始，后者仅用于排除已有旧历史。
  return input.admittedSequence === 0 && turnNumber === 0 ? true : undefined;
}
