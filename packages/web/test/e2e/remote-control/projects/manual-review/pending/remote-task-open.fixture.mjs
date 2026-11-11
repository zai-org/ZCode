import { conversationTopicWireFrameSchema } from "@zcode/shared/zcode-protocol-v4";

// 只提供已完成历史，不产生模型请求；快照经真实协议 schema 校验后送入 renderer。
export function taskSnapshotFrame(sessionId, subscriptionId) {
  const topic = `conversation/${sessionId}`;
  return conversationTopicWireFrameSchema.parse({
    wireVersion: 3,
    kind: "complete",
    deliveryKind: "initial",
    logicalFrameId: `frame-${subscriptionId}`,
    logicalFrameOrdinal: 1,
    topic,
    subscriptionId,
    frame: {
      topic,
      subscriptionId,
      fromSeq: 0,
      toSeq: 1,
      sentAt: 1,
      payload: {
        kind: "snapshot",
        snapshot: {
          protocolVersion: 1,
          sessionId,
          logEpoch: "e2e",
          seq: 1,
          revision: 1,
          control: {
            phase: "completedSuccess",
            sessionEnded: false,
            canStop: false,
            stopState: "idle",
            stopTargetKind: "unknown",
            activeWorks: [],
            lastError: null,
            apiRetry: null,
          },
          availability: {
            fork: { allowed: true },
            compact: { allowed: false, reasonCode: "idleCannotCompact" },
            switchModelConfig: { allowed: true },
            setFollowupMode: { allowed: true },
            queueEdit: { allowed: true },
            sendQueuedNow: { allowed: false, reasonCode: "sendQueuedNowRequiresRunning" },
            pauseGoal: { allowed: false, reasonCode: "noGoalToPause" },
            resumeGoal: { allowed: false, reasonCode: "noGoalToResume" },
          },
          inputRouting: { mode: "startNow" },
          meta: { title: `E2E_MRO01_${sessionId}`, titleSource: "custom" },
          config: { provider: "", model: "", thought: "", followupMode: "queue" },
          usage: {
            contextWindow: null,
            cumulative: {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
          },
          queue: { items: [], autoDrain: true },
          pendingInteractions: [],
          pendingCommands: [],
          backgroundWorks: [],
          goal: null,
          plan: null,
          rows: {
            totalCount: 1,
            firstRowId: 1,
            window: [
              {
                rowId: 1,
                turnId: "turn-1",
                createdAt: 1,
                createdAtSeq: 1,
                kind: "assistantText",
                text: `E2E_MRO01_${sessionId}_HISTORY`,
                state: "complete",
              },
            ],
          },
        },
      },
    },
  });
}
