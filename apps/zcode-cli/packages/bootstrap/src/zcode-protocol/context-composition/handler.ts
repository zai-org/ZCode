// v4/conversation/contextComposition 的 CLI 侧处理。规格：apps/zcode-cli/docs/design/v2/model/context-composition.md §3.3。
//
// existing-only：会话不在内存时回 null，不为查询冷启动或恢复会话。
// 修订号在测量之前读：测量期间又有变化时，后到的通知带更大的修订号，消费方据此丢弃旧结果。
import {
  v4ConversationContextCompositionParamsSchema,
  v4ConversationContextCompositionResultSchema,
  type V4ConversationContextCompositionResult,
} from "@zcode/shared/zcode-protocol-v4";
import { parseParams, type ZCodeProtocolAgentServerContext } from "../server-types.js";
import { getContextCompositionTracker } from "./tracker.js";

export async function getConversationContextComposition(
  context: Pick<
    ZCodeProtocolAgentServerContext,
    "contextCompositionTracker" | "notify" | "sessions"
  >,
  rawParams: unknown,
): Promise<V4ConversationContextCompositionResult> {
  const params = parseParams(v4ConversationContextCompositionParamsSchema, rawParams);
  const record = context.sessions.get(params.sessionId);
  if (!record) return { composition: null };
  const revision = getContextCompositionTracker(context).revision(params.sessionId);
  const measurement = await record.app.runtime.getContextComposition({
    ...(params.modelSelection ? { modelSelection: params.modelSelection } : {}),
    traceContext: record.traceContext,
  });
  return v4ConversationContextCompositionResultSchema.parse({
    composition: measurement ? { sessionId: params.sessionId, revision, ...measurement } : null,
  });
}
