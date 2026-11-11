import { describe, expect, it } from "vitest";
import {
  createSessionId,
  createRootTraceContext,
  SessionEventType,
  type SessionEvent,
} from "@zcode/contracts";
import {
  DELIVERY_PROFILES,
  filterConversationDeltasForProfile,
  conversationSnapshotSchema,
} from "@zcode/shared/zcode-protocol-v4";
import { ProductProjection } from "../src/zcode-protocol-v4/index.js";

describe("guarded continuous/replayable share authoritative pending approval", () => {
  it("keeps once-only options and feedback through both delivery profiles and replay", () => {
    const sessionId = createSessionId("guarded-projection");
    const trace = createRootTraceContext({ sessionId });
    const event = {
      id: "guarded-permission-event",
      sessionId,
      traceId: trace.traceId,
      sequenceNumber: 1,
      timestamp: new Date(),
      type: SessionEventType.PermissionRequested,
      payload: {
        approvalMode: "user-once",
        fullAccessSupported: true,
        requestId: "guarded-request",
        toolCallId: "bash",
        toolName: "Bash",
        riskLevel: "high",
        reason: "Dangerous command",
        input: { command: "rm -rf fixture" },
      },
    } as SessionEvent;
    const live = new ProductProjection(sessionId, "epoch");
    const deltas = live.applyEvent(event);
    for (const profile of [DELIVERY_PROFILES.continuous, DELIVERY_PROFILES.replayable]) {
      expect(filterConversationDeltasForProfile(deltas, profile)).toEqual(deltas);
    }
    const restored = new ProductProjection(sessionId, "epoch");
    restored.applyEvent(event);
    const current = conversationSnapshotSchema.parse(live.getSnapshot());
    const replayed = conversationSnapshotSchema.parse(restored.getSnapshot());
    expect(replayed.pendingInteractions).toEqual(current.pendingInteractions);
    expect(current.pendingInteractions[0]?.payload).toMatchObject({
      kind: "permission",
      freeText: true,
    });
    const payload = current.pendingInteractions[0]!.payload;
    if (payload.kind !== "permission") throw new Error("Expected permission");
    expect(payload.options.map((option) => option.kind)).toEqual(["allowOnce", "deny"]);
    expect(payload.fullAccessOption).toBeUndefined();
    expect(payload.modeSwitch).toBe("fullAccessOnly");
    live.applyEvent({
      ...event,
      id: "resolved" as SessionEvent["id"],
      sequenceNumber: 2,
      type: SessionEventType.PermissionResolved,
      payload: { requestId: "guarded-request", toolCallId: "bash", decision: "deny" },
    });
    expect(live.getSnapshot().pendingInteractions).toEqual([]);
  });
});
