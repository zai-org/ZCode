import { describe, expect, it } from "vitest";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";
import { conversationSnapshotSchema } from "@zcode/shared/zcode-protocol-v4";

function fixture() {
  const projection = new ProductProjection("session", "epoch");
  let seq = 0;
  const push = (type: SessionEvent["type"], payload: unknown) =>
    projection.applyEvent({
      id: `event-${++seq}`,
      sessionId: "session",
      traceId: "trace",
      turnId: "turn",
      sequenceNumber: seq,
      timestamp: new Date(seq),
      type,
      payload,
    } as SessionEvent);
  push(SessionEventType.SessionCreated, { mode: "build", planEnabled: true, contextWindow: 1000 });
  push(SessionEventType.TurnStarted, { turnNumber: 1, input: "start" });
  return { projection, push };
}

describe("完全访问 V4 权威投影", () => {
  it.each(["guarded", "yolo"] as const)("一次事件更新 %s 和混合 Plan 队列", (mode) => {
    const { projection, push } = fixture();
    for (const [id, planEnabled, delivery] of [
      ["a", true, "guide"],
      ["b", false, "queue"],
    ] as const) {
      push(SessionEventType.TurnSteerQueued, {
        pendingInputId: id,
        input: id,
        inputPreview: id,
        inputSize: 1,
        queueLength: 2,
        targetTurnId: "turn",
        delivery,
        intent: {
          sourceCommandId: id,
          queueItemId: id,
          clientId: "client",
          kind: "sendText",
          mode: "edit",
          planEnabled,
          requestedDelivery: delivery,
          admittedDelivery: delivery,
          admittedAt: 1,
          admissionSeq: id === "a" ? 1 : 2,
          attachmentRefs: [],
        },
      });
    }
    push(SessionEventType.QueueAutoDrainChanged, { autoDrain: false });
    const before = projection.getSnapshot().queue;
    push(SessionEventType.SessionModeChanged, {
      mode,
      planEnabled: true,
      previousMode: "build",
      source: "command",
      permissionGrant: { interactionId: "p", queueItemIds: ["a", "b"] },
    });
    const snapshot = projection.getSnapshot();
    expect(snapshot.config).toMatchObject({
      mode,
      planEnabled: true,
      permissionGrant: { interactionId: "p" },
    });
    expect(snapshot.queue).toEqual({
      ...before,
      items: before.items.map((item) => ({ ...item, mode })),
    });
    expect(conversationSnapshotSchema.safeParse(snapshot).success).toBe(true);
    push(SessionEventType.SessionModeChanged, {
      mode: "build",
      planEnabled: false,
      previousMode: "yolo",
      source: "command",
    });
    expect(projection.getSnapshot().queue).toEqual(snapshot.queue);
    expect(projection.getSnapshot().config.permissionGrant).toEqual({ interactionId: "p" });
  });
  it("新 UI 独立能力入口，旧 options 不增加错误授权；child/独立确认不投放", () => {
    const { projection, push } = fixture();
    const request = {
      requestId: "p",
      toolCallId: "t",
      toolName: "Bash",
      input: { command: "ping example.com" },
      reason: "approval",
      fullAccessSupported: true,
    };
    push(SessionEventType.PermissionRequested, request);
    let payload = projection.getSnapshot().pendingInteractions[0]!.payload;
    expect(payload.kind).toBe("permission");
    if (payload.kind !== "permission") throw new Error("wrong payload");
    expect(payload.options.map((item) => item.optionId)).toEqual([
      "allowOnce",
      "allowAlways",
      "deny",
    ]);
    expect(payload.fullAccessOption).toMatchObject({
      optionId: "fullAccess",
      response: { decision: "deny" },
    });
    push(SessionEventType.PermissionRequested, {
      ...request,
      requestId: "child",
      toolCallId: "ct",
      origin: {
        kind: "subagent",
        agentId: "a",
        agentType: "a",
        childSessionId: "c",
        parentSessionId: "session",
      },
    });
    payload = projection.getSnapshot().pendingInteractions.at(-1)!.payload;
    if (payload.kind !== "permission") throw new Error("wrong payload");
    expect(payload.fullAccessOption).toBeUndefined();
  });
});
