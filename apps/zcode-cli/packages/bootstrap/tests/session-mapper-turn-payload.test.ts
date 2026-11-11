// Legacy v3 边界：TurnStarted / TurnSteerQueued 的 payload 原样透传，strict schema 漏声明任一
// CLI 字段都会让 Host 丢弃整条事件（Bot 收不到 task_run_started，上一轮正文串进下一轮）。
import { describe, expect, it } from "vitest";
import {
  SessionEventType,
  type EventId,
  type SessionEvent,
  type SessionId,
  type TraceId,
  type TurnId,
} from "@zcode/contracts";
import { zcodeSessionEventSchema } from "@zcode/shared";
import { mapSessionEvent } from "../src/zcode-protocol/session-mapper.js";

function turnEvent(type: SessionEventType, payload: Record<string, unknown>): SessionEvent {
  return {
    id: `legacy-${type}` as EventId,
    sessionId: "legacy-session" as SessionId,
    turnId: "turn-1" as TurnId,
    type,
    timestamp: new Date(1_700_000_000_000),
    traceId: "legacy-trace" as TraceId,
    sequenceNumber: 1,
    payload,
  };
}

describe("legacy turn payload 映射", () => {
  it("turn.started 保留 inputOrigin、workflowLaunch 与 epilogueStart", () => {
    const mapped = mapSessionEvent(
      turnEvent(SessionEventType.TurnStarted, {
        turnNumber: 1,
        input: "hello",
        inputId: "input-1",
        inputOrigin: "mobile",
        epilogueStart: 3,
        workflowLaunch: { runId: "run-1", toolCallId: "launch-1", name: "Daily" },
      }),
    );

    expect(zcodeSessionEventSchema.safeParse(mapped).error?.issues ?? []).toEqual([]);
  });

  it("turn.steerQueued 保留 inputPresentation 与 automationId", () => {
    const mapped = mapSessionEvent(
      turnEvent(SessionEventType.TurnSteerQueued, {
        pendingInputId: "pending-1",
        input: "next",
        inputPreview: "next",
        inputSize: 4,
        inputPresentation: "user_steer",
        automationId: "automation-1",
        targetTurnId: "turn-1",
        queueLength: 1,
      }),
    );

    expect(zcodeSessionEventSchema.safeParse(mapped).error?.issues ?? []).toEqual([]);
  });
});
