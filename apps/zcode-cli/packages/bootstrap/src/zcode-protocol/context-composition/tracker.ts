// context 组成修订号的唯一 owner。规格：apps/zcode-cli/docs/design/v2/model/context-composition.md §3.4。
//
// runtime 在变更点同步调用监听器；这里按会话合并：同一轮事件循环里的多次变更只让修订号加一、
// 只发一条通知（queueMicrotask，不用定时器）。修订号在第一次变更时就加一，同一轮里到达的查询
// 读到的已是新值，随后到达的通知不会再触发一次多余的拉取。
// 修订号随 CLI 进程存活，runtime 重建（冷恢复）不重置；CLI 进程重启后从 0 重新开始。
import {
  V4_NOTIFICATIONS,
  v4ConversationContextCompositionChangedSchema,
  type ContextCompositionChangedEvent,
} from "@zcode/shared/zcode-protocol-v4";
import type { AgentRuntime } from "@zcode/core";
import type { ZCodeProtocolAgentServerContext } from "../server-types.js";

export class ContextCompositionRevisionTracker {
  private readonly revisions = new Map<string, number>();
  private readonly pending = new Set<string>();

  constructor(private readonly emit: (event: ContextCompositionChangedEvent) => void) {}

  /** 当前修订号；从未变化过的会话为 0。 */
  revision(sessionId: string): number {
    return this.revisions.get(sessionId) ?? 0;
  }

  markChanged(sessionId: string): void {
    if (this.pending.has(sessionId)) return;
    this.pending.add(sessionId);
    this.revisions.set(sessionId, this.revision(sessionId) + 1);
    queueMicrotask(() => {
      this.pending.delete(sessionId);
      this.emit(
        v4ConversationContextCompositionChangedSchema.parse({
          sessionId,
          revision: this.revision(sessionId),
        }),
      );
    });
  }
}

/** 每个协议 server 一份 tracker，挂在 context 上，跨会话 record 的重建存活。 */
export function getContextCompositionTracker(
  context: Pick<ZCodeProtocolAgentServerContext, "contextCompositionTracker" | "notify">,
): ContextCompositionRevisionTracker {
  context.contextCompositionTracker ??= new ContextCompositionRevisionTracker((params) =>
    context.notify({ method: V4_NOTIFICATIONS.conversationContextCompositionChanged, params }),
  );
  return context.contextCompositionTracker;
}

/** 会话 record 建立时接线：runtime 的组成变更 → tracker。返回取消订阅函数。 */
export function subscribeSessionContextComposition(
  context: Pick<ZCodeProtocolAgentServerContext, "contextCompositionTracker" | "notify">,
  sessionId: string,
  runtime: Partial<Pick<AgentRuntime, "subscribeContextCompositionChanged">> | undefined,
): () => void {
  // 测试桩的 runtime 可能没有这个方法（`as never`），缺席即不接线。
  if (typeof runtime?.subscribeContextCompositionChanged !== "function") return () => {};
  const tracker = getContextCompositionTracker(context);
  return runtime.subscribeContextCompositionChanged(() => tracker.markChanged(sessionId));
}
