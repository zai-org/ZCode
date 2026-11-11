// Legacy v1 会话事件的边界（session-mapper.ts）：CLI 事件里后加的字段要在源头剥掉，不能漏进 App 的 strict schema。
// 回归证据（2026-11-06 PLM-JARVIS-2 的运行时证据；示例插件 Jarvis 已迁出到市场仓库，那个 E2E 已删除，
// 这里的测试守住回归）：App 的 readSession(view:"summary") 经 session/events 读事件，整页 safeParse 失败——
// tool.updated(started) 多了 readOnly、sideEffectScope，permission.requested 多了 fullAccessSupported。
// 调用过工具、正在运行的会话因此读不到 executionId，中断不了。
import { describe, expect, it } from "vitest";
import {
  SessionEventType,
  type EventId,
  type SessionEvent,
  type SessionId,
  type ToolCallId,
  type TraceId,
} from "@zcode/contracts";
import { zcodeSessionEventSchema } from "@zcode/shared";
import { mapSessionEvent } from "../src/zcode-protocol/session-mapper.js";

function event(type: SessionEvent["type"], payload: Record<string, unknown>): SessionEvent {
  return {
    id: "legacy-strip-event" as EventId,
    sessionId: "legacy-strip-session" as SessionId,
    type,
    timestamp: new Date(1_700_000_000_000),
    traceId: "legacy-strip-trace" as TraceId,
    sequenceNumber: 1,
    payload,
  } as SessionEvent;
}

describe("legacy 会话事件剥掉后加的字段", () => {
  it("tool.updated(started) 不带 readOnly 与 sideEffectScope，整条事件过 strict schema", () => {
    const mapped = mapSessionEvent(
      event(SessionEventType.ToolCallStarted, {
        toolCallId: "tc-started" as ToolCallId,
        toolName: "ListSessions",
        startedAt: new Date(1_700_000_000_500),
        readOnly: true,
        sideEffectScope: "session",
      }),
    );

    expect(zcodeSessionEventSchema.safeParse(mapped).success).toBe(true);
    expect(mapped.payload).not.toHaveProperty("readOnly");
    expect(mapped.payload).not.toHaveProperty("sideEffectScope");
    expect(mapped.payload).toMatchObject({ kind: "started", toolCallId: "tc-started" });
  });

  it("permission.requested 不带 fullAccessSupported，整条事件过 strict schema", () => {
    const mapped = mapSessionEvent(
      event(SessionEventType.PermissionRequested, {
        requestId: "req-full-access",
        toolCallId: "tc-full-access" as ToolCallId,
        toolName: "SendToSession",
        riskLevel: "medium",
        reason: "sendToSession",
        input: { sessionId: "sess_target", prompt: "hi" },
        fullAccessSupported: true,
      }),
    );

    expect(zcodeSessionEventSchema.safeParse(mapped).success).toBe(true);
    expect(mapped.payload).not.toHaveProperty("fullAccessSupported");
    expect(mapped.payload).toMatchObject({
      toolCallId: "tc-full-access",
      toolName: "SendToSession",
    });
  });
});
