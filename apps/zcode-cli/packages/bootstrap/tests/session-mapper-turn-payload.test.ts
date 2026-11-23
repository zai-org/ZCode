// Legacy v3 边界：TurnStarted 除独立遥测归因外、TurnSteerQueued 的兼容字段仍透传；
// strict schema 漏声明会让 Host 丢弃整条事件（Bot 收不到 task_run_started，上一轮正文串进下一轮）。
import { describe, expect, it } from "vitest";
import {
  SessionEventType,
  type EventId,
  type SessionEvent,
  type SessionId,
  type TraceId,
  type TurnId,
  type TurnStartedPayloadBase,
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

  // 用 Required<> 列出 CLI 声明的全部字段：CLI 新增字段时这里先编译失败，必须同步 App schema
  // （漏声明会让 strict 校验丢弃整条 turn.started，已发生过四次）。isFirstMessage 由 mapper 移除，
  // 见 session-mapper-legacy-strip.test.ts；App 对它的兼容由下一条直接解析线协议的用例覆盖。
  it("turn.started 映射后的 CLI 全部字段都被 App strict schema 接受", () => {
    const payload: Required<TurnStartedPayloadBase> = {
      isFirstMessage: true,
      inputOrigin: "desktop",
      executionStartedAt: 1_700_000_000_000.5,
      turnNumber: 2,
      input: "hello",
      messageId: "message-1" as TurnStartedPayloadBase["messageId"] & string,
      inputId: "input-1",
      foregroundExecutionId: "execution-1",
      queryId: "query-1" as TurnStartedPayloadBase["queryId"] & string,
      inputSource: "background_task",
      inputVisibility: "user-visible",
      workflowLaunch: { runId: "run-1", toolCallId: "launch-1", name: "Daily" },
      executionKind: "agent",
      epilogueStart: 3,
      originMeta: { backgroundSource: "subagent", workId: "work-1", title: "Agent" },
      backgroundSource: "subagent",
      targetId: "target-1",
      attachments: [{ fileName: "a.png", mime: "image/png", bytes: 1 }],
      intent: { planEnabled: true },
    };

    const mapped = mapSessionEvent(turnEvent(SessionEventType.TurnStarted, { ...payload }));

    expect(zcodeSessionEventSchema.safeParse(mapped).error?.issues ?? []).toEqual([]);
  });

  // 回归（2026-11-17 mac E2E，评审 SG-01）：8172e49580 之后、148827e6dc 之前的 CLI 会把 isFirstMessage
  // 原样发到 turn.started，App strict schema 未声明时整条事件被丢弃（Bot 串轮、运行中摘要 ZodError）。
  // 当前 CLI 已不发送（mapper 移除）；App 仍须接受旧发送方。这里绕过 mapper 直接解析线协议事件，
  // schema 删掉该字段时 true/false 两例会失败。
  it.each([true, false, undefined])("App strict schema 接受旧 CLI 发送的 isFirstMessage=%s", (value) => {
    const wire = mapSessionEvent(
      turnEvent(SessionEventType.TurnStarted, { turnNumber: 1, input: "hello" }),
    ) as { payload: Record<string, unknown> };
    const legacySenderEvent = {
      ...wire,
      payload: { ...wire.payload, ...(value === undefined ? {} : { isFirstMessage: value }) },
    };

    expect(zcodeSessionEventSchema.safeParse(legacySenderEvent).error?.issues ?? []).toEqual([]);
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
