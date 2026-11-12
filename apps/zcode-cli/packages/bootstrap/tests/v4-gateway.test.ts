// ConversationV4Gateway 测试（M3 host 通道层 CLI 侧）。
// 核心断言面：
//   1. subscribe 内部 dispatch result 同时返回 ACK 与待入 outbox 的初始帧
//   2. ingest 后按订阅者 profile.flushWindowMs 定时编码到 host.emitWireFrame（fake timers）
//   3. v4/command：accepted 后台执行 + settle 固化；duplicate 重放终态；
//      sessionNotFound 拒绝；未接线命令 → failed fault.command.notImplemented
//   4. 重订阅替换（R-01）：旧订阅调度状态被清理、不再产帧
//   5. disposeSession / dispose：定时器与 publisher 全量回收
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import type {
  EventId,
  SessionEvent,
  SessionEventType as SessionEventTypeUnion,
  SessionId,
  TraceId,
  TurnId,
} from "@zcode/contracts";
import {
  SessionEventType,
  createMessageId,
  createPartId,
  createProjectId,
  createSessionId,
} from "@zcode/contracts";
import type {
  CommandAck,
  CommandEnvelope,
  CommandKey,
  CommandResult,
  ConversationTopicFrame,
  ConversationTelemetryFact,
  RoutedTopicWireFrame,
  V4ConversationFileChangesResult,
  V4ConversationFileRewindPreviewResult,
} from "@zcode/shared/zcode-protocol-v4";
import {
  DELIVERY_PROFILES,
  PROTOCOL_V4_LIMITS,
  utf8JsonByteLength,
} from "@zcode/shared/zcode-protocol-v4";
import {
  ConversationTopicPublisher,
  ConversationV4Gateway,
  PROJECTION_TERMINAL_RESERVE_BYTES,
  type CommandInbox,
  V4CommandNotImplementedError,
} from "../src/zcode-protocol-v4/index.js";
import type { SessionConfigSeed } from "../src/zcode-protocol-v4/index.js";
import { V4CommandExecutor } from "../src/zcode-protocol-v4/commands/executor.js";
import type { V4SessionRecordView } from "../src/zcode-protocol-v4/commands/types.js";
import { loadPersistentCommandFacts } from "../src/zcode-protocol-v4/persistent-command-facts.js";
import { registerCommittedForkBestEffort } from "../src/zcode-protocol/v4-bridge.js";

// ── 事件构造（与 conversation-topic-publisher.test.ts 同一套）──

class EventLog {
  private seq = 0;
  readonly events: SessionEvent[] = [];

  constructor(private readonly sessionId = "session-1") {}

  push(
    type: SessionEventTypeUnion,
    payload: unknown,
    opts: { turnId?: string } = {},
  ): SessionEvent {
    this.seq += 1;
    const event: SessionEvent = {
      id: `event-${this.seq}` as EventId,
      sessionId: this.sessionId as SessionId,
      turnId: opts.turnId as TurnId | undefined,
      type,
      timestamp: new Date(1_700_000_000_000 + this.seq * 1000),
      traceId: "trace-1" as TraceId,
      sequenceNumber: this.seq,
      payload,
    };
    this.events.push(event);
    return event;
  }
}

function sessionCreated(log: EventLog): SessionEvent {
  return log.push(SessionEventType.SessionCreated, {
    mode: "default",
    contextWindow: 200_000,
  });
}

function textDelta(log: EventLog, text: string): SessionEvent {
  return log.push(
    SessionEventType.ModelStreaming,
    { kind: "text_delta", delta: text, done: false },
    { turnId: "turn-1" },
  );
}

// ── 宿主打桩 ──

interface HostStub {
  frames: ConversationTopicFrame[];
  telemetryFacts: ConversationTelemetryFact[];
  executed: CommandEnvelope[];
  errors: Array<{ scope: string; error: unknown }>;
  sessions: Set<string>;
  executeImpl: (
    envelope: CommandEnvelope,
    admission?: { admissionSeq: number; admittedAt: number; queueItemId: string },
  ) => Promise<CommandResult | undefined>;
  /** hydration 打桩：sessionId → 持久化事件序列。 */
  persistedEvents: Map<string, SessionEvent[]>;
  /** 标记哪些 session 的 loadPersistedEvents 走 transcript 合成（synthesized=true）。 */
  synthesizedSessions: Set<string>;
  loadPersistedEventsImpl?: (sessionId: string) => Promise<{
    events: SessionEvent[];
    synthesized: boolean;
    sourceEventSeq?: number;
  }>;
  /** R-19 config 种子打桩：sessionId → runtime 真值（缺省 = 钩子返回 null）。 */
  configSeeds: Map<string, SessionConfigSeed>;
  memorySettings?: Map<string, boolean>;
  fileChangeCalls: Array<{ sessionId: string; targetRowId: number; messageIds: string[] }>;
  fileChangesResult: V4ConversationFileChangesResult;
  fileRewindPreviewCalls: Array<{ sessionId: string; targetRowId: number; messageIds: string[] }>;
  fileRewindPreviewResult: V4ConversationFileRewindPreviewResult;
  persistentCommands: Record<
    "transcript" | "timeline" | "child" | "discarded",
    Map<string, CommandAck>
  >;
  inputAdmissions: Array<{ commandId: string; queueItemId: string }>;
  inputCancellations: Array<{ commandId: string; queueItemId: string; reason: string }>;
  resumeCalls: string[];
  resumeOutcome: "resumed" | "notFound";
  projectionTerminations: Array<{ sessionId: string; reasonCode: string }>;
  projectionEvents: Array<{ sessionId: string; event: SessionEvent }>;
}

function makeHost(): HostStub {
  return {
    frames: [],
    telemetryFacts: [],
    executed: [],
    errors: [],
    sessions: new Set(["session-1"]),
    executeImpl: async () => undefined,
    persistedEvents: new Map(),
    synthesizedSessions: new Set(),
    configSeeds: new Map(),
    fileChangeCalls: [],
    fileChangesResult: { files: 0, additions: 0, deletions: 0, items: [] },
    fileRewindPreviewCalls: [],
    fileRewindPreviewResult: {
      canApply: false,
      safeFiles: [],
      unsafeFiles: [],
      ignoredFiles: [],
    },
    persistentCommands: {
      transcript: new Map(),
      timeline: new Map(),
      child: new Map(),
      discarded: new Map(),
    },
    inputAdmissions: [],
    inputCancellations: [],
    resumeCalls: [],
    resumeOutcome: "notFound",
    projectionTerminations: [],
    projectionEvents: [],
  };
}

function makeGateway(host: HostStub): ConversationV4Gateway {
  return new ConversationV4Gateway(
    {
      sessionExists: (sessionId) => host.sessions.has(sessionId),
      resumePersistedSession: async (sessionId) => {
        host.resumeCalls.push(sessionId);
        if (host.resumeOutcome === "resumed") host.sessions.add(sessionId);
        return { status: host.resumeOutcome };
      },
      emitWireFrame: (wire) => collectCompleteConversationFrame(host.frames, wire),
      emitConversationTelemetryFact: (fact) => host.telemetryFacts.push(fact),
      onTargetCompleted: (sessionId, event) => {
        host.projectionEvents.push({ sessionId, event });
      },
      executeCommand: async (envelope, admission) => {
        host.executed.push(envelope);
        return await host.executeImpl(envelope, admission);
      },
      admitCommandInput: async (envelope, admission) => {
        if (envelope.type !== "sendText" && envelope.type !== "sendGoalCommand") return null;
        host.inputAdmissions.push({
          commandId: envelope.commandId,
          queueItemId: admission.queueItemId,
        });
        const payload = envelope.payload as { text: string; attachments?: never[] };
        return {
          sourceCommandId: envelope.commandId,
          queueItemId: admission.queueItemId,
          clientId: envelope.clientId,
          kind: envelope.type,
          text: payload.text,
          attachments: payload.attachments ?? [],
          delivery: { requested: "startNow", admitted: "startNow" },
          order: { admissionSeq: admission.admissionSeq },
          steer: { state: "notRequested" },
          dispatch: { state: "admitted" },
          admittedAt: admission.admittedAt,
        };
      },
      cancelCommandInput: async (envelope, queueItemId, reason) => {
        host.inputCancellations.push({ commandId: envelope.commandId, queueItemId, reason });
      },
      terminateTurnForProjectionFault: (sessionId, reasonCode) => {
        host.projectionTerminations.push({ sessionId, reasonCode });
      },
      loadPersistedEvents: async (sessionId) =>
        host.loadPersistedEventsImpl?.(sessionId) ?? {
          events: host.persistedEvents.get(sessionId) ?? [],
          synthesized: host.synthesizedSessions.has(sessionId),
        },
      getSessionConfigSeed: (sessionId) => host.configSeeds.get(sessionId) ?? null,
      getSessionMemoryEnabled: (sessionId) => host.memorySettings?.get(sessionId),
      getConversationFileChanges: async (sessionId, targetRowId, messageIds) => {
        host.fileChangeCalls.push({ sessionId, targetRowId, messageIds });
        return host.fileChangesResult;
      },
      previewConversationFileRewind: async (sessionId, targetRowId, messageIds) => {
        host.fileRewindPreviewCalls.push({ sessionId, targetRowId, messageIds });
        return host.fileRewindPreviewResult;
      },
      lookupTranscriptCommand: (key: CommandKey) =>
        host.persistentCommands.transcript.get(`${key.sessionId ?? "@global"}\0${key.commandId}`) ??
        null,
      lookupTimelineCommand: (key: CommandKey) =>
        host.persistentCommands.timeline.get(`${key.sessionId ?? "@global"}\0${key.commandId}`) ??
        null,
      lookupChildCommand: (key: CommandKey) =>
        host.persistentCommands.child.get(`${key.sessionId ?? "@global"}\0${key.commandId}`) ??
        null,
      lookupDiscardedCommand: (key: CommandKey) =>
        host.persistentCommands.discarded.get(`${key.sessionId ?? "@global"}\0${key.commandId}`) ??
        null,
      onError: (scope, error) => host.errors.push({ scope, error }),
    },
    { now: () => 1_700_000_999_000, createLogEpoch: () => "epoch-1" },
  );
}

function collectCompleteConversationFrame(
  frames: ConversationTopicFrame[],
  wire: RoutedTopicWireFrame,
): void {
  if (wire.kind !== "complete" || !wire.topic.startsWith("conversation/")) {
    throw new Error("gateway test adapter only accepts complete conversation wires");
  }
  frames.push(wire.frame as ConversationTopicFrame);
}

function subscribeParams(overrides: Record<string, unknown> = {}) {
  return {
    topic: "conversation/session-1",
    connectionId: "conn-1",
    clientMode: "desktop-continuous",
    ...overrides,
  };
}

function commandParams(overrides: Record<string, unknown> = {}) {
  return {
    commandId: "cmd-1",
    clientId: "client-1",
    sessionId: "session-1",
    type: "sendText",
    payload: { text: "你好" },
    issuedAt: 1_700_000_000_000,
    ...overrides,
  };
}

const CONTINUOUS_WINDOW = DELIVERY_PROFILES.continuous.flushWindowMs;
const REPLAYABLE_WINDOW = DELIVERY_PROFILES.replayable.flushWindowMs;

describe("订阅与帧调度", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("raw cache slims request history without changing live events or sequence continuity", async () => {
    const gateway = makeGateway(makeHost());
    const log = new EventLog();
    gateway.ingest("session-1", sessionCreated(log));
    const request = log.push(SessionEventType.ModelRequest, {
      messages: [{ role: "user", content: "history" }],
      providerId: "fixture",
      modelId: "model",
    });
    gateway.ingest("session-1", request);
    gateway.ingest(
      "session-1",
      log.push(
        SessionEventType.TurnStarted,
        { turnNumber: 1, input: "next", inputId: "input" },
        { turnId: "turn-1" },
      ),
    );
    const states = (
      gateway as unknown as {
        rawSequenceStates: Map<
          string,
          {
            recentRawEventsById: Map<string, SessionEvent>;
            sourceEventSeq: number;
          }
        >;
      }
    ).rawSequenceStates;
    const state = states.get("session-1")!;
    expect(state.recentRawEventsById.get(String(request.id))).toEqual({
      ...request,
      payload: { providerId: "fixture", modelId: "model", messageCount: 1 },
    });
    expect(request.payload).toHaveProperty("messages");
    expect(state.sourceEventSeq).toBe(3);
    expect((await gateway.subscribe(subscribeParams())).ack.mode).toBe("snapshot");
    gateway.dispose();
  });

  it("subscribe 内部 dispatch result 携带待入 outbox 的 snapshot 初始帧", async () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const log = new EventLog();
    gateway.ingest("session-1", sessionCreated(log));

    const result = await gateway.subscribe(subscribeParams());
    expect(result.ack.mode).toBe("snapshot");
    expect(result.initialFrame?.payload.kind).toBe("snapshot");
    // 初始帧只进入 server 内部 dispatch result，不走 online notification 出口。
    expect(host.frames).toHaveLength(0);
  });

  it("只从 live ingest 发送 telemetry fact，并按 eventId 有界入口去重", () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const log = new EventLog();
    gateway.ingest("session-1", sessionCreated(log));
    const started = log.push(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: "不可进入 fact 的正文", inputId: "command-1" },
      { turnId: "turn-1" },
    );
    gateway.ingest("session-1", started);
    gateway.ingest("session-1", started);

    expect(host.telemetryFacts).toEqual([
      expect.objectContaining({
        kind: "turn.started",
        eventId: String(started.id),
        sourceCommandId: "command-1",
      }),
    ]);
    expect(JSON.stringify(host.telemetryFacts)).not.toContain("不可进入 fact 的正文");
  });

  it.each([
    {
      detailKind: "command",
      toolName: "Bash",
      perf: {
        totalMs: 130,
        permissionWaitMs: 20,
        detail: {
          kind: "command",
          command: {
            runMs: 100,
            firstOutputMs: 10,
            noOutputMs: 0,
            exitCode: 0,
            timedOut: false,
            outputBytes: 64,
            category: "git",
            name: "git",
            count: 1,
            status: "completed",
            hash: "0123456789abcdef",
          },
        },
      },
      expected: {
        totalMs: 130,
        permissionWaitMs: 20,
        commandRunMs: 100,
        firstOutputMs: 10,
        noOutputMs: 0,
        exitCode: 0,
        timedOut: false,
        outputBytes: 64,
        commandCategory: "git",
        commandName: "git",
        commandCount: 1,
        commandStatus: "completed",
      },
    },
    {
      detailKind: "filesystem",
      toolName: "Write",
      perf: {
        totalMs: 80,
        detail: {
          kind: "filesystem",
          filesystem: {
            readMs: 5,
            writeMs: 60,
            fileCount: 1,
            totalBytes: 256,
            maxFileBytes: 256,
            workspaceKind: "local",
          },
        },
      },
      expected: {
        totalMs: 80,
        fsReadMs: 5,
        fsWriteMs: 60,
        fileCount: 1,
        totalBytes: 256,
        maxFileBytes: 256,
        workspaceKind: "local",
      },
    },
    {
      detailKind: "patch",
      toolName: "Edit",
      perf: {
        totalMs: 90,
        detail: {
          kind: "patch",
          filesystem: {
            readMs: 6,
            writeMs: 20,
            fileCount: 1,
            totalBytes: 512,
            maxFileBytes: 512,
            workspaceKind: "remote",
          },
          patch: { matchMs: 12, hunkCount: 2, matchAttempts: 3 },
        },
      },
      expected: {
        totalMs: 90,
        fsReadMs: 6,
        fsWriteMs: 20,
        fileCount: 1,
        totalBytes: 512,
        maxFileBytes: 512,
        workspaceKind: "remote",
        patchMatchMs: 12,
        hunkCount: 2,
        matchAttempts: 3,
      },
    },
    {
      detailKind: "common-only",
      toolName: "Read",
      perf: { totalMs: 40, permissionWaitMs: 7 },
      expected: { totalMs: 40, permissionWaitMs: 7 },
    },
  ])("将 $detailKind runtime perf 映射为扁平工具终态 fact", ({ toolName, perf, expected }) => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const log = new EventLog();
    gateway.ingest("session-1", sessionCreated(log));
    gateway.ingest(
      "session-1",
      log.push(
        SessionEventType.TurnStarted,
        { turnNumber: 1, input: "private prompt", inputId: "command-1" },
        { turnId: "turn-1" },
      ),
    );
    gateway.ingest(
      "session-1",
      log.push(
        SessionEventType.ToolCallScheduled,
        {
          toolCallId: "tool-1",
          toolName,
          input: { private: "must-not-leak" },
          schedule: { parallelGroups: [["tool-1"]], executionOrder: ["tool-1"] },
        },
        { turnId: "turn-1" },
      ),
    );
    gateway.ingest(
      "session-1",
      log.push(
        SessionEventType.ToolCallResult,
        {
          toolCallId: "tool-1",
          duration: 123,
          result: { success: true, content: "private tool output", perf },
        },
        { turnId: "turn-1" },
      ),
    );

    const terminalFact = host.telemetryFacts.find(
      (fact) =>
        fact.kind === "tool.lifecycle" &&
        fact.toolCallId === "tool-1" &&
        fact.phase === "completed",
    );
    expect(terminalFact).toMatchObject({
      kind: "tool.lifecycle",
      phase: "completed",
      toolName,
      durationMs: 123,
      performance: expected,
    });
    const serializedPerformance = JSON.stringify(
      terminalFact?.kind === "tool.lifecycle" ? terminalFact.performance : undefined,
    );
    expect(serializedPerformance).not.toContain("detail");
    expect(serializedPerformance).not.toContain("hash");
    expect(serializedPerformance).not.toContain("commandHash");
    expect(host.errors.filter((entry) => entry.scope === "v4.telemetry.normalize")).toEqual([]);
  });

  it("失败 ToolCallResult 同样保留扁平 performance 与错误事实", () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const log = new EventLog();
    gateway.ingest("session-1", sessionCreated(log));
    gateway.ingest(
      "session-1",
      log.push(
        SessionEventType.TurnStarted,
        { turnNumber: 1, input: "private prompt", inputId: "command-1" },
        { turnId: "turn-1" },
      ),
    );
    gateway.ingest(
      "session-1",
      log.push(
        SessionEventType.ToolCallScheduled,
        {
          toolCallId: "tool-1",
          toolName: "Bash",
          input: { command: "private command" },
          schedule: { parallelGroups: [["tool-1"]], executionOrder: ["tool-1"] },
        },
        { turnId: "turn-1" },
      ),
    );
    gateway.ingest(
      "session-1",
      log.push(
        SessionEventType.ToolCallResult,
        {
          toolCallId: "tool-1",
          duration: 50,
          result: {
            success: false,
            content: "private failure output",
            error: { type: "ToolExecutionFailed", code: "EXIT_2", message: "exit 2" },
            perf: {
              totalMs: 70,
              detail: {
                kind: "command",
                command: { runMs: 50, exitCode: 2, status: "failed" },
              },
            },
          },
        },
        { turnId: "turn-1" },
      ),
    );

    expect(host.telemetryFacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "tool.lifecycle",
          phase: "failed",
          toolName: "Bash",
          durationMs: 50,
          errorCode: "EXIT_2",
          errorMessage: "exit 2",
          performance: {
            totalMs: 70,
            commandRunMs: 50,
            exitCode: 2,
            commandStatus: "failed",
          },
        }),
      ]),
    );
    expect(host.errors.filter((entry) => entry.scope === "v4.telemetry.normalize")).toEqual([]);
  });

  it("automation admission 与 CronCreate 成功结果只透传稳定关联 ID", () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const log = new EventLog();
    gateway.ingest(
      "session-1",
      log.push(
        SessionEventType.TurnStarted,
        {
          turnNumber: 1,
          input: "定时任务正文不能进入 fact",
          inputId: "automation-1:1700000000000",
          automationId: "automation-1",
        },
        { turnId: "turn-automation" },
      ),
    );
    gateway.ingest(
      "session-1",
      log.push(
        SessionEventType.ToolCallScheduled,
        {
          toolCallId: "tool-cron",
          toolName: "CronCreate",
          schedule: { parallelGroups: [], executionOrder: [] },
        },
        { turnId: "turn-automation" },
      ),
    );
    gateway.ingest(
      "session-1",
      log.push(
        SessionEventType.ToolCallResult,
        {
          toolCallId: "tool-cron",
          duration: 10,
          result: {
            success: true,
            content: JSON.stringify({
              automation: { automationId: "automation-created", prompt: "不能透传" },
            }),
          },
        },
        { turnId: "turn-automation" },
      ),
    );

    expect(host.telemetryFacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "turn.started",
          automationId: "automation-1",
          taskTrigger: "schedule",
          scheduledAt: 1_700_000_000_000,
        }),
        expect.objectContaining({
          kind: "tool.lifecycle",
          phase: "completed",
          toolName: "CronCreate",
          automationId: "automation-created",
        }),
      ]),
    );
    expect(JSON.stringify(host.telemetryFacts)).not.toContain("定时任务正文");
    expect(JSON.stringify(host.telemetryFacts)).not.toContain("不能透传");
  });

  it.each([{ skill: "requested-skill" }, { name: "legacy-skill" }])(
    "Skill 调度不提取任何请求名称: %#",
    (input) => {
      const host = makeHost();
      const gateway = makeGateway(host);
      const log = new EventLog();
      gateway.ingest("session-1", sessionCreated(log));
      gateway.ingest(
        "session-1",
        log.push(
          SessionEventType.ToolCallScheduled,
          {
            toolCallId: "tool-skill-request",
            toolName: "Skill",
            input: { ...input, args: "private-arguments" },
            schedule: { parallelGroups: [], executionOrder: [] },
          },
          { turnId: "turn-skill" },
        ),
      );
      const fact = host.telemetryFacts.find((fact) => fact.kind === "tool.lifecycle");
      expect(fact).toMatchObject({ toolName: "Skill", phase: "scheduled" });
      expect(fact).not.toHaveProperty("skillName");
      expect(JSON.stringify(host.telemetryFacts)).not.toContain("private-arguments");
      const name = "skill" in input ? input.skill : input.name;
      if (typeof name === "string") expect(JSON.stringify(host.telemetryFacts)).not.toContain(name);
    },
  );

  it.each(["/Users/FAKE_USER/private", "demo\nsecret", "sk-" + "a".repeat(49), "a".repeat(5000)])(
    "Skill 已解析 metadata 仍需名称校验: %#",
    (name) => {
      const host = makeHost();
      const gateway = makeGateway(host);
      const log = new EventLog();
      gateway.ingest("session-1", sessionCreated(log));
      gateway.ingest(
        "session-1",
        log.push(
          SessionEventType.ToolCallScheduled,
          {
            toolCallId: "skill-private",
            toolName: "Skill",
            input: { skill: "demo" },
            schedule: { parallelGroups: [], executionOrder: [] },
          },
          { turnId: "turn-skill" },
        ),
      );
      gateway.ingest(
        "session-1",
        log.push(
          SessionEventType.ToolCallResult,
          {
            toolCallId: "skill-private",
            duration: 10,
            skillMetadata: { name, source: "zcode" },
            result: { success: true, content: "not-for-telemetry" },
          },
          { turnId: "turn-skill" },
        ),
      );
      expect(
        host.telemetryFacts.find(
          (fact) => fact.kind === "tool.lifecycle" && fact.phase === "completed",
        ),
      ).toMatchObject({ skillName: "unknown", skillSource: "zcode" });
      expect(JSON.stringify(host.telemetryFacts)).not.toContain(name);
    },
  );

  it("Skill tool result 只透传受限 metadata", () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const log = new EventLog();
    gateway.ingest("session-1", sessionCreated(log));
    gateway.ingest(
      "session-1",
      log.push(
        SessionEventType.ToolCallScheduled,
        {
          toolCallId: "tool-skill",
          toolName: "Skill",
          input: { skill: "document-skills:pptx", args: "" },
          schedule: { parallelGroups: [], executionOrder: [] },
        },
        { turnId: "turn-skill" },
      ),
    );
    gateway.ingest(
      "session-1",
      log.push(
        SessionEventType.ToolCallResult,
        {
          toolCallId: "tool-skill",
          duration: 10,
          skillMetadata: {
            name: "pptx",
            qualifiedName: "document-skills:pptx",
            pluginId: "document-skills@zcode-plugins-official",
            source: "plugin",
          },
          result: { success: true, content: "<skill_content>正文不进入 fact</skill_content>" },
        },
        { turnId: "turn-skill" },
      ),
    );

    const skillFact = host.telemetryFacts.find(
      (fact) => fact.kind === "tool.lifecycle" && fact.phase === "completed",
    );
    expect(skillFact).toMatchObject({
      toolName: "Skill",
      skillName: "pptx",
      skillQualifiedName: "document-skills:pptx",
      skillPluginId: "document-skills@zcode-plugins-official",
      skillSource: "plugin",
    });
    expect(JSON.stringify(host.telemetryFacts)).not.toContain("正文不进入 fact");
  });

  it("Skill tool error 保留已解析的 metadata", () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const log = new EventLog();
    gateway.ingest("session-1", sessionCreated(log));
    gateway.ingest(
      "session-1",
      log.push(
        SessionEventType.ToolCallScheduled,
        {
          toolCallId: "tool-skill-error",
          toolName: "Skill",
          input: { skill: "document-skills:pptx", args: "" },
          schedule: { parallelGroups: [], executionOrder: [] },
        },
        { turnId: "turn-skill-error" },
      ),
    );
    gateway.ingest(
      "session-1",
      log.push(
        SessionEventType.ToolCallError,
        {
          toolCallId: "tool-skill-error",
          skillMetadata: {
            name: "pptx",
            qualifiedName: "document-skills:pptx",
            pluginId: "document-skills@zcode-plugins-official",
            source: "plugin",
          },
          error: { type: "SERIALIZATION_ERROR", message: "post hook failed" },
        },
        { turnId: "turn-skill-error" },
      ),
    );

    expect(host.telemetryFacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "tool.lifecycle",
          phase: "failed",
          toolName: "Skill",
          skillName: "pptx",
          skillQualifiedName: "document-skills:pptx",
          skillPluginId: "document-skills@zcode-plugins-official",
          skillSource: "plugin",
        }),
      ]),
    );
  });

  it("Off-Peak TurnStarted 只透传稳定 task attribution，不透传正文", () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const log = new EventLog();
    gateway.ingest("session-1", sessionCreated(log));
    gateway.ingest(
      "session-1",
      log.push(
        SessionEventType.TurnStarted,
        {
          turnNumber: 1,
          input: "闲时任务 prompt 不能进入 fact",
          inputId: "message-offpeak-run-1",
          offPeakTaskId: "offpeak-stable-1",
          offPeakRunType: "init",
        },
        { turnId: "turn-offpeak" },
      ),
    );

    expect(host.telemetryFacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "turn.started",
          sourceCommandId: "message-offpeak-run-1",
          offPeakTaskId: "offpeak-stable-1",
          offPeakRunType: "init",
        }),
      ]),
    );
    expect(JSON.stringify(host.telemetryFacts)).not.toContain("闲时任务 prompt 不能进入 fact");
  });

  it("manual run 无调度字段；非 runId 输入与 CronCreate 解析失败只降级不误标", () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const log = new EventLog();
    gateway.ingest(
      "session-1",
      log.push(
        SessionEventType.TurnStarted,
        {
          turnNumber: 1,
          input: "manual 正文",
          inputId: "automation-1:manual:run-1",
          automationId: "automation-1",
        },
        { turnId: "turn-manual" },
      ),
    );
    gateway.ingest(
      "session-1",
      log.push(
        SessionEventType.TurnStarted,
        {
          turnNumber: 2,
          input: "普通输入",
          inputId: "cmd-1700000000000",
          automationId: "automation-2",
        },
        { turnId: "turn-mismatch" },
      ),
    );
    gateway.ingest(
      "session-1",
      log.push(
        SessionEventType.ToolCallScheduled,
        {
          toolCallId: "tool-cron-bad",
          toolName: "CronCreate",
          schedule: { parallelGroups: [], executionOrder: [] },
        },
        { turnId: "turn-manual" },
      ),
    );
    gateway.ingest(
      "session-1",
      log.push(
        SessionEventType.ToolCallResult,
        {
          toolCallId: "tool-cron-bad",
          duration: 10,
          result: { success: true, content: "created (not json)" },
        },
        { turnId: "turn-manual" },
      ),
    );

    const manualStart = host.telemetryFacts.find(
      (fact) =>
        fact.kind === "turn.started" && fact.sourceCommandId === "automation-1:manual:run-1",
    );
    expect(manualStart).toMatchObject({ automationId: "automation-1", taskTrigger: "manual" });
    expect(manualStart).not.toHaveProperty("scheduledAt");

    // inputId 不是该 automation 的 runId：只保留关联 ID，不猜触发方式，也不切出伪 scheduledAt。
    const mismatchStart = host.telemetryFacts.find(
      (fact) => fact.kind === "turn.started" && fact.sourceCommandId === "cmd-1700000000000",
    );
    expect(mismatchStart).toMatchObject({ automationId: "automation-2" });
    expect(mismatchStart).not.toHaveProperty("taskTrigger");
    expect(mismatchStart).not.toHaveProperty("scheduledAt");

    const cronResult = host.telemetryFacts.find(
      (fact) => fact.kind === "tool.lifecycle" && fact.phase === "completed",
    );
    expect(cronResult).toMatchObject({ toolName: "CronCreate" });
    expect(cronResult).not.toHaveProperty("automationId");
  });

  it("model request fact 只保留 URL 解析后的 hostname", () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const log = new EventLog();
    const network = log.push(
      SessionEventType.ModelNetworkStatus,
      {
        type: "model_request_started",
        timestamp: "2026-07-17T00:00:00.000Z",
        traceId: "trace-1",
        requestId: "request-1",
        providerId: "provider-1",
        modelId: "model-1",
        baseURL: "https://user:secret@example.com/private/path?token=secret#fragment",
        transport: "sse",
        attempt: 1,
        maxAttempts: 3,
        requestHeaders: { authorization: "Bearer secret" },
        responseHeaders: { "set-cookie": "secret" },
      },
      { turnId: "turn-1" },
    );

    gateway.ingest("session-1", network);

    expect(host.telemetryFacts).toEqual([
      expect.objectContaining({
        kind: "model.request.status",
        providerHostname: "example.com",
      }),
    ]);
    const serialized = JSON.stringify(host.telemetryFacts);
    expect(serialized).not.toContain("private/path");
    expect(serialized).not.toContain("token=secret");
    expect(serialized).not.toContain("authorization");
    expect(serialized).not.toContain("set-cookie");

    const failed = log.push(
      SessionEventType.ModelNetworkStatus,
      {
        type: "model_request_failed",
        timestamp: "2026-07-17T00:00:01.000Z",
        traceId: "trace-1",
        requestId: "request-1",
        providerId: "provider-1",
        modelId: "model-1",
        baseURL: "https://example.com/v1/messages",
        transport: "sse",
        attempt: 1,
        maxAttempts: 3,
        durationMs: 10,
        reason: "server_error",
        retryable: true,
        message: "上游响应正文不能穿过 fact",
        statusCode: 503,
      },
      { turnId: "turn-1" },
    );
    gateway.ingest("session-1", failed);
    expect(JSON.stringify(host.telemetryFacts)).not.toContain("上游响应正文不能穿过 fact");
  });

  it("准入等待的两端不产出 model.request.status fact，也不让 schema 抛出（v3 决策 44）", () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const log = new EventLog();
    const base = {
      timestamp: "2026-09-08T00:00:00.000Z",
      traceId: "trace-1",
      requestId: "request-q",
      model: { providerId: "provider-1", modelId: "model-1" },
      transport: "sse",
      attempt: 1,
      maxAttempts: 0,
    };
    gateway.ingest(
      "session-1",
      log.push(
        SessionEventType.ModelNetworkStatus,
        { ...base, type: "model_request_queued" },
        { turnId: "turn-1" },
      ),
    );
    gateway.ingest(
      "session-1",
      log.push(
        SessionEventType.ModelNetworkStatus,
        { ...base, type: "model_request_admitted", queuedMs: 800 },
        { turnId: "turn-1" },
      ),
    );
    expect(host.telemetryFacts.filter((fact) => fact.kind === "model.request.status")).toEqual([]);
  });

  it("usage fact 的 totalTokens fallback 与 contracts 公式一致，不重复加 reasoning", () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const log = new EventLog();
    gateway.ingest(
      "session-1",
      log.push(
        SessionEventType.ModelComplete,
        {
          content: "done",
          stopReason: "stop",
          querySource: "main_turn",
          usage: {
            inputTokens: 10,
            outputTokens: 4,
            reasoningTokens: 3,
            cacheReadTokens: 2,
            cacheWriteTokens: 1,
          },
        },
        { turnId: "turn-1" },
      ),
    );
    expect(host.telemetryFacts).toEqual([
      expect.objectContaining({
        kind: "usage.delta",
        totalTokens: 14,
        reasoningTokens: 3,
      }),
    ]);
  });

  it("usage fact 不把标题 sidecar、compact 或 tool_internal 累加到 prompt", () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const log = new EventLog();
    for (const [querySource, stopReason] of [
      ["session_title", "end_turn"],
      ["compact", "end_turn"],
    ] as const) {
      gateway.ingest(
        "session-1",
        log.push(
          SessionEventType.ModelComplete,
          {
            content: "sidecar private content",
            ...(querySource ? { querySource } : {}),
            stopReason,
            usage: { inputTokens: 64, outputTokens: 8 },
          },
          { turnId: "turn-1" },
        ),
      );
    }

    for (const requestId of ["request-tool-internal", "request-main"]) {
      gateway.ingest(
        "session-1",
        log.push(
          SessionEventType.ModelNetworkStatus,
          {
            type: "model_request_completed",
            timestamp: "2026-07-24T00:00:00.000Z",
            traceId: `trace-${requestId}`,
            requestId,
            providerId: "provider-1",
            modelId: "model-1",
            baseURL: "https://example.com/v1/messages",
            transport: "sse",
            attempt: 1,
            maxAttempts: 1,
            durationMs: 20,
          },
          { turnId: "turn-1" },
        ),
      );
      gateway.ingest(
        "session-1",
        log.push(
          SessionEventType.ModelComplete,
          {
            content: "private content",
            stopReason: requestId === "request-tool-internal" ? "tool_internal" : "stop",
            usage: { inputTokens: 64, outputTokens: 8 },
          },
          { turnId: "turn-1" },
        ),
      );
    }

    expect(host.telemetryFacts.filter((fact) => fact.kind === "usage.delta")).toEqual([
      expect.objectContaining({
        requestId: "request-main",
        totalTokens: 72,
      }),
    ]);
  });

  it("main/subagent ModelComplete 关联最近完成 request 的真实模型与 usage", () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const mainLog = new EventLog("session-1");
    gateway.ingest(
      "session-1",
      mainLog.push(
        SessionEventType.ModelNetworkStatus,
        {
          type: "model_request_completed",
          timestamp: "2026-07-24T00:00:00.000Z",
          traceId: "trace-main",
          requestId: "request-main",
          providerId: "main-provider",
          modelId: "main-model",
          baseURL: "https://main.example.com/v1/messages?secret=1",
          transport: "sse",
          querySource: "main_turn",
          attempt: 1,
          maxAttempts: 1,
          durationMs: 20,
        },
        { turnId: "turn-main" },
      ),
    );
    gateway.ingest(
      "session-1",
      mainLog.push(
        SessionEventType.ModelComplete,
        {
          content: "main private content",
          stopReason: "stop",
          querySource: "main_turn",
          usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
        },
        { turnId: "turn-main" },
      ),
    );

    const childLog = new EventLog("child-session");
    gateway.ingestDetachedLiveSession(
      "child-session",
      childLog.push(
        SessionEventType.ModelNetworkStatus,
        {
          type: "model_request_completed",
          timestamp: "2026-07-24T00:00:01.000Z",
          traceId: "trace-child",
          requestId: "request-child",
          providerId: "child-provider",
          modelId: "child-model",
          baseURL: "https://child.example.com/v1/messages?secret=1",
          transport: "sse",
          querySource: "subagent",
          attempt: 1,
          maxAttempts: 1,
          durationMs: 30,
        },
        { turnId: "turn-child" },
      ),
    );
    gateway.ingestDetachedLiveSession(
      "child-session",
      childLog.push(
        SessionEventType.ModelComplete,
        {
          content: "child private content",
          stopReason: "stop",
          querySource: "subagent",
          usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
        },
        { turnId: "turn-child" },
      ),
    );

    expect(host.telemetryFacts.filter((fact) => fact.kind === "usage.delta")).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        requestId: "request-main",
        providerId: "main-provider",
        modelId: "main-model",
        providerHostname: "main.example.com",
        totalTokens: 14,
      }),
      expect.objectContaining({
        sessionId: "child-session",
        requestId: "request-child",
        providerId: "child-provider",
        modelId: "child-model",
        providerHostname: "child.example.com",
        totalTokens: 25,
      }),
    ]);
    expect(JSON.stringify(host.telemetryFacts)).not.toContain("private content");
    expect(JSON.stringify(host.telemetryFacts)).not.toContain("secret=1");
  });

  it("SubagentSpawned/Stopped 只透传父子关联和 background 状态", () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const log = new EventLog();
    gateway.ingest(
      "session-1",
      log.push(
        SessionEventType.TurnStarted,
        { inputId: "command-1", input: "private prompt" },
        { turnId: "turn-1" },
      ),
    );
    gateway.ingest(
      "session-1",
      log.push(
        SessionEventType.SubagentSpawned,
        {
          agentId: "agent-1",
          agentType: "explore",
          childSessionId: "child-session-1",
          parentToolCallId: "tool-agent-1",
          background: false,
          status: "running",
          prompt: "private child prompt",
        },
        { turnId: "turn-1" },
      ),
    );
    gateway.ingest(
      "session-1",
      log.push(
        SessionEventType.SubagentStopped,
        {
          agentId: "agent-1",
          agentType: "explore",
          childSessionId: "child-session-1",
          parentToolCallId: "tool-agent-1",
          background: false,
          status: "completed",
          output: "private child output",
        },
        { turnId: "turn-1" },
      ),
    );

    expect(host.telemetryFacts.filter((fact) => fact.kind === "subagent.lifecycle")).toEqual([
      expect.objectContaining({
        phase: "spawned",
        sourceCommandId: "command-1",
        childSessionId: "child-session-1",
        parentToolCallId: "tool-agent-1",
        background: false,
      }),
      expect.objectContaining({
        phase: "stopped",
        sourceCommandId: "command-1",
        childSessionId: "child-session-1",
        background: false,
      }),
    ]);
    expect(JSON.stringify(host.telemetryFacts)).not.toContain("private child");
  });

  it("background stopped fact 保留既有 Runtime 错误但不透传结果正文", () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const log = new EventLog();
    gateway.ingest(
      "session-1",
      log.push(SessionEventType.SubagentStopped, {
        agentId: "agent-bg",
        childSessionId: "child-bg",
        parentToolCallId: "tool-bg",
        background: true,
        status: "failed",
        error: "provider returned 429",
        output: "private child output",
      }),
    );
    expect(host.telemetryFacts).toEqual([
      expect.objectContaining({
        kind: "subagent.lifecycle",
        phase: "stopped",
        background: true,
        status: "failed",
        errorMessage: "provider returned 429",
      }),
    ]);
    expect(JSON.stringify(host.telemetryFacts)).not.toContain("private child output");
  });

  it("镜像 Subagent 工具从 payload 顶层透传 agent_id 与 child 关联", () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const log = new EventLog("parent-session");
    gateway.ingest(
      "parent-session",
      log.push(
        SessionEventType.TurnStarted,
        { inputId: "parent-command", input: "private prompt" },
        { turnId: "parent-turn" },
      ),
    );
    const relation = {
      agentId: "agent-child",
      agentType: "Explore",
      childSessionId: "child-session",
      childToolCallId: "toolu-child",
      parentToolCallId: "call-parent-agent",
      source: "subagent",
      background: true,
    };
    gateway.ingest(
      "parent-session",
      log.push(
        SessionEventType.ToolCallScheduled,
        {
          toolCallId: "tool_subagent_agent-child_toolu-child",
          toolName: "WebFetch",
          input: { secret: "must-not-leak" },
          schedule: { parallelGroups: [], executionOrder: [] },
          ...relation,
        },
        { turnId: "parent-turn" },
      ),
    );
    gateway.ingest(
      "parent-session",
      log.push(
        SessionEventType.ToolCallResult,
        {
          toolCallId: "tool_subagent_agent-child_toolu-child",
          duration: 42,
          result: { success: true, content: "private child tool output" },
          ...relation,
        },
        { turnId: "parent-turn" },
      ),
    );

    const toolFacts = host.telemetryFacts.filter(
      (fact) => fact.kind === "tool.lifecycle" && fact.toolName === "WebFetch",
    );
    expect(toolFacts).toEqual([
      expect.objectContaining({
        phase: "scheduled",
        agentId: "agent-child",
        childSessionId: "child-session",
        childToolCallId: "toolu-child",
        parentToolCallId: "call-parent-agent",
        background: true,
      }),
      expect.objectContaining({
        phase: "completed",
        agentId: "agent-child",
        childSessionId: "child-session",
        childToolCallId: "toolu-child",
        parentToolCallId: "call-parent-agent",
        background: true,
      }),
    ]);
    expect(JSON.stringify(toolFacts)).not.toContain("must-not-leak");
    expect(JSON.stringify(toolFacts)).not.toContain("private child tool output");
  });

  it("stream fact 保留 parentToolCallId 供主对话统计排除子代理正文", () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const log = new EventLog();
    gateway.ingest(
      "session-1",
      log.push(
        SessionEventType.ModelStreaming,
        {
          kind: "text_delta",
          delta: "child private content",
          done: false,
          parentToolCallId: "parent-agent-tool",
        },
        { turnId: "turn-1" },
      ),
    );
    expect(host.telemetryFacts).toEqual([
      expect.objectContaining({
        kind: "stream.chunk",
        chunkLength: 21,
        parentToolCallId: "parent-agent-tool",
      }),
    ]);
    expect(JSON.stringify(host.telemetryFacts)).not.toContain("child private content");
  });

  it("cancelled turn fact 保留旧 user interrupt 固定错误字段", () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const log = new EventLog();
    gateway.ingest(
      "session-1",
      log.push(
        SessionEventType.TurnComplete,
        {
          resultType: "cancelled",
          response: "",
          duration: 10,
          tokenCount: 0,
          toolCallCount: 0,
        },
        { turnId: "turn-1" },
      ),
    );
    expect(host.telemetryFacts).toEqual([
      expect.objectContaining({
        kind: "turn.terminal",
        status: "interrupted",
        errorCode: "USER_INTERRUPT",
        errorMessage: "User stopped generation",
      }),
    ]);
  });

  it("turn terminal fact 保留 active-loop 消费的 subagent 来源标记", () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const log = new EventLog();
    gateway.ingest(
      "session-1",
      log.push(
        SessionEventType.TurnComplete,
        {
          resultType: "success",
          response: "",
          duration: 10,
          tokenCount: 0,
          toolCallCount: 0,
          backgroundSubagentResultConsumed: true,
        },
        { turnId: "turn-1" },
      ),
    );
    expect(host.telemetryFacts).toEqual([
      expect.objectContaining({
        kind: "turn.terminal",
        backgroundSubagentResultConsumed: true,
      }),
    ]);
  });

  it("turn error fact 保留 active-loop 消费的 subagent 来源标记", () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const log = new EventLog();
    gateway.ingest(
      "session-1",
      log.push(
        SessionEventType.TurnError,
        {
          error: { type: "MODEL_ERROR", message: "failed" },
          turnPhase: "regular_turn_loop",
          backgroundSubagentResultConsumed: true,
        },
        { turnId: "turn-1" },
      ),
    );
    expect(host.telemetryFacts).toEqual([
      expect.objectContaining({
        kind: "turn.terminal",
        backgroundSubagentResultConsumed: true,
      }),
    ]);
  });

  it("compact terminal 在尚无 network status 时回落 session config 模型", () => {
    const host = makeHost();
    host.configSeeds.set("session-1", {
      provider: "provider-from-config",
      model: "model-from-config",
    });
    const gateway = makeGateway(host);
    const log = new EventLog();
    const compact = log.push(SessionEventType.CompactFailed, {
      operationId: "compact-1",
      messageId: "compact-message-1",
      status: "failed",
      trigger: "manual",
      reason: "api_error",
      attempt: 1,
      startedAt: 100,
      endedAt: 200,
    });

    gateway.ingest("session-1", compact);

    expect(host.telemetryFacts).toEqual([
      expect.objectContaining({
        kind: "compaction.terminal",
        modelName: "model-from-config",
        modelProvider: "provider-from-config",
      }),
    ]);
  });

  it("persisted hydration 与 initial snapshot 不产生 telemetry fact", async () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const log = new EventLog();
    host.persistedEvents.set("session-1", [
      sessionCreated(log),
      log.push(
        SessionEventType.TurnStarted,
        { turnNumber: 1, input: "历史正文", inputId: "historical-command" },
        { turnId: "turn-history" },
      ),
    ]);

    await gateway.subscribe(subscribeParams());
    expect(host.telemetryFacts).toEqual([]);
  });

  it("hydration await 窗口里的真实 live event 只发一次 fact", async () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const log = new EventLog();
    const created = sessionCreated(log);
    let releaseLoad!: () => void;
    let loadStarted = false;
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    host.loadPersistedEventsImpl = async () => {
      loadStarted = true;
      await loadGate;
      return { events: [created], synthesized: false, sourceEventSeq: created.sequenceNumber };
    };

    const subscribing = gateway.subscribe(subscribeParams());
    await vi.waitFor(() => expect(loadStarted).toBe(true));
    const live = log.push(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: "live", inputId: "live-command" },
      { turnId: "turn-live" },
    );
    gateway.ingest("session-1", live);
    releaseLoad();
    await subscribing;

    expect(host.telemetryFacts).toHaveLength(1);
    expect(host.telemetryFacts[0]).toMatchObject({
      kind: "turn.started",
      eventId: String(live.id),
      sourceCommandId: "live-command",
    });
  });

  it("subscribes an existing live child publisher without cold-resuming a second runtime", async () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const childLog = new EventLog("child-session");
    gateway.ingestDetachedLiveSession("child-session", sessionCreated(childLog));

    const subscribed = await gateway.subscribe(
      subscribeParams({ topic: "conversation/child-session" }),
    );
    expect(subscribed.initialFrame).toMatchObject({
      toSeq: 1,
      payload: { kind: "snapshot" },
    });
    expect(host.resumeCalls).toEqual([]);

    gateway.ingestDetachedLiveSession("child-session", textDelta(childLog, "live child delta"));
    vi.advanceTimersByTime(CONTINUOUS_WINDOW);
    expect(host.frames.at(-1)).toMatchObject({
      toSeq: 2,
      payload: { kind: "deltas" },
    });
    expect(host.resumeCalls).toEqual([]);
  });

  it("cold-resumes and hydrates a completed child when no live publisher remains", async () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const childLog = new EventLog("completed-child");
    host.resumeOutcome = "resumed";
    host.persistedEvents.set("completed-child", [sessionCreated(childLog)]);

    const subscribed = await gateway.subscribe(
      subscribeParams({ topic: "conversation/completed-child" }),
    );

    expect(host.resumeCalls).toEqual(["completed-child"]);
    expect(subscribed.initialFrame).toMatchObject({
      toSeq: 1,
      payload: { kind: "snapshot" },
    });
  });

  it("plans query cold-resumes and hydrates the same authoritative branch", async () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const sessionId = "completed-plan-session";
    const log = new EventLog(sessionId);
    const turnId = "turn-plan";
    sessionCreated(log);
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "写计划" }, { turnId });
    log.push(
      SessionEventType.ModelStreaming,
      {
        kind: "tool_input_start",
        delta: "",
        done: false,
        toolCallId: "cold-plan",
        toolName: "ExitPlanMode",
      },
      { turnId },
    );
    log.push(
      SessionEventType.ToolCallScheduled,
      {
        toolCallId: "cold-plan",
        toolName: "ExitPlanMode",
        input: { plan: "# 冷恢复计划" },
        schedule: { parallelGroups: [["cold-plan"]], executionOrder: ["cold-plan"] },
      },
      { turnId },
    );
    log.push(
      SessionEventType.ToolCallResult,
      {
        toolCallId: "cold-plan",
        result: { success: true, content: "done" },
        duration: 10,
      },
      { turnId },
    );
    log.push(
      SessionEventType.TurnComplete,
      {
        response: "",
        tokenCount: 0,
        toolCallCount: 1,
        duration: 20,
        resultType: "success",
      },
      { turnId },
    );
    host.resumeOutcome = "resumed";
    host.persistedEvents.set(sessionId, log.events);

    const result = await gateway.plans({ sessionId });

    expect(host.resumeCalls).toEqual([sessionId]);
    expect(result.plans).toMatchObject([
      {
        toolCallId: "cold-plan",
        toolName: "ExitPlanMode",
        status: "success",
      },
    ]);
    expect(result.atLogEpoch).toBeTruthy();
  });

  it("does not treat an unregistered orphan publisher as a live child", async () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const orphanLog = new EventLog("orphan-session");
    host.resumeOutcome = "resumed";
    gateway.ingest("orphan-session", sessionCreated(orphanLog));

    await gateway.subscribe(subscribeParams({ topic: "conversation/orphan-session" }));

    expect(host.resumeCalls).toEqual(["orphan-session"]);
  });

  it("same-sub resync 保留 owner/subId 并按客户端 base 生成 recovery dispatch", async () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const log = new EventLog();
    gateway.ingest("session-1", sessionCreated(log));
    const subscribed = await gateway.subscribe(subscribeParams({ connectionId: "mobile" }));
    gateway.ingest("session-1", textDelta(log, "after-base"));

    const recovered = await gateway.resyncReserved({
      topic: "conversation/session-1",
      connectionId: "mobile",
      subscriptionId: subscribed.ack.subscriptionId,
      base: { logEpoch: subscribed.ack.logEpoch, seq: 1 },
    });
    expect(recovered.ack).toEqual({
      subscriptionId: subscribed.ack.subscriptionId,
      mode: "resume",
      logEpoch: subscribed.ack.logEpoch,
    });
    expect(recovered.initialFrame).toMatchObject({
      subscriptionId: subscribed.ack.subscriptionId,
      fromSeq: 1,
      toSeq: 2,
      payload: { kind: "deltas" },
    });
    expect(recovered.commit()).toBe(true);

    expect(() =>
      gateway.resyncReserved({
        topic: "conversation/session-1",
        connectionId: "forged",
        subscriptionId: subscribed.ack.subscriptionId,
        base: null,
      }),
    ).toThrow("fault.subscription.notOwned");
  });

  it("conversation recovery timer 在 control commit 前触发后，无新 ingest 也会重新 flush", async () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const log = new EventLog();
    gateway.ingest("session-1", sessionCreated(log));
    const subscribed = await gateway.subscribe(subscribeParams());
    const recovery = gateway.resyncReserved({
      topic: "conversation/session-1",
      connectionId: "conn-1",
      subscriptionId: subscribed.ack.subscriptionId,
      base: { logEpoch: subscribed.ack.logEpoch, seq: 1 },
    });

    gateway.ingest(
      "session-1",
      log.push(SessionEventType.SessionTitleUpdated, {
        previousTitle: "",
        source: "custom",
        title: "during-recovery",
      }),
    );
    // timer 已消费，但 control reservation 仍要等 ACK/outbox 全部 admission，不能抢发。
    vi.advanceTimersByTime(CONTINUOUS_WINDOW);
    expect(host.frames).toEqual([]);

    expect(recovery.commit()).toBe(true);
    // commit 必须重新驱动残留 buffer；这里刻意不再 ingest。
    vi.advanceTimersByTime(CONTINUOUS_WINDOW);
    expect(host.frames).toHaveLength(1);
    expect(host.frames[0]).toMatchObject({
      fromSeq: 1,
      toSeq: 2,
      payload: { kind: "deltas" },
    });
  });

  it("initial physical encode 失败会回滚 conversation subscription 与 flush state", async () => {
    const host = makeHost();
    host.configSeeds.set("session-1", {
      provider: "provider",
      model: "x".repeat(17 * 1024 * 1024),
      thought: "high",
      mode: "default",
    });
    const gateway = makeGateway(host);
    const log = new EventLog();
    gateway.ingest("session-1", sessionCreated(log));

    await expect(gateway.subscribeReserved(subscribeParams())).rejects.toThrow(
      "proto.frameAssemblyTooLarge",
    );
    const internals = gateway as unknown as {
      flushStates: Map<unknown, unknown>;
      publishers: Map<string, { subscriptions: Map<unknown, unknown> }>;
    };
    expect(internals.flushStates.size).toBe(0);
    expect(internals.publishers.get("session-1")?.subscriptions.size).toBe(0);
  });

  it("resync physical encode 失败不 admission，旧 online buffer 可继续 flush 后再重试", async () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const log = new EventLog();
    gateway.ingest("session-1", sessionCreated(log));
    const subscribed = await gateway.subscribe(subscribeParams());
    gateway.ingest(
      "session-1",
      log.push(SessionEventType.SessionTitleUpdated, {
        title: "small-online-delta",
        source: "custom",
      }),
    );
    const publisher = (
      gateway as unknown as {
        publishers: Map<
          string,
          { seedConfig(seed: SessionConfigSeed): void; hasSubscription(id: string): boolean }
        >;
      }
    ).publishers.get("session-1")!;
    publisher.seedConfig({
      provider: "provider",
      model: "x".repeat(17 * 1024 * 1024),
      thought: "high",
      mode: "default",
    });

    expect(() =>
      gateway.resyncReserved({
        topic: "conversation/session-1",
        connectionId: "conn-1",
        subscriptionId: subscribed.ack.subscriptionId,
        base: null,
        forceSnapshot: true,
      }),
    ).toThrow("proto.frameAssemblyTooLarge");
    expect(host.frames).toEqual([]);
    expect(publisher.hasSubscription(subscribed.ack.subscriptionId)).toBe(true);

    vi.advanceTimersByTime(CONTINUOUS_WINDOW);
    expect(host.frames).toHaveLength(1);
    expect(host.frames[0]).toMatchObject({
      subscriptionId: subscribed.ack.subscriptionId,
      payload: { kind: "deltas" },
    });

    publisher.seedConfig({
      provider: "provider",
      model: "small",
      thought: "high",
      mode: "default",
    });
    const retry = gateway.resyncReserved({
      topic: "conversation/session-1",
      connectionId: "conn-1",
      subscriptionId: subscribed.ack.subscriptionId,
      base: null,
      forceSnapshot: true,
    });
    expect(retry.ack.subscriptionId).toBe(subscribed.ack.subscriptionId);
    expect(retry.commit()).toBe(true);
  });

  it("oversize structural event 在 ingest 原子拒绝，re-subscribe 返回最后可传输 snapshot", async () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const log = new EventLog();
    gateway.ingest("session-1", sessionCreated(log));
    const first = await gateway.subscribe(subscribeParams());
    gateway.ingest(
      "session-1",
      log.push(SessionEventType.SessionTitleUpdated, {
        title: "x".repeat(17 * 1024 * 1024),
        source: "custom",
      }),
    );

    const retry = await gateway.subscribeReserved(subscribeParams());
    expect(retry.initialFrame?.payload).toMatchObject({
      kind: "snapshot",
      snapshot: { meta: { title: "" } },
    });
    const internals = gateway as unknown as {
      flushStates: Map<unknown, { subscriptionId: string }>;
      publishers: Map<
        string,
        { hasSubscription(subscriptionId: string, connectionId?: string): boolean }
      >;
    };
    expect(
      internals.publishers.get("session-1")?.hasSubscription(first.ack.subscriptionId, "conn-1"),
    ).toBe(false);
    expect([...internals.flushStates.values()].map((state) => state.subscriptionId)).toEqual([
      retry.ack.subscriptionId,
    ]);
  });

  it("ingest 后按 flushWindowMs 合并打到 physical wire，帧区间无缝衔接", async () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const log = new EventLog();
    gateway.ingest("session-1", sessionCreated(log));
    const { initialFrame: initial } = await gateway.subscribe(subscribeParams());

    gateway.ingest(
      "session-1",
      log.push(
        SessionEventType.TurnStarted,
        { turnNumber: 1, input: "任务 1" },
        { turnId: "turn-1" },
      ),
    );
    gateway.ingest("session-1", textDelta(log, "上半"));
    gateway.ingest("session-1", textDelta(log, " 下半"));
    // 窗口未到不产帧。
    expect(host.frames).toHaveLength(0);

    vi.advanceTimersByTime(CONTINUOUS_WINDOW);
    // 三个事件合并成一帧，fromSeq 接住 snapshot 帧的 toSeq。
    expect(host.frames).toHaveLength(1);
    expect(host.frames[0]!.fromSeq).toBe(initial!.toSeq);
    expect(host.frames[0]!.toSeq).toBe(4);

    // 后续 ingest 重新开窗。
    gateway.ingest("session-1", textDelta(log, "尾巴"));
    vi.advanceTimersByTime(CONTINUOUS_WINDOW);
    expect(host.frames).toHaveLength(2);
    expect(host.frames[1]!.fromSeq).toBe(host.frames[0]!.toSeq);
  });

  it("host clientMode 固定 desktop continuous / mobile replayable 调度边界", async () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const log = new EventLog();
    gateway.ingest("session-1", sessionCreated(log));
    const desktop = await gateway.subscribe(subscribeParams({ connectionId: "desktop-a" }));
    const mobile = await gateway.subscribe(
      subscribeParams({
        connectionId: "mobile-b",
        clientMode: "web-remote-replayable",
      }),
    );

    gateway.ingest("session-1", textDelta(log, "跨端"));
    vi.advanceTimersByTime(CONTINUOUS_WINDOW);
    expect(host.frames.map((frame) => frame.subscriptionId)).toEqual([desktop.ack.subscriptionId]);
    vi.advanceTimersByTime(REPLAYABLE_WINDOW - CONTINUOUS_WINDOW);
    expect(host.frames.map((frame) => frame.subscriptionId)).toEqual([
      desktop.ack.subscriptionId,
      mobile.ack.subscriptionId,
    ]);
  });

  it("saturated mobile pauses only its connection and drained catches up immediately", async () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const log = new EventLog();
    gateway.ingest("session-1", sessionCreated(log));
    const desktop = await gateway.subscribe(
      subscribeParams({ connectionId: "desktop-a", clientMode: "desktop-continuous" }),
    );
    const mobile = await gateway.subscribe(
      subscribeParams({
        connectionId: "mobile-b",
        clientMode: "web-remote-replayable",
      }),
    );

    gateway.setConnectionFlowState({ connectionId: "mobile-b", state: "saturated" });
    gateway.ingest("session-1", textDelta(log, "while-mobile-paused"));
    vi.advanceTimersByTime(REPLAYABLE_WINDOW);

    expect(host.frames.map((frame) => frame.subscriptionId)).toEqual([desktop.ack.subscriptionId]);

    gateway.setConnectionFlowState({ connectionId: "mobile-b", state: "drained" });
    expect(host.frames.map((frame) => frame.subscriptionId)).toEqual([
      desktop.ack.subscriptionId,
      mobile.ack.subscriptionId,
    ]);
    expect(host.frames[1]).toMatchObject({
      fromSeq: 1,
      toSeq: 2,
      payload: { kind: "deltas" },
    });
  });

  it("saturated clears an already scheduled timer and closed clears pause state", async () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const log = new EventLog();
    gateway.ingest("session-1", sessionCreated(log));
    await gateway.subscribe(
      subscribeParams({
        connectionId: "mobile-race",
        clientMode: "web-remote-replayable",
      }),
    );

    gateway.ingest("session-1", textDelta(log, "scheduled"));
    gateway.setConnectionFlowState({ connectionId: "mobile-race", state: "saturated" });
    vi.advanceTimersByTime(REPLAYABLE_WINDOW * 2);
    expect(host.frames).toEqual([]);

    gateway.setConnectionFlowState({ connectionId: "mobile-race", state: "closed" });
    const paused = (gateway as unknown as { pausedConnections: Set<string> }).pausedConnections;
    expect(paused.has("mobile-race")).toBe(false);
  });

  it("paused mobile overflow recovers with one latest snapshot while desktop keeps draining", async () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const log = new EventLog();
    gateway.ingest("session-1", sessionCreated(log));
    const desktop = await gateway.subscribe(
      subscribeParams({ connectionId: "desktop-overflow", clientMode: "desktop-continuous" }),
    );
    const mobile = await gateway.subscribe(
      subscribeParams({
        connectionId: "mobile-overflow",
        clientMode: "web-remote-replayable",
      }),
    );
    gateway.setConnectionFlowState({ connectionId: "mobile-overflow", state: "saturated" });

    for (let index = 0; index < 501; index += 1) {
      gateway.ingest(
        "session-1",
        log.push(
          SessionEventType.TurnStarted,
          { turnNumber: index + 1, input: `queued-${index}` },
          { turnId: `turn-overflow-${index}` },
        ),
      );
      vi.advanceTimersByTime(CONTINUOUS_WINDOW);
    }

    const desktopFrames = host.frames.filter(
      (frame) => frame.subscriptionId === desktop.ack.subscriptionId,
    );
    expect(desktopFrames.length).toBeGreaterThan(0);
    expect(
      host.frames.filter((frame) => frame.subscriptionId === mobile.ack.subscriptionId),
    ).toEqual([]);

    gateway.setConnectionFlowState({ connectionId: "mobile-overflow", state: "drained" });
    const mobileFrames = host.frames.filter(
      (frame) => frame.subscriptionId === mobile.ack.subscriptionId,
    );
    expect(mobileFrames).toHaveLength(1);
    expect(mobileFrames[0]).toMatchObject({
      fromSeq: 0,
      payload: { kind: "snapshot" },
    });
  });

  it("非法 topic / 未知会话拒绝订阅", async () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    await expect(gateway.subscribe(subscribeParams({ topic: "bogus" }))).rejects.toThrow(
      /Unsupported topic/,
    );
    await expect(
      gateway.subscribe(subscribeParams({ topic: "conversation/ghost" })),
    ).rejects.toThrow(/not active/);
  });

  it("重订阅替换（R-01）：旧订阅停止产帧且调度状态被清理", async () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const log = new EventLog();
    gateway.ingest("session-1", sessionCreated(log));

    const first = await gateway.subscribe(subscribeParams());
    const second = await gateway.subscribe(subscribeParams());
    expect(second.ack.subscriptionId).not.toBe(first.ack.subscriptionId);
    // 旧订阅的调度状态已清（flushNow 找不到），新订阅正常。
    expect(gateway.flushNow(first.ack.subscriptionId)).toBeNull();

    gateway.ingest("session-1", textDelta(log, "x"));
    vi.advanceTimersByTime(CONTINUOUS_WINDOW);
    expect(host.frames).toHaveLength(1);
    expect(host.frames[0]!.subscriptionId).toBe(second.ack.subscriptionId);
  });

  it("unsubscribe 后不再产帧", async () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const log = new EventLog();
    gateway.ingest("session-1", sessionCreated(log));
    const { ack } = await gateway.subscribe(subscribeParams());

    gateway.unsubscribe({
      topic: "conversation/session-1",
      subscriptionId: ack.subscriptionId,
      connectionId: "conn-1",
    });
    gateway.ingest("session-1", textDelta(log, "x"));
    vi.advanceTimersByTime(CONTINUOUS_WINDOW * 4);
    expect(host.frames).toHaveLength(0);
  });

  it("相同裸 subscriptionId 的不同 topic/connection 只退订精确 route", async () => {
    const host = makeHost();
    host.sessions.add("session-2");
    const gateway = makeGateway(host);
    const firstLog = new EventLog("session-1");
    const secondLog = new EventLog("session-2");
    gateway.ingest("session-1", sessionCreated(firstLog));
    gateway.ingest("session-2", sessionCreated(secondLog));
    const first = await gateway.subscribe(
      subscribeParams({
        topic: "conversation/session-1",
        connectionId: "conn-1",
      }),
    );
    const second = await gateway.subscribe(
      subscribeParams({
        topic: "conversation/session-2",
        connectionId: "conn-2",
      }),
    );
    expect(first.ack.subscriptionId).toBe(second.ack.subscriptionId);

    gateway.unsubscribe({
      topic: "conversation/session-1",
      subscriptionId: first.ack.subscriptionId,
      connectionId: "conn-1",
    });
    gateway.ingest("session-1", textDelta(firstLog, "first"));
    gateway.ingest("session-2", textDelta(secondLog, "second"));
    vi.advanceTimersByTime(CONTINUOUS_WINDOW);

    expect(host.frames).toHaveLength(1);
    expect(host.frames[0]).toMatchObject({
      topic: "conversation/session-2",
      subscriptionId: second.ack.subscriptionId,
    });
  });

  it("disposeSession 清理全部订阅与 publisher；重订阅走冷启动 snapshot", async () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const log = new EventLog();
    gateway.ingest("session-1", sessionCreated(log));
    await gateway.subscribe(subscribeParams());
    gateway.ingest("session-1", textDelta(log, "x"));

    gateway.disposeSession("session-1");
    vi.advanceTimersByTime(CONTINUOUS_WINDOW * 4);
    expect(host.frames).toHaveLength(0);

    // 新 publisher 冷启动：seq 从 0 开始（旧事件日志已随 dispose 丢弃）。
    const again = await gateway.subscribe(subscribeParams());
    expect(again.initialFrame?.toSeq).toBe(0);
  });

  // ── M4 hydration：冷订阅从持久化事件重建投影（fork child / resume / 重启）──
  it("冷订阅无 live projection 的会话 → 重放持久化事件，snapshot 含历史 rows", async () => {
    const host = makeHost();
    // 构造一段持久化历史：SessionCreated + turn + assistant 文本。
    const persistLog = new EventLog("session-cold");
    host.sessions.add("session-cold");
    persistLog.push(SessionEventType.SessionCreated, {
      mode: "default",
      contextWindow: 200_000,
    });
    persistLog.push(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: "历史输入" },
      { turnId: "turn-1" },
    );
    persistLog.push(
      SessionEventType.ModelStreaming,
      { kind: "text_start", delta: "", done: false },
      { turnId: "turn-1" },
    );
    persistLog.push(
      SessionEventType.ModelStreaming,
      { kind: "text_delta", delta: "历史回复", done: false },
      { turnId: "turn-1" },
    );
    persistLog.push(
      SessionEventType.ModelStreaming,
      { kind: "text_end", delta: "", done: false },
      { turnId: "turn-1" },
    );
    host.persistedEvents.set("session-cold", persistLog.events);

    const gateway = makeGateway(host);
    // 从未 ingest 过 session-cold（冷）——subscribe 触发 hydration。
    const result = await gateway.subscribe(subscribeParams({ topic: "conversation/session-cold" }));
    expect(result.initialFrame?.payload.kind).toBe("snapshot");
    const snapshot =
      result.initialFrame?.payload.kind === "snapshot"
        ? result.initialFrame.payload.snapshot
        : null;
    const texts = snapshot?.rows.window.map((row) =>
      row.kind === "userInput" || row.kind === "assistantText" ? row.text : "",
    );
    expect(texts).toContain("历史输入");
    expect(texts).toContain("历史回复");
    // 冷订阅 seq 已推进到持久化尾部。
    expect(result.initialFrame?.toSeq).toBe(persistLog.events.length);
  });

  it("synthesized=true：cold publisher（fork resume ingest 抢先建）→ 重建含 transcript 历史", async () => {
    const host = makeHost();
    host.sessions.add("session-fork");
    host.synthesizedSessions.add("session-fork");
    // 模拟 fork resume 的 ingest 抢先建了个只含 fork 事件的 cold publisher（无 user 轮）。
    const gateway = makeGateway(host);
    const forkLog = new EventLog("session-fork");
    gateway.ingest("session-fork", {
      ...forkLog.push(SessionEventType.SessionCreated, {
        mode: "default",
        contextWindow: 200_000,
      }),
    });
    // transcript 合成的历史事件（loadPersistedEvents 返回，synthesized=true）。
    const synthLog = new EventLog("session-fork");
    synthLog.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    synthLog.push(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: "继承历史" },
      { turnId: "t1" },
    );
    synthLog.push(
      SessionEventType.ModelStreaming,
      { kind: "text_delta", delta: "继承回复", done: false },
      { turnId: "t1" },
    );
    synthLog.push(
      SessionEventType.ModelStreaming,
      { kind: "text_end", delta: "", done: false },
      { turnId: "t1" },
    );
    host.persistedEvents.set("session-fork", synthLog.events);

    const result = await gateway.subscribe(subscribeParams({ topic: "conversation/session-fork" }));
    const texts = (
      result.initialFrame?.payload.kind === "snapshot"
        ? result.initialFrame.payload.snapshot.rows.window
        : []
    )
      .filter((r) => r.kind === "userInput" || r.kind === "assistantText")
      .map((r) => (r.kind === "userInput" || r.kind === "assistantText" ? r.text : ""));
    // cold publisher 被丢弃重建 → transcript 历史进投影。
    expect(texts).toContain("继承历史");
    expect(texts).toContain("继承回复");
  });

  it("synthesized rehydrate keeps existing subscription ownership", async () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const rawLog = new EventLog("session-1");
    gateway.ingest(
      "session-1",
      rawLog.push(SessionEventType.SessionCreated, {
        mode: "default",
        contextWindow: 200_000,
      }),
    );

    const persisted = new EventLog("session-1");
    persisted.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    persisted.push(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: "persisted question", messageId: "persisted-user" },
      { turnId: "persisted-turn" },
    );
    persisted.push(
      SessionEventType.ModelStreaming,
      {
        kind: "text_start",
        delta: "",
        done: false,
        assistantMessageId: "persisted-assistant",
      },
      { turnId: "persisted-turn" },
    );
    persisted.push(
      SessionEventType.ModelStreaming,
      {
        kind: "text_delta",
        delta: "persisted answer",
        done: false,
        assistantMessageId: "persisted-assistant",
      },
      { turnId: "persisted-turn" },
    );
    persisted.push(
      SessionEventType.TurnComplete,
      { response: "", tokenCount: 0, toolCallCount: 0, duration: 1, resultType: "success" },
      { turnId: "persisted-turn" },
    );

    let loadCount = 0;
    host.loadPersistedEventsImpl = async () => {
      loadCount += 1;
      return loadCount === 1
        ? { events: [], synthesized: false, sourceEventSeq: 1 }
        : { events: persisted.events, synthesized: true, sourceEventSeq: 2 };
    };
    const first = await gateway.subscribe(subscribeParams({ connectionId: "conn-1" }));

    // 非 running publisher 拒收正文后必须以 persisted source 重物化；该路径过去
    // delete/replace publisher，导致 conn-1 的 subscription registry 一并丢失。
    gateway.ingest(
      "session-1",
      rawLog.push(
        SessionEventType.ModelStreaming,
        {
          kind: "text_delta",
          delta: "missed live content",
          done: false,
          assistantMessageId: "missed-assistant",
        },
        { turnId: "missed-turn" },
      ),
    );
    host.frames.length = 0;
    const second = await gateway.subscribe(subscribeParams({ connectionId: "conn-2" }));
    const secondRows =
      second.initialFrame?.payload.kind === "snapshot"
        ? second.initialFrame.payload.snapshot.rows.window
        : [];
    expect(
      secondRows.some((row) => row.kind === "assistantText" && row.text === "persisted answer"),
    ).toBe(true);
    expect(host.frames).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ subscriptionId: first.ack.subscriptionId }),
      ]),
    );

    host.frames.length = 0;
    const titleChanged = rawLog.push(SessionEventType.SessionTitleUpdated, {
      previousTitle: "old",
      title: "new",
      source: "custom",
    });
    gateway.ingest("session-1", { ...titleChanged, id: "raw-title-changed" as EventId });
    vi.advanceTimersByTime(CONTINUOUS_WINDOW);
    expect(host.frames).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ subscriptionId: first.ack.subscriptionId }),
      ]),
    );
  });

  it("首次 cold hydration 等待期间到达的 live queue/stream 不丢失，后续 topic seq 仍单调", async () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const rawLog = new EventLog("session-race");
    host.sessions.add("session-race");
    gateway.ingest(
      "session-race",
      rawLog.push(SessionEventType.SessionCreated, {
        mode: "default",
        contextWindow: 200_000,
      }),
    );

    let resolveLoad:
      | ((value: { events: SessionEvent[]; synthesized: boolean; sourceEventSeq?: number }) => void)
      | undefined;
    const loadStarted = vi.fn();
    host.loadPersistedEventsImpl = async () => {
      loadStarted();
      return await new Promise((resolve) => {
        resolveLoad = resolve;
      });
    };

    const subscribing = gateway.subscribe(subscribeParams({ topic: "conversation/session-race" }));
    await vi.waitFor(() => expect(loadStarted).toHaveBeenCalledTimes(1));
    const secondSubscribing = gateway.subscribe(
      subscribeParams({ topic: "conversation/session-race", connectionId: "conn-2" }),
    );
    expect(loadStarted).toHaveBeenCalledTimes(1);

    gateway.ingest(
      "session-race",
      rawLog.push(SessionEventType.TurnSteerQueued, {
        pendingInputId: "queue-live",
        intent: {
          sourceCommandId: "cmd-live",
          queueItemId: "queue-live",
          clientId: "client-live",
          kind: "sendText",
          text: "等待期间排队",
          attachments: [],
          delivery: { requested: "queue", admitted: "queue" },
          order: { admissionSeq: 1, queuePosition: 0 },
          steer: { state: "notRequested" },
          dispatch: { state: "queued" },
          admittedAt: 1_700_000_001_000,
        },
      }),
    );
    gateway.ingest(
      "session-race",
      rawLog.push(
        SessionEventType.TurnStarted,
        { turnNumber: 2, input: "等待期间运行", messageId: "msg-live-user" },
        { turnId: "turn-live" },
      ),
    );
    gateway.ingest(
      "session-race",
      rawLog.push(
        SessionEventType.ModelStreaming,
        { kind: "text_start", delta: "", done: false, messageId: "msg-live-assistant" },
        { turnId: "turn-live" },
      ),
    );
    gateway.ingest(
      "session-race",
      rawLog.push(
        SessionEventType.ModelStreaming,
        { kind: "text_delta", delta: "live-1", done: false, messageId: "msg-live-assistant" },
        { turnId: "turn-live" },
      ),
    );

    const synthesizedLog = new EventLog("session-race");
    synthesizedLog.push(SessionEventType.SessionCreated, {
      mode: "default",
      contextWindow: 200_000,
    });
    synthesizedLog.push(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: "历史输入", messageId: "msg-history-user" },
      { turnId: "turn-history" },
    );
    synthesizedLog.push(
      SessionEventType.ModelStreaming,
      { kind: "text_start", delta: "", done: false, messageId: "msg-history-assistant" },
      { turnId: "turn-history" },
    );
    synthesizedLog.push(
      SessionEventType.ModelStreaming,
      { kind: "text_delta", delta: "历史回复", done: false, messageId: "msg-history-assistant" },
      { turnId: "turn-history" },
    );
    synthesizedLog.push(
      SessionEventType.ModelStreaming,
      { kind: "text_end", delta: "", done: false, messageId: "msg-history-assistant" },
      { turnId: "turn-history" },
    );
    resolveLoad?.({
      events: synthesizedLog.events.map((event, index) => ({
        ...event,
        id: `hydrate-race-${index + 1}` as EventId,
      })),
      synthesized: true,
      // memory eventStore 在 load 开始时只看到了 SessionCreated；后四条是 await 窗口内 live。
      sourceEventSeq: 1,
    });

    const subscribed = await subscribing;
    const secondSubscribed = await secondSubscribing;
    expect(secondSubscribed.initialFrame?.toSeq).toBe(subscribed.initialFrame?.toSeq);
    const snapshot =
      subscribed.initialFrame?.payload.kind === "snapshot"
        ? subscribed.initialFrame.payload.snapshot
        : null;
    expect(snapshot?.queue.items.map((item) => item.queueItemId)).toContain("queue-live");
    expect(
      snapshot?.rows.window.filter((row) => row.kind === "assistantText").map((row) => row.text),
    ).toEqual(expect.arrayContaining(["历史回复", "live-1"]));

    const initialSeq = subscribed.initialFrame?.toSeq ?? -1;
    gateway.ingest(
      "session-race",
      rawLog.push(
        SessionEventType.ModelStreaming,
        { kind: "text_delta", delta: "live-2", done: false, messageId: "msg-live-assistant" },
        { turnId: "turn-live" },
      ),
    );
    vi.advanceTimersByTime(CONTINUOUS_WINDOW);
    expect(host.frames.at(-1)).toMatchObject({
      fromSeq: initialSeq,
      toSeq: initialSeq + 1,
      payload: { kind: "deltas" },
    });

    const frameCountBeforeOutOfOrder = host.frames.length;
    const lateQueue = rawLog.push(SessionEventType.TurnSteerQueued, {
      pendingInputId: "queue-late",
      input: "sqlite 较慢的入队",
      inputPreview: "sqlite 较慢的入队",
      inputSize: 21,
      queueLength: 2,
      targetTurnId: "turn-live",
    });
    const laterStream = rawLog.push(
      SessionEventType.ModelStreaming,
      { kind: "text_delta", delta: "live-3", done: false, messageId: "msg-live-assistant" },
      { turnId: "turn-live" },
    );
    // runtime 先给事件编号，各事件的持久化 await 会让 notify sink 乱序；
    // N+1 不能推进高水位后把迟到的 queue N 当成 duplicate 丢掉。
    gateway.ingest("session-race", laterStream);
    vi.advanceTimersByTime(CONTINUOUS_WINDOW);
    expect(host.frames).toHaveLength(frameCountBeforeOutOfOrder);
    gateway.ingest("session-race", lateQueue);
    vi.advanceTimersByTime(CONTINUOUS_WINDOW);
    expect(gateway.getQueueItem("session-race", "queue-late")?.text).toBe("sqlite 较慢的入队");
    expect(host.frames.at(-1)).toMatchObject({
      fromSeq: initialSeq + 1,
      toSeq: initialSeq + 3,
      payload: { kind: "deltas" },
    });
  });

  it("synthesized hydration 不应让 source 水位与 live 水位之间的事件形成永久 gap", async () => {
    const host = makeHost();
    host.sessions.add("session-hydration-boundary-gap");
    const gateway = makeGateway(host);
    const rawLog = new EventLog("session-hydration-boundary-gap");
    const created = rawLog.push(SessionEventType.SessionCreated, {
      mode: "default",
      contextWindow: 200_000,
    });
    gateway.ingest("session-hydration-boundary-gap", created);
    gateway.ingest(
      "session-hydration-boundary-gap",
      rawLog.push(
        SessionEventType.TurnStarted,
        { turnNumber: 1, input: "live turn before hydration" },
        { turnId: "turn-live" },
      ),
    );

    let releaseLoad:
      | ((value: { events: SessionEvent[]; synthesized: boolean; sourceEventSeq?: number }) => void)
      | undefined;
    const loadStarted = vi.fn();
    host.loadPersistedEventsImpl = async () => {
      loadStarted();
      return await new Promise((resolve) => {
        releaseLoad = resolve;
      });
    };

    const subscribing = gateway.subscribe(
      subscribeParams({ topic: "conversation/session-hydration-boundary-gap" }),
    );
    await vi.waitFor(() => expect(loadStarted).toHaveBeenCalledTimes(1));
    gateway.ingest(
      "session-hydration-boundary-gap",
      rawLog.push(
        SessionEventType.SubagentSpawned,
        {
          agentId: "agent-live",
          agentType: "general-purpose",
          background: true,
          childSessionId: "session-child-live",
          description: "live Agent during hydration",
          parentToolCallId: "tool-agent-live",
          status: "running",
        },
        { turnId: "turn-live" },
      ),
    );
    releaseLoad?.({
      events: [created],
      synthesized: true,
      // 持久读取只覆盖 seq=1；seq=2 已在 hydration 开始前进入 live publisher。
      sourceEventSeq: 1,
    });

    const subscribed = await subscribing;
    const snapshot =
      subscribed.initialFrame?.payload.kind === "snapshot"
        ? subscribed.initialFrame.payload.snapshot
        : null;
    expect(snapshot?.subagents.running).toEqual([
      expect.objectContaining({
        agentId: "agent-live",
        childSessionId: "session-child-live",
      }),
    ]);
  });

  it("已有 live projection 的会话订阅 → 跳过 hydration，不双计", async () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const log = new EventLog();
    gateway.ingest("session-1", sessionCreated(log));
    gateway.ingest(
      "session-1",
      log.push(
        SessionEventType.TurnStarted,
        { turnNumber: 1, input: "live 输入" },
        { turnId: "turn-1" },
      ),
    );
    // 即使 persistedEvents 有内容，live publisher 已存在 → 不重放。
    host.persistedEvents.set("session-1", [sessionCreated(new EventLog())]);
    const result = await gateway.subscribe(subscribeParams());
    const userRows = (
      result.initialFrame?.payload.kind === "snapshot"
        ? result.initialFrame.payload.snapshot.rows.window
        : []
    ).filter((row) => row.kind === "userInput");
    // 只有 live 的一条 userInput，没有被 hydration 重复注入。
    expect(userRows).toHaveLength(1);
  });

  it("detached child cold resume 后以新 raw epoch 投影文件撤销", async () => {
    const sessionId = "session-child-rewind";
    const host = makeHost();
    const gateway = makeGateway(host);
    const live = new EventLog(sessionId);
    const ingestLive = (event: SessionEvent) => gateway.ingestDetachedLiveSession(sessionId, event);

    ingestLive(
      live.push(SessionEventType.SessionCreated, {
        mode: "default",
        contextWindow: 200_000,
      }),
    );
    ingestLive(
      live.push(
        SessionEventType.TurnStarted,
        { turnNumber: 1, input: "child input", messageId: "msg-child-user" },
        { turnId: "turn-child" },
      ),
    );
    ingestLive(
      live.push(
        SessionEventType.ModelStreaming,
        {
          kind: "text_start",
          delta: "",
          done: false,
          assistantMessageId: "msg-child-assistant",
        },
        { turnId: "turn-child" },
      ),
    );
    ingestLive(
      live.push(
        SessionEventType.ModelStreaming,
        {
          kind: "text_delta",
          delta: "done",
          done: false,
          assistantMessageId: "msg-child-assistant",
        },
        { turnId: "turn-child" },
      ),
    );
    ingestLive(
      live.push(
        SessionEventType.ModelStreaming,
        { kind: "text_end", delta: "", done: false },
        { turnId: "turn-child" },
      ),
    );
    ingestLive(
      live.push(
        SessionEventType.ModelComplete,
        {
          content: "done",
          stopReason: "stop",
          querySource: "subagent",
          usage: { inputTokens: 1, outputTokens: 1 },
          fileChanges: {
            files: 1,
            additions: 1,
            deletions: 0,
            items: [
              {
                path: "/work/child.txt",
                additions: 1,
                deletions: 0,
                writeCount: 1,
              },
            ],
          },
        },
        { turnId: "turn-child" },
      ),
    );
    ingestLive(
      live.push(
        SessionEventType.TurnComplete,
        { response: "done", tokenCount: 1, toolCallCount: 1, duration: 1, resultType: "success" },
        { turnId: "turn-child" },
      ),
    );

    const initial = await gateway.subscribe(
      subscribeParams({ topic: `conversation/${sessionId}`, connectionId: "conn-child-1" }),
    );
    const initialHeader =
      initial.initialFrame?.payload.kind === "snapshot"
        ? initial.initialFrame.payload.snapshot.rows.window.find((row) => row.kind === "turnHeader")
        : undefined;
    expect(initialHeader).toMatchObject({
      kind: "turnHeader",
      fileChanges: { files: 1, state: "active" },
    });

    const resumed = new EventLog(sessionId);
    gateway.ingest(sessionId, {
      ...resumed.push(SessionEventType.SessionResumed, {
        directory: "/work",
        messageCount: 2,
        partCount: 2,
      }),
      id: "event-child-resumed" as EventId,
    });
    gateway.ingest(sessionId, {
      ...resumed.push(SessionEventType.RewindTriggered, {
        rewindId: "rewind-child",
        scope: "workspace",
        strategy: "active_chain",
        targetMessageId: "msg-child-user",
        reason: "file_summary_rewind",
      }),
      id: "event-child-rewind" as EventId,
    });

    const after = await gateway.subscribe(
      subscribeParams({ topic: `conversation/${sessionId}`, connectionId: "conn-child-2" }),
    );
    const afterHeader =
      after.initialFrame?.payload.kind === "snapshot"
        ? after.initialFrame.payload.snapshot.rows.window.find((row) => row.kind === "turnHeader")
        : undefined;
    expect(afterHeader).toMatchObject({
      kind: "turnHeader",
      fileChanges: { files: 1, state: "reverted" },
    });
  });
});

describe("文件摘要 query", () => {
  it("reads a live child projection without cold-resuming the child", async () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const childLog = new EventLog("live-child");
    gateway.ingestDetachedLiveSession("live-child", sessionCreated(childLog));
    gateway.ingestDetachedLiveSession(
      "live-child",
      childLog.push(
        SessionEventType.TurnStarted,
        { turnNumber: 1, input: "child input", messageId: "msg-child-user" },
        { turnId: "child-turn" },
      ),
    );
    const snapshot = (
      await gateway.subscribe(subscribeParams({ topic: "conversation/live-child" }))
    ).initialFrame?.payload;
    const conversation = snapshot?.kind === "snapshot" ? snapshot.snapshot : undefined;
    const targetRow =
      snapshot?.kind === "snapshot"
        ? snapshot.snapshot.rows.window.find((row) => row.kind === "turnHeader")
        : undefined;
    const targetRowId = targetRow?.rowId;

    await gateway.fileChanges({
      sessionId: "live-child",
      target: { rowId: targetRow!.rowId, entityId: targetRow!.entityId! },
      baseRevision: conversation!.revision,
      baseLogEpoch: conversation!.logEpoch,
    });

    expect(host.resumeCalls).toEqual([]);
    expect(host.fileChangeCalls).toEqual([
      { sessionId: "live-child", targetRowId, messageIds: ["msg-child-user"] },
    ]);
  });

  it("detached child 首次撤销预览会冷恢复持久化 record，随后撤销命令仍落到 child", async () => {
    const host = makeHost();
    host.resumeOutcome = "resumed";
    host.fileRewindPreviewResult = {
      canApply: true,
      safeFiles: [
        {
          action: "restore",
          operationCount: 1,
          path: "/work/src/child.ts",
          toolNames: ["Write"],
        },
      ],
      unsafeFiles: [],
      ignoredFiles: [],
    };
    const gateway = makeGateway(host);
    const childLog = new EventLog("detached-child");
    gateway.ingestDetachedLiveSession("detached-child", sessionCreated(childLog));
    gateway.ingestDetachedLiveSession(
      "detached-child",
      childLog.push(
        SessionEventType.TurnStarted,
        { turnNumber: 1, input: "child 写文件", messageId: "msg-child-user" },
        { turnId: "child-turn" },
      ),
    );
    gateway.ingestDetachedLiveSession(
      "detached-child",
      childLog.push(
        SessionEventType.ModelComplete,
        {
          content: "done",
          stopReason: "stop",
          querySource: "main_turn",
          contextWindow: 200_000,
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          fileChanges: {
            files: 1,
            additions: 1,
            deletions: 0,
            items: [{ path: "/work/src/child.ts", additions: 1, deletions: 0, writeCount: 1 }],
          },
        },
        { turnId: "child-turn" },
      ),
    );
    gateway.ingestDetachedLiveSession(
      "detached-child",
      childLog.push(
        SessionEventType.TurnComplete,
        { response: "done", tokenCount: 2, toolCallCount: 0, duration: 1, resultType: "success" },
        { turnId: "child-turn" },
      ),
    );

    const subscribed = await gateway.subscribe(
      subscribeParams({ topic: "conversation/detached-child" }),
    );
    const snapshot =
      subscribed.initialFrame?.payload.kind === "snapshot"
        ? subscribed.initialFrame.payload.snapshot
        : undefined;
    const targetRow = snapshot?.rows.window.find(
      (row) => row.kind === "turnHeader" && row.actions?.canRewindFiles === true,
    );
    expect(targetRow).toBeDefined();
    expect(host.resumeCalls).toEqual([]);

    await gateway.fileRewindPreview({
      sessionId: "detached-child",
      target: { rowId: targetRow!.rowId, entityId: targetRow!.entityId! },
      baseRevision: snapshot!.revision,
      baseLogEpoch: snapshot!.logEpoch,
    });

    expect(host.resumeCalls).toEqual(["detached-child"]);
    expect(host.sessions).toContain("detached-child");
    expect(host.fileRewindPreviewCalls).toEqual([
      {
        sessionId: "detached-child",
        targetRowId: targetRow!.rowId,
        messageIds: ["msg-child-user"],
      },
    ]);

    const ack = await gateway.handleCommand(
      commandParams({
        commandId: "cmd-child-rewind",
        sessionId: "detached-child",
        type: "applyFileRewind",
        payload: { target: { rowId: targetRow!.rowId, entityId: targetRow!.entityId! } },
        baseRevision: snapshot!.revision,
        baseLogEpoch: snapshot!.logEpoch,
      }),
    );

    expect(ack).toMatchObject({ status: "accepted" });
    await vi.waitFor(() => expect(host.executed).toHaveLength(1));
    expect(host.executed[0]).toMatchObject({
      commandId: "cmd-child-rewind",
      sessionId: "detached-child",
      type: "applyFileRewind",
    });
  });

  it("fileChanges query 能用普通 TurnStarted 的 user messageId 定位文件 checkpoint", async () => {
    const host = makeHost();
    host.fileChangesResult = {
      files: 1,
      additions: 1,
      deletions: 0,
      items: [
        {
          path: "/work/input.html",
          additions: 1,
          deletions: 0,
          writeCount: 1,
          toolNames: ["Write"],
          patches: [],
        },
      ],
    };
    const gateway = makeGateway(host);
    const log = new EventLog();
    gateway.ingest("session-1", sessionCreated(log));
    gateway.ingest(
      "session-1",
      log.push(
        SessionEventType.TurnStarted,
        { turnNumber: 1, input: "改文件", messageId: "msg-user-1" },
        { turnId: "turn-1" },
      ),
    );

    const snapshot = (await gateway.subscribe(subscribeParams())).initialFrame?.payload;
    const conversation = snapshot?.kind === "snapshot" ? snapshot.snapshot : undefined;
    const targetRow =
      snapshot?.kind === "snapshot"
        ? snapshot.snapshot.rows.window.find((row) => row.kind === "turnHeader")
        : undefined;
    const targetRowId = targetRow?.rowId;
    expect(targetRowId).toBeDefined();

    await gateway.fileChanges({
      sessionId: "session-1",
      target: { rowId: targetRow!.rowId, entityId: targetRow!.entityId! },
      baseRevision: conversation!.revision,
      baseLogEpoch: conversation!.logEpoch,
    });

    expect(host.fileChangeCalls).toEqual([
      { sessionId: "session-1", targetRowId, messageIds: ["msg-user-1"] },
    ]);
  });

  it("fileChanges query 能用 background model-only TurnStarted 的隐藏 messageId 定位文件 checkpoint", async () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const log = new EventLog();
    gateway.ingest("session-1", sessionCreated(log));
    gateway.ingest(
      "session-1",
      log.push(
        SessionEventType.TurnStarted,
        {
          turnNumber: 2,
          input: "<task-notification>background task completed</task-notification>",
          inputSource: "background_task",
          inputVisibility: "model-only",
          messageId: "msg-background-wake",
        },
        { turnId: "turn-background-wake" },
      ),
    );
    gateway.ingest(
      "session-1",
      log.push(
        SessionEventType.ModelComplete,
        {
          content: "done",
          stopReason: "stop",
          querySource: "main_turn",
          contextWindow: 200_000,
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          fileChanges: {
            files: 1,
            additions: 1,
            deletions: 0,
            items: [
              {
                path: "/work/background-result.md",
                additions: 1,
                deletions: 0,
                writeCount: 1,
              },
            ],
          },
        },
        { turnId: "turn-background-wake" },
      ),
    );

    const snapshot = (await gateway.subscribe(subscribeParams())).initialFrame?.payload;
    const conversation = snapshot?.kind === "snapshot" ? snapshot.snapshot : undefined;
    const targetRow =
      snapshot?.kind === "snapshot"
        ? snapshot.snapshot.rows.window.find((row) => row.kind === "turnHeader")
        : undefined;
    expect(targetRow).toBeDefined();
    expect(conversation?.rows.window.some((row) => row.kind === "userInput")).toBe(false);

    await gateway.fileChanges({
      sessionId: "session-1",
      target: { rowId: targetRow!.rowId, entityId: targetRow!.entityId! },
      baseRevision: conversation!.revision,
      baseLogEpoch: conversation!.logEpoch,
    });

    expect(host.fileChangeCalls).toEqual([
      {
        sessionId: "session-1",
        targetRowId: targetRow!.rowId,
        messageIds: ["msg-background-wake"],
      },
    ]);
  });

  it("fileChanges query 通过 turn rowId 解析同轮 messageIds 后转发宿主", async () => {
    const host = makeHost();
    host.fileChangesResult = {
      files: 1,
      additions: 1,
      deletions: 0,
      items: [
        {
          path: "/work/src/demo.ts",
          additions: 1,
          deletions: 0,
          writeCount: 1,
          toolNames: ["Write"],
          patches: [],
        },
      ],
    };
    const gateway = makeGateway(host);
    const log = new EventLog();
    gateway.ingest("session-1", sessionCreated(log));
    const turnStarted = log.push(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: "改文件" },
      { turnId: "turn-1" },
    );
    gateway.ingest("session-1", turnStarted);
    gateway.ingest(
      "session-1",
      log.push(
        SessionEventType.ModelStreaming,
        { kind: "text_start", delta: "", done: false, assistantMessageId: "msg-a1" },
        { turnId: "turn-1" },
      ),
    );

    const header = gateway.getQueueHead("session-1"); // no-op read to keep type surface exercised
    expect(header).toBeNull();
    const snapshot = (await gateway.subscribe(subscribeParams())).initialFrame?.payload;
    const conversation = snapshot?.kind === "snapshot" ? snapshot.snapshot : undefined;
    const targetRow =
      snapshot?.kind === "snapshot"
        ? snapshot.snapshot.rows.window.find((row) => row.kind === "turnHeader")
        : undefined;
    const targetRowId = targetRow?.rowId;
    expect(targetRowId).toBeDefined();

    const result = await gateway.fileChanges({
      sessionId: "session-1",
      target: { rowId: targetRow!.rowId, entityId: targetRow!.entityId! },
      baseRevision: conversation!.revision,
      baseLogEpoch: conversation!.logEpoch,
    });

    expect(result.files).toBe(1);
    expect(host.fileChangeCalls).toEqual([
      { sessionId: "session-1", targetRowId, messageIds: ["msg-a1"] },
    ]);
  });

  it("fileRewindPreview query 通过 turn rowId 解析同轮 messageIds 后转发宿主", async () => {
    const host = makeHost();
    host.fileRewindPreviewResult = {
      canApply: true,
      safeFiles: [
        {
          action: "restore",
          operationCount: 1,
          path: "/work/src/demo.ts",
          toolNames: ["Write"],
        },
      ],
      unsafeFiles: [],
      ignoredFiles: [],
    };
    const gateway = makeGateway(host);
    const log = new EventLog();
    gateway.ingest("session-1", sessionCreated(log));
    gateway.ingest(
      "session-1",
      log.push(
        SessionEventType.TurnStarted,
        { turnNumber: 1, input: "改文件" },
        { turnId: "turn-1" },
      ),
    );
    gateway.ingest(
      "session-1",
      log.push(
        SessionEventType.ModelStreaming,
        { kind: "text_start", delta: "", done: false, assistantMessageId: "msg-a1" },
        { turnId: "turn-1" },
      ),
    );
    gateway.ingest(
      "session-1",
      log.push(
        SessionEventType.ModelComplete,
        {
          content: "done",
          stopReason: "stop",
          querySource: "main_turn",
          contextWindow: 200_000,
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          fileChanges: {
            files: 1,
            additions: 1,
            deletions: 0,
            items: [{ path: "/work/src/demo.ts", additions: 1, deletions: 0, writeCount: 1 }],
          },
        },
        { turnId: "turn-1" },
      ),
    );
    gateway.ingest(
      "session-1",
      log.push(
        SessionEventType.TurnComplete,
        { response: "done", tokenCount: 2, toolCallCount: 0, duration: 1, resultType: "success" },
        { turnId: "turn-1" },
      ),
    );
    const snapshot = (await gateway.subscribe(subscribeParams())).initialFrame?.payload;
    const conversation = snapshot?.kind === "snapshot" ? snapshot.snapshot : undefined;
    const targetRow =
      snapshot?.kind === "snapshot"
        ? snapshot.snapshot.rows.window.find((row) => row.kind === "turnHeader")
        : undefined;
    const targetRowId = targetRow?.rowId;
    expect(targetRowId).toBeDefined();

    const result = await gateway.fileRewindPreview({
      sessionId: "session-1",
      target: { rowId: targetRow!.rowId, entityId: targetRow!.entityId! },
      baseRevision: conversation!.revision,
      baseLogEpoch: conversation!.logEpoch,
    });

    expect(result.canApply).toBe(true);
    expect(host.fileRewindPreviewCalls).toEqual([
      { sessionId: "session-1", targetRowId, messageIds: ["msg-a1"] },
    ]);
  });
});

describe("projection 16MiB fault 与恢复", () => {
  it("oversize model event 原子拒绝并只终止一次，TurnError 与 cold hydrate 均保持可传输", async () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const probe = new ConversationTopicPublisher("session-1", "epoch-1", {
      now: () => 1_700_000_999_000,
    });
    const log = new EventLog();
    const prefix = [
      sessionCreated(log),
      log.push(
        SessionEventType.TurnStarted,
        { turnNumber: 1, input: "生成长回复", messageId: "msg-user-limit" },
        { turnId: "turn-1" },
      ),
      log.push(
        SessionEventType.ModelStreaming,
        { kind: "text_start", delta: "", done: false, assistantMessageId: "msg-assistant-limit" },
        { turnId: "turn-1" },
      ),
    ];
    for (const event of prefix) {
      probe.ingest(event);
      gateway.ingest("session-1", event);
    }

    const emptyDeltaEvent = log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_delta", delta: "", done: false },
      { turnId: "turn-1" },
    );
    probe.ingest(emptyDeltaEvent);
    const runtimeLimit =
      PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes - PROJECTION_TERMINAL_RESERVE_BYTES;
    const exactText = "a".repeat(runtimeLimit - probe.getWireSnapshotLogicalBytes());
    const exactDeltaEvent: SessionEvent = {
      ...emptyDeltaEvent,
      payload: { kind: "text_delta", delta: exactText, done: false },
    };
    gateway.ingest("session-1", exactDeltaEvent);

    const overflow = log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_delta", delta: "a", done: false },
      { turnId: "turn-1" },
    );
    gateway.ingest("session-1", overflow);
    gateway.ingest(
      "session-1",
      log.push(
        SessionEventType.ModelStreaming,
        { kind: "text_delta", delta: "b", done: false },
        { turnId: "turn-1" },
      ),
    );
    expect(host.projectionTerminations).toEqual([
      { sessionId: "session-1", reasonCode: "proto.payloadTooLarge" },
    ]);

    const turnError = log.push(
      SessionEventType.TurnError,
      {
        error: { type: "proto.payloadTooLarge", message: "projection payload too large" },
        turnPhase: "model",
      },
      { turnId: "turn-1" },
    );
    gateway.ingest("session-1", turnError);
    const live = await gateway.subscribe(subscribeParams());
    expect(live.initialFrame).not.toBeNull();
    expect(utf8JsonByteLength(live.initialFrame)).toBeLessThanOrEqual(
      PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes,
    );
    expect(
      live.initialFrame?.payload.kind === "snapshot"
        ? live.initialFrame.payload.snapshot.control.phase
        : null,
    ).toBe("error");

    const coldHost = makeHost();
    coldHost.persistedEvents.set("session-1", [...prefix, exactDeltaEvent, overflow, turnError]);
    const cold = await makeGateway(coldHost).subscribe(subscribeParams());
    expect(cold.initialFrame).not.toBeNull();
    expect(utf8JsonByteLength(cold.initialFrame)).toBeLessThanOrEqual(
      PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes,
    );
    expect(coldHost.errors.some((entry) => entry.scope === "v4.hydrate.payloadTooLarge")).toBe(
      true,
    );
  });

  it("oversize tool input 不进入 projection，并以同一 protocol fault 终止 turn", async () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const log = new EventLog();
    gateway.ingest("session-1", sessionCreated(log));
    gateway.ingest(
      "session-1",
      log.push(
        SessionEventType.TurnStarted,
        { turnNumber: 1, input: "调用工具", messageId: "msg-user-tool-limit" },
        { turnId: "turn-1" },
      ),
    );
    gateway.ingest(
      "session-1",
      log.push(
        SessionEventType.ModelStreaming,
        {
          kind: "tool_call",
          toolCallId: "tool-limit",
          toolName: "write",
          input: { content: "x".repeat(PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes) },
        },
        { turnId: "turn-1" },
      ),
    );
    expect(host.projectionTerminations).toEqual([
      { sessionId: "session-1", reasonCode: "proto.payloadTooLarge" },
    ]);
    gateway.ingest(
      "session-1",
      log.push(
        SessionEventType.TurnError,
        {
          error: { type: "proto.payloadTooLarge", message: "projection payload too large" },
          turnPhase: "tool",
        },
        { turnId: "turn-1" },
      ),
    );
    const subscribed = await gateway.subscribe(subscribeParams());
    const snapshot =
      subscribed.initialFrame?.payload.kind === "snapshot"
        ? subscribed.initialFrame.payload.snapshot
        : null;
    expect(snapshot?.rows.window.some((row) => row.kind === "toolCall")).toBe(false);
    expect(snapshot?.control.lastError?.code).toBe("proto.payloadTooLarge");
    expect(utf8JsonByteLength(subscribed.initialFrame)).toBeLessThanOrEqual(
      PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes,
    );
  });
});

describe("projection event commit waiter", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each(["desktop-continuous", "web-remote-replayable"])(
    "PA158 %s：已提交授权投影超时后重建日志，不覆盖后来模式",
    async (profileId) => {
      const host = makeHost();
      const gateway = makeGateway(host);
      const log = new EventLog();
      gateway.ingest("session-1", sessionCreated(log));
      log.push(SessionEventType.SessionTitleUpdated, {
        title: "missing transport",
        source: "custom",
      });
      const grant = log.push(SessionEventType.SessionModeChanged, {
        mode: "yolo",
        planEnabled: true,
        source: "command",
        permissionGrant: { interactionId: "p", queueItemIds: [] },
      });
      gateway.ingest("session-1", grant);
      const timedOut = expect(
        gateway.waitForPermissionGrantCommit("session-1", String(grant.id)),
      ).rejects.toMatchObject({ reasonCode: "fault.projectionEventCommit.timeout" });
      await vi.advanceTimersByTimeAsync(25_000);
      await timedOut;
      log.push(SessionEventType.SessionModeChanged, {
        mode: "edit",
        planEnabled: false,
        source: "command",
      });
      host.persistedEvents.set("session-1", log.events);
      await gateway.waitForPermissionGrantCommit("session-1", String(grant.id));
      const subscribed = await gateway.subscribe(subscribeParams({ clientMode: profileId }));
      const snapshot =
        subscribed.initialFrame?.payload.kind === "snapshot"
          ? subscribed.initialFrame.payload.snapshot
          : null;
      expect(snapshot?.config).toMatchObject({
        mode: "edit",
        planEnabled: false,
        permissionGrant: { interactionId: "p" },
      });
    },
  );

  it("raw gap pending 时不 resolve；缺失 seq 到达并 apply 目标 event 后才 resolve", async () => {
    const gateway = makeGateway(makeHost());
    const log = new EventLog();
    gateway.ingest("session-1", sessionCreated(log));
    const missing = log.push(SessionEventType.SessionTitleUpdated, {
      previousTitle: "old",
      title: "new",
      source: "custom",
    });
    const target = log.push(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: "gap 后启动", messageId: "msg-gap-user" },
      { turnId: "turn-gap" },
    );
    gateway.ingest("session-1", target);
    let committed = false;
    const waiting = gateway
      .waitForProjectionEventCommit("session-1", String(target.id))
      .then(() => {
        committed = true;
      });

    await Promise.resolve();
    expect(committed).toBe(false);
    gateway.ingest("session-1", missing);
    await waiting;
    expect(committed).toBe(true);
    await expect(
      gateway.waitForProjectionEventCommit("session-1", String(target.id)),
    ).resolves.toBeUndefined();
  });

  it("SessionResumed 前跳会开启新 raw epoch，不让旧 runtime gap 阻塞 TurnStarted", async () => {
    const gateway = makeGateway(makeHost());
    const log = new EventLog();
    gateway.ingest("session-1", sessionCreated(log));
    const resumed = {
      ...log.push(SessionEventType.SessionResumed, {
        directory: "/repo",
        interruptedToolCount: 0,
        messageCount: 10,
        partCount: 20,
      }),
      id: "event-resumed-new-epoch" as EventId,
      sequenceNumber: 100,
    };
    const started = {
      ...log.push(
        SessionEventType.TurnStarted,
        { turnNumber: 2, input: "恢复后立即发送", messageId: "msg-new-epoch" },
        { turnId: "turn-new-epoch" },
      ),
      id: "event-started-new-epoch" as EventId,
      sequenceNumber: 101,
    };

    gateway.ingest("session-1", resumed);
    gateway.ingest("session-1", started);
    let committed = false;
    const waiting = gateway
      .waitForProjectionEventCommit("session-1", String(started.id))
      .then(() => {
        committed = true;
      });

    await Promise.resolve();
    expect(committed).toBe(true);
    await waiting;
  });

  it("canonical event apply 后通知宿主，供 goal 终态重评 queue gate", () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const log = new EventLog();
    const created = sessionCreated(log);
    const targetActive = log.push(SessionEventType.TargetChanged, {
      action: "created",
      previousTarget: null,
      source: "command",
      target: {
        targetID: "goal-1",
        objective: "验证 background goal queue",
        status: "active",
      },
    });
    const targetCompleted = log.push(SessionEventType.TargetChanged, {
      action: "status_updated",
      previousTarget: {
        targetID: "goal-1",
        objective: "验证 background goal queue",
        status: "active",
      },
      source: "runtime",
      target: {
        targetID: "goal-1",
        objective: "验证 background goal queue",
        status: "complete",
      },
    });

    gateway.ingest("session-1", created);
    gateway.ingest("session-1", targetActive);
    gateway.ingest("session-1", targetCompleted);

    expect(host.projectionEvents).toEqual([{ sessionId: "session-1", event: targetCompleted }]);
  });

  it("disposeSession/rehydrate 会 reject pending waiter 并清理", async () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const log = new EventLog();
    gateway.ingest("session-1", sessionCreated(log));
    log.push(SessionEventType.SessionTitleUpdated, {
      previousTitle: "old",
      title: "new",
      source: "custom",
    });
    const pendingForDispose = log.push(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: "pending dispose", messageId: "msg-dispose" },
      { turnId: "turn-dispose" },
    );
    gateway.ingest("session-1", pendingForDispose);
    const disposed = expect(
      gateway.waitForProjectionEventCommit("session-1", String(pendingForDispose.id)),
    ).rejects.toMatchObject({ reasonCode: "fault.projectionEventCommit.disposed" });
    gateway.disposeSession("session-1");
    await disposed;

    const rehydrateLog = new EventLog();
    gateway.ingest("session-1", sessionCreated(rehydrateLog));
    rehydrateLog.push(SessionEventType.SessionTitleUpdated, {
      previousTitle: "old",
      title: "new",
      source: "custom",
    });
    const pendingForRehydrate = rehydrateLog.push(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: "pending rehydrate", messageId: "msg-rehydrate" },
      { turnId: "turn-rehydrate" },
    );
    gateway.ingest("session-1", pendingForRehydrate);
    const rehydrated = expect(
      gateway.waitForProjectionEventCommit("session-1", String(pendingForRehydrate.id)),
    ).rejects.toMatchObject({ reasonCode: "fault.projectionEventCommit.rehydrated" });
    host.loadPersistedEventsImpl = async () => ({
      events: [sessionCreated(new EventLog())],
      synthesized: true,
      sourceEventSeq: 1,
    });
    await gateway.subscribe(subscribeParams({ connectionId: "rehydrate-waiter" }));
    await rehydrated;

    const wholeGateway = makeGateway(makeHost());
    const wholeLog = new EventLog();
    wholeGateway.ingest("session-1", sessionCreated(wholeLog));
    wholeLog.push(SessionEventType.SessionTitleUpdated, {
      previousTitle: "old",
      title: "new",
      source: "custom",
    });
    const pendingForGatewayDispose = wholeLog.push(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: "pending gateway dispose", messageId: "msg-gateway-dispose" },
      { turnId: "turn-gateway-dispose" },
    );
    wholeGateway.ingest("session-1", pendingForGatewayDispose);
    const gatewayDisposed = expect(
      wholeGateway.waitForProjectionEventCommit("session-1", String(pendingForGatewayDispose.id)),
    ).rejects.toMatchObject({ reasonCode: "fault.projectionEventCommit.gatewayDisposed" });
    wholeGateway.dispose();
    await gatewayDisposed;
  });

  it("projection apply error 会留下 event failure fact，迟到 waiter 立即 reject", async () => {
    const gateway = makeGateway(makeHost());
    const log = new EventLog();
    gateway.ingest("session-1", sessionCreated(log));
    const oversized = log.push(
      SessionEventType.TurnStarted,
      {
        turnNumber: 1,
        input: "x".repeat(PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes),
        messageId: "msg-oversized-commit",
      },
      { turnId: "turn-oversized-commit" },
    );
    gateway.ingest("session-1", oversized);

    await expect(
      gateway.waitForProjectionEventCommit("session-1", String(oversized.id)),
    ).rejects.toMatchObject({ reasonCode: "fault.projectionEventCommit.applyFailed" });
  });

  it("25s timeout 后固化 event failure；补齐 raw gap 也不得迟到 apply", async () => {
    const gateway = makeGateway(makeHost());
    const log = new EventLog();
    gateway.ingest("session-1", sessionCreated(log));
    const missing = log.push(SessionEventType.SessionTitleUpdated, {
      previousTitle: "old",
      title: "new",
      source: "custom",
    });
    const target = log.push(
      SessionEventType.TurnStarted,
      {
        turnNumber: 1,
        input: "pending timeout",
        inputId: "cmd-waiter-timeout",
        messageId: "msg-timeout",
      },
      { turnId: "turn-timeout" },
    );
    gateway.ingest("session-1", target);
    const timedOut = expect(
      gateway.waitForProjectionEventCommit("session-1", String(target.id)),
    ).rejects.toMatchObject({ reasonCode: "fault.projectionEventCommit.timeout" });
    await vi.advanceTimersByTimeAsync(25_000);
    await timedOut;

    gateway.ingest("session-1", missing);
    await expect(
      gateway.waitForProjectionEventCommit("session-1", String(target.id)),
    ).rejects.toMatchObject({ reasonCode: "fault.projectionEventCommit.timeout" });
    const subscribed = await gateway.subscribe(
      subscribeParams({ connectionId: "post-waiter-timeout-gap-recovery" }),
    );
    const snapshot =
      subscribed.initialFrame?.payload.kind === "snapshot"
        ? subscribed.initialFrame.payload.snapshot
        : null;
    expect(
      snapshot?.rows.window.some(
        (row) => row.kind === "userInput" && row.sourceCommandId === "cmd-waiter-timeout",
      ),
    ).toBe(false);
  });

  it("abort 后固化 event failure；补齐 raw gap 也不得迟到 apply", async () => {
    const gateway = makeGateway(makeHost());
    const log = new EventLog();
    gateway.ingest("session-1", sessionCreated(log));
    const missing = log.push(SessionEventType.SessionTitleUpdated, {
      previousTitle: "old",
      title: "new",
      source: "custom",
    });
    const target = log.push(
      SessionEventType.TurnStarted,
      {
        turnNumber: 1,
        input: "pending abort",
        inputId: "cmd-waiter-abort",
        messageId: "msg-abort",
      },
      { turnId: "turn-abort" },
    );
    gateway.ingest("session-1", target);
    const controller = new AbortController();
    const aborted = expect(
      gateway.waitForProjectionEventCommit("session-1", String(target.id), {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ reasonCode: "fault.projectionEventCommit.aborted" });
    controller.abort(new Error("command cancelled before projection commit"));
    await aborted;

    gateway.ingest("session-1", missing);
    await expect(
      gateway.waitForProjectionEventCommit("session-1", String(target.id)),
    ).rejects.toMatchObject({ reasonCode: "fault.projectionEventCommit.aborted" });
    const subscribed = await gateway.subscribe(
      subscribeParams({ connectionId: "post-waiter-abort-gap-recovery" }),
    );
    const snapshot =
      subscribed.initialFrame?.payload.kind === "snapshot"
        ? subscribed.initialFrame.payload.snapshot
        : null;
    expect(
      snapshot?.rows.window.some(
        (row) => row.kind === "userInput" && row.sourceCommandId === "cmd-waiter-abort",
      ),
    ).toBe(false);
  });
});

describe("v4/command 收口", () => {
  it("durable create 首发在启动前可观察 pending，启动与快速完成后不残留", async () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const log = new EventLog();
    gateway.ingest("session-1", sessionCreated(log));
    const command = commandParams({
      commandId: "app-control-create",
      type: "createSession",
      sessionId: null,
      payload: { workspaceId: "/work", firstInput: { text: "first" } },
    });
    gateway.admitPendingInput("session-1", command as CommandEnvelope, 100);
    const before = await gateway.subscribe(subscribeParams());
    expect(before.initialFrame?.payload).toMatchObject({
      kind: "snapshot",
      snapshot: {
        pendingCommands: [{ commandId: command.commandId, state: "accepted" }],
        rows: { window: [] },
      },
    });
    gateway.ingest(
      "session-1",
      log.push(
        SessionEventType.TurnStarted,
        { input: "first", inputId: command.commandId, turnNumber: 1 },
        { turnId: "turn-1" },
      ),
    );
    gateway.ingest(
      "session-1",
      log.push(SessionEventType.TurnComplete, { inputId: command.commandId }, { turnId: "turn-1" }),
    );
    const after = await gateway.subscribe(subscribeParams());
    expect(after.initialFrame?.payload).toMatchObject({
      kind: "snapshot",
      snapshot: { pendingCommands: [] },
    });
    gateway.dispose();
  });

  it("仅持久提升不清 pending，启动前失败按精确 inputId 移除", async () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const log = new EventLog();
    gateway.ingest("session-1", sessionCreated(log));
    const command = commandParams({ commandId: "app-control-pre-start" }) as CommandEnvelope;
    gateway.admitPendingInput("session-1", command, 100);
    gateway.ingest(
      "session-1",
      log.push(SessionEventType.SessionInputPromoted, {
        sourceCommandId: command.commandId,
        pendingInputId: `queue_${command.commandId}`,
        messageId: "message-1",
      }),
    );
    expect((await gateway.subscribe(subscribeParams())).initialFrame?.payload).toMatchObject({
      kind: "snapshot",
      snapshot: { pendingCommands: [{ commandId: command.commandId }] },
    });
    gateway.ingest(
      "session-1",
      log.push(
        SessionEventType.TurnError,
        {
          inputId: command.commandId,
          error: { message: "pre-start rejected" },
        },
        { turnId: "turn-failed" },
      ),
    );
    expect((await gateway.subscribe(subscribeParams())).initialFrame?.payload).toMatchObject({
      kind: "snapshot",
      snapshot: { pendingCommands: [] },
    });
    gateway.dispose();
  });

  it("取消只移除匹配 pending；队列事实替代 pending，冷启动不恢复 pending", async () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const log = new EventLog();
    gateway.ingest("session-1", sessionCreated(log));
    const first = commandParams({ commandId: "app-control-first" }) as CommandEnvelope;
    const second = commandParams({ commandId: "app-control-second" }) as CommandEnvelope;
    gateway.admitPendingInput("session-1", first, 100);
    gateway.admitPendingInput("session-1", second, 101);
    gateway.cancelPendingInput("session-1", first.commandId);
    expect((await gateway.subscribe(subscribeParams())).initialFrame?.payload).toMatchObject({
      kind: "snapshot",
      snapshot: { pendingCommands: [{ commandId: second.commandId }] },
    });
    gateway.ingest(
      "session-1",
      log.push(SessionEventType.TurnSteerQueued, {
        pendingInputId: "queue_app-control-second",
        inputId: second.commandId,
        input: "queued",
        delivery: "queue",
        queueLength: 1,
        intent: { sourceCommandId: second.commandId, clientId: "client-1", kind: "sendText" },
      }),
    );
    expect((await gateway.subscribe(subscribeParams())).initialFrame?.payload).toMatchObject({
      kind: "snapshot",
      snapshot: {
        pendingCommands: [],
        queue: { items: [expect.objectContaining({ sourceCommandId: second.commandId })] },
      },
    });
    gateway.admitPendingInput("session-1", first, 102);
    gateway.dispose();
    const restarted = makeGateway(host);
    expect((await restarted.subscribe(subscribeParams())).initialFrame?.payload).toMatchObject({
      kind: "snapshot",
      snapshot: { pendingCommands: [] },
    });
    restarted.dispose();
  });

  it.each(["createSession", "createSelectionSideSession"] as const)(
    "%s ACK 采用结果会话 Memory 而非父会话",
    async (type) => {
      const host = makeHost();
      host.memorySettings = new Map([
        ["session-1", false],
        ["child-1", true],
      ]);
      host.executeImpl = async () => ({ type, sessionId: "child-1" });
      const gateway = makeGateway(host);
      gateway.ingest("session-1", sessionCreated(new EventLog()));
      const ack = await gateway.handleCommand(
        commandParams({
          type,
          sessionId: type === "createSession" ? null : "session-1",
          payload: type === "createSession" ? { workspaceId: "/work" } : {},
        }),
      );
      expect(ack).toMatchObject({
        status: "accepted",
        memoryEnabled: true,
        result: { sessionId: "child-1" },
      });
      gateway.dispose();
    },
  );

  it.each([true, false, undefined])(
    "ACK 与 live turn fact 复用会话 Memory %s",
    async (memoryEnabled) => {
      const host = makeHost();
      host.memorySettings = new Map(
        memoryEnabled === undefined ? [] : [["session-1", memoryEnabled]],
      );
      const gateway = makeGateway(host);
      const log = new EventLog();
      gateway.ingest("session-1", sessionCreated(log));
      const ack = await gateway.handleCommand(commandParams());
      expect(ack.status).toBe("accepted");
      expect(ack.memoryEnabled).toBe(memoryEnabled);
      gateway.ingest(
        "session-1",
        log.push(SessionEventType.TurnStarted, { inputId: "cmd-1" }, { turnId: "turn-1" }),
      );
      expect(host.telemetryFacts.find((fact) => fact.kind === "turn.started")).toMatchObject(
        memoryEnabled === undefined ? { kind: "turn.started" } : { memoryEnabled },
      );
      host.memorySettings.set("session-1", !memoryEnabled);
      const duplicate = await gateway.handleCommand(commandParams());
      expect(duplicate.status).toBe("duplicate");
      expect(duplicate.memoryEnabled).toBe(memoryEnabled);
      gateway.dispose();
    },
  );

  it("resident 回收纯预检在 CommandInbox pin 期间拒绝且不消费 pin", async () => {
    const gateway = makeGateway(makeHost());
    const log = new EventLog();
    gateway.ingest("session-1", sessionCreated(log));
    const inbox = (gateway as unknown as { inbox: CommandInbox }).inbox;
    const running = await inbox.handle(commandParams({ commandId: "command-residency-pinned" }));
    expect(running.kind).toBe("execute");

    expect(() => gateway.assertSessionRuntimeDeactivatable("session-1")).toThrow(
      "Session command inbox is still pinned",
    );
    expect(gateway.hasResidencyBlockingCommands("session-1")).toBe(true);

    if (running.kind === "execute") running.settle({ status: "accepted" });
    expect(() => gateway.assertSessionRuntimeDeactivatable("session-1")).not.toThrow();
    gateway.dispose();
  });

  it("stable fork commit 后 registration 异常仍固化 accepted child 并可跨重启重放", async () => {
    const store = await createSqliteSessionStore({ dbPath: ":memory:" });
    const parentSessionId = createSessionId("post-commit-parent");
    const childSessionId = createSessionId("post-commit-child");
    const childMessageId = createMessageId("post-commit-message");
    const commandId = "cmd-post-commit-registration";
    const warnings: Array<{ message: string; fields: Record<string, unknown> }> = [];
    try {
      await store.createSession({
        id: parentSessionId,
        projectID: createProjectId("post-commit-project"),
        slug: "post-commit-parent",
        directory: "/work",
        title: "post commit parent",
        version: "0.1.0",
      });
      const host = makeHost();
      host.sessions = new Set([String(parentSessionId)]);
      const gateway = makeGateway(host);
      const log = new EventLog(String(parentSessionId));
      gateway.ingest(String(parentSessionId), sessionCreated(log));
      gateway.ingest(
        String(parentSessionId),
        log.push(
          SessionEventType.TurnStarted,
          { turnNumber: 1, input: "fork target", messageId: "msg-parent-user" },
          { turnId: "turn-parent" },
        ),
      );
      gateway.ingest(
        String(parentSessionId),
        log.push(
          SessionEventType.ModelStreaming,
          {
            kind: "text_start",
            delta: "",
            done: false,
            assistantMessageId: "msg-parent-assistant",
          },
          { turnId: "turn-parent" },
        ),
      );
      gateway.ingest(
        String(parentSessionId),
        log.push(
          SessionEventType.ModelComplete,
          {
            content: "stable answer",
            stopReason: "stop",
            querySource: "main_turn",
            contextWindow: 200_000,
            usage: {
              inputTokens: 1,
              outputTokens: 1,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
          },
          { turnId: "turn-parent" },
        ),
      );
      gateway.ingest(
        String(parentSessionId),
        log.push(
          SessionEventType.TurnComplete,
          {
            response: "stable answer",
            tokenCount: 2,
            toolCallCount: 0,
            duration: 1,
            resultType: "success",
          },
          { turnId: "turn-parent" },
        ),
      );
      const initial = await gateway.subscribe(
        subscribeParams({
          topic: `conversation/${String(parentSessionId)}`,
          connectionId: "conn-post-commit",
        }),
      );
      const stableSnapshot =
        initial.initialFrame?.payload.kind === "snapshot"
          ? initial.initialFrame.payload.snapshot
          : undefined;
      const stableAssistant = stableSnapshot?.rows.window.find(
        (row) => row.kind === "assistantText" && row.actions?.canFork === true,
      );
      expect(stableAssistant).toBeDefined();
      const context = {
        deps: { sessionStore: store },
        logger: {
          warn: (message: string, fields: Record<string, unknown>) => {
            warnings.push({ message, fields });
          },
        },
        sessions: new Map(),
      } as never;
      const registration = vi.fn().mockRejectedValue(new Error("catalog exploded"));
      host.executeImpl = async (envelope) => {
        const child = await store.commitForkBundle!({
          child: {
            id: childSessionId,
            parentID: parentSessionId,
            projectID: createProjectId("post-commit-project"),
            slug: "post-commit-child",
            directory: "/work",
            title: "post commit child",
            version: "0.1.0",
          },
          messages: [
            {
              info: {
                id: childMessageId,
                sessionID: childSessionId,
                role: "user",
                agent: "build",
                model: { providerID: "test", modelID: "test" },
                system: [],
                tools: {},
                time: { created: 1 },
              },
              parts: [
                {
                  id: createPartId("post-commit-part"),
                  sessionID: childSessionId,
                  messageID: childMessageId,
                  type: "text",
                  text: "durable child transcript",
                },
              ],
            },
          ],
          entries: [],
          commandFact: {
            parentSessionId: String(parentSessionId),
            sourceCommandId: commandId,
            ack: {
              commandId,
              status: "accepted",
              revisionAtDecision: stableSnapshot!.revision,
              result: { type: "forkAssistant", sessionId: String(childSessionId) },
            },
            metadata: { parentSessionId: String(parentSessionId) },
          },
        });
        await registerCommittedForkBestEffort(
          context,
          {} as never,
          {
            forkedSessionId: child.id,
            parentSessionId,
            targetMessageId: "msg-parent-target",
            response: "forked",
          } as never,
          {
            commandId: envelope.commandId,
            inheritLatestTarget: false,
            runtimeConfig: { mode: "build", model: "test/test" },
          },
          registration,
        );
        return { type: "forkAssistant", sessionId: String(child.id) };
      };

      const params = commandParams({
        baseLogEpoch: stableSnapshot!.logEpoch,
        baseRevision: stableSnapshot!.revision,
        commandId,
        sessionId: String(parentSessionId),
        type: "forkAssistant",
        payload: {
          target: {
            rowId: stableAssistant!.rowId,
            entityId: stableAssistant!.entityId,
          },
        },
      });
      const first = await gateway.handleCommand(params);
      const duplicate = await gateway.handleCommand(params);
      const query = await gateway.queryCommands({
        commands: [{ sessionId: String(parentSessionId), commandId }],
      });
      expect(first).toMatchObject({
        status: "accepted",
        result: { type: "forkAssistant", sessionId: String(childSessionId) },
      });
      expect(duplicate).toMatchObject({
        status: "duplicate",
        result: { type: "forkAssistant", sessionId: String(childSessionId) },
      });
      expect(query.results[0]?.result).toMatchObject({
        status: "accepted",
        result: { type: "forkAssistant", sessionId: String(childSessionId) },
      });
      expect(host.executed).toHaveLength(1);
      expect(registration).toHaveBeenCalledOnce();
      await expect(store.getSession(childSessionId)).resolves.toMatchObject({
        id: childSessionId,
        parentID: parentSessionId,
      });
      await expect(store.messages({ sessionID: childSessionId })).resolves.toHaveLength(1);
      await expect(
        store.sessionEntries({ sessionID: childSessionId, type: "v4/fork_start_failure" }),
      ).resolves.toEqual([
        expect.objectContaining({
          data: expect.objectContaining({
            commandId,
            forkedSessionId: String(childSessionId),
            registrationRequired: true,
            retryable: true,
          }),
        }),
      ]);
      expect(warnings).toContainEqual({
        message: "fork child registration failed after durable commit",
        fields: expect.objectContaining({
          commandId,
          error: "catalog exploded",
          forkedSessionId: String(childSessionId),
          parentSessionId: String(parentSessionId),
          retryable: true,
        }),
      });

      const durable = await loadPersistentCommandFacts(store, parentSessionId);
      const restartedHost = makeHost();
      restartedHost.sessions = new Set([String(parentSessionId)]);
      for (const ack of durable.child ?? []) {
        restartedHost.persistentCommands.child.set(
          `${String(parentSessionId)}\0${ack.commandId}`,
          ack,
        );
      }
      restartedHost.executeImpl = async () => {
        throw new Error("restart must not execute durable fork again");
      };
      const restartedGateway = makeGateway(restartedHost);
      const restartedDuplicate = await restartedGateway.handleCommand(params);
      const restartedQuery = await restartedGateway.queryCommands({
        commands: [{ sessionId: String(parentSessionId), commandId }],
      });
      expect(restartedDuplicate).toMatchObject({
        status: "duplicate",
        result: { type: "forkAssistant", sessionId: String(childSessionId) },
      });
      expect(restartedQuery.results[0]?.result).toMatchObject({
        status: "accepted",
        result: { type: "forkAssistant", sessionId: String(childSessionId) },
      });
      expect(restartedHost.executed).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("TurnStarted 前 runtime 失败返回 failed 并取消 durable input，不留下 ghost admission", async () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const log = new EventLog();
    gateway.ingest("session-1", sessionCreated(log));
    const record = {
      app: {
        sessionId: "session-1",
        sendInput: vi.fn().mockRejectedValue(new Error("pre-start failed")),
      },
      workspace: { workspacePath: "/work" },
      persistence: "immediate",
      traceContext: { traceId: "trace-1" },
    } as unknown as V4SessionRecordView;
    const executor = new V4CommandExecutor({
      getRecord: (sessionId) => (sessionId === "session-1" ? record : undefined),
      afterLegacyStateMutation: async () => {},
    });
    host.executeImpl = (envelope, admission) => executor.execute(envelope, admission);

    const ack = await gateway.handleCommand(commandParams({ commandId: "cmd-pre-start-fail" }));

    expect(ack).toMatchObject({
      status: "failed",
      reasonCode: "fault.command.executionFailed",
    });
    expect(host.inputCancellations).toEqual([
      {
        commandId: "cmd-pre-start-fail",
        queueItemId: "queue_cmd-pre-start-fail",
        reason: "fault.command.executionFailed",
      },
    ]);
    expect(record.activeAbortController).toBeUndefined();
  });

  it("durable TurnStarted 因 raw gap pending 时，Core admission ACK 不等待 projection commit", async () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const log = new EventLog();
    gateway.ingest("session-1", sessionCreated(log));
    const missing = log.push(SessionEventType.SessionTitleUpdated, {
      previousTitle: "old",
      title: "new",
      source: "custom",
    });
    const pendingTurnStarted = log.push(
      SessionEventType.TurnStarted,
      {
        turnNumber: 1,
        input: "pending projection",
        inputId: "cmd-pending-projection",
        messageId: "msg-pending-projection",
      },
      { turnId: "turn-pending-projection" },
    );
    let finishTurn!: () => void;
    const completion = new Promise<Record<string, never>>((resolve) => {
      finishTurn = () => resolve({});
    });
    const sendInput = vi.fn().mockImplementation(() => {
      gateway.ingest("session-1", pendingTurnStarted);
      return {
        kind: "started_turn",
        turnId: "turn-pending-projection",
        completion,
      };
    });
    const record = {
      app: { sessionId: "session-1", sendInput },
      workspace: { workspacePath: "/work" },
      persistence: "immediate",
      traceContext: { traceId: "trace-1" },
    } as unknown as V4SessionRecordView;
    const executor = new V4CommandExecutor({
      getRecord: (sessionId) => (sessionId === "session-1" ? record : undefined),
      afterLegacyStateMutation: async () => {},
    });
    host.executeImpl = (envelope, admission) => executor.execute(envelope, admission);

    await expect(
      gateway.handleCommand(
        commandParams({
          commandId: "cmd-pending-projection",
          payload: {
            text: "你好",
            modelSelection: { providerId: "glm", modelId: "glm-4-air" },
            mode: "build",
          },
        }),
      ),
    ).resolves.toMatchObject({ status: "accepted" });
    expect(host.inputCancellations).toEqual([]);

    // 修复原因：raw gap 只延迟 projection；它不能反向撤销 Core 已完成的 prompt admission。
    gateway.ingest("session-1", missing);
    const subscribed = await gateway.subscribe(
      subscribeParams({ connectionId: "post-gap-recovery" }),
    );
    const snapshot =
      subscribed.initialFrame?.payload.kind === "snapshot"
        ? subscribed.initialFrame.payload.snapshot
        : null;
    expect(
      snapshot?.rows.window.some(
        (row) => row.kind === "userInput" && row.sourceCommandId === "cmd-pending-projection",
      ),
    ).toBe(true);
    finishTurn();
  });

  it("Core admission ACK 不等待 TurnStarted projection；旧 revision retry/file rewind 只 stale", async () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const log = new EventLog();
    gateway.ingest("session-1", sessionCreated(log));
    gateway.ingest(
      "session-1",
      log.push(
        SessionEventType.TurnStarted,
        {
          turnNumber: 1,
          input: "旧问题",
          messageId: "msg-user-old",
          intent: {
            sourceCommandId: "cmd-old",
            queueItemId: "queue-old",
            clientId: "client-old",
            kind: "sendText",
            text: "旧问题",
            requestedDelivery: "startNow",
            admittedDelivery: "startNow",
          },
        },
        { turnId: "turn-old" },
      ),
    );
    gateway.ingest(
      "session-1",
      log.push(
        SessionEventType.ModelStreaming,
        {
          kind: "text_start",
          delta: "",
          done: false,
          assistantMessageId: "msg-assistant-old",
        },
        { turnId: "turn-old" },
      ),
    );
    gateway.ingest(
      "session-1",
      log.push(
        SessionEventType.ModelStreaming,
        { kind: "text_delta", delta: "旧回答", done: false },
        { turnId: "turn-old" },
      ),
    );
    gateway.ingest(
      "session-1",
      log.push(
        SessionEventType.ModelComplete,
        {
          content: "旧回答",
          stopReason: "stop",
          querySource: "main_turn",
          contextWindow: 200_000,
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
          fileChanges: {
            files: 1,
            additions: 1,
            deletions: 0,
            items: [
              {
                path: "/work/a.ts",
                additions: 1,
                deletions: 0,
                writeCount: 1,
              },
            ],
          },
        },
        { turnId: "turn-old" },
      ),
    );
    gateway.ingest(
      "session-1",
      log.push(
        SessionEventType.TurnComplete,
        {
          response: "旧回答",
          tokenCount: 2,
          toolCallCount: 0,
          duration: 1,
          resultType: "success",
        },
        { turnId: "turn-old" },
      ),
    );
    const initial = (await gateway.subscribe(subscribeParams())).initialFrame;
    const snapshot = initial?.payload.kind === "snapshot" ? initial.payload.snapshot : undefined;
    const assistant = snapshot?.rows.window.find(
      (row) => row.kind === "assistantText" && row.actions?.canRetry === true,
    );
    const header = snapshot?.rows.window.find(
      (row) => row.kind === "turnHeader" && row.actions?.canRewindFiles === true,
    );
    expect(assistant).toBeDefined();
    expect(header).toBeDefined();

    let finishTurn!: () => void;
    const turnGate = new Promise<Record<string, never>>((resolve) => {
      finishTurn = () => resolve({});
    });
    const sendInput = vi.fn().mockReturnValue({
      kind: "started_turn",
      turnId: "turn-new",
      completion: turnGate,
    });
    const submitPrompt = vi.fn().mockResolvedValue({});
    const applyWorkspaceFileRewind = vi.fn().mockResolvedValue({
      applied: true,
      preview: { canApply: true, safeFiles: [], unsafeFiles: [], ignoredFiles: [] },
      response: "applied",
    });
    const record = {
      app: {
        sessionId: "session-1",
        sendInput,
        submitPrompt,
        runtime: { applyWorkspaceFileRewind },
      },
      workspace: { workspacePath: "/work" },
      persistence: "immediate",
      traceContext: { traceId: "trace-1" },
    } as unknown as V4SessionRecordView;
    const executor = new V4CommandExecutor({
      getRecord: (sessionId) => (sessionId === "session-1" ? record : undefined),
      resolveRowActionTarget: (sessionId, target, action) =>
        gateway.resolveRowActionTarget(sessionId, target, action),
      afterLegacyStateMutation: async () => {},
    });
    host.executeImpl = (envelope, admission) => executor.execute(envelope, admission);

    const sending = gateway.handleCommand(
      commandParams({
        commandId: "cmd-new",
        baseRevision: snapshot!.revision,
        payload: {
          text: "你好",
          modelSelection: { providerId: "glm", modelId: "glm-4-air" },
          mode: "build",
        },
      }),
    );
    await vi.waitFor(() => expect(sendInput).toHaveBeenCalledTimes(1));
    await expect(sending).resolves.toMatchObject({ status: "accepted" });

    // ACK 只确认输入已准入；投影 revision 必须由实际事件推进，不能由 ACK 自行制造。
    gateway.ingest(
      "session-1",
      log.push(
        SessionEventType.TurnStarted,
        { turnNumber: 2, input: "你好", messageId: "msg-user-new" },
        { turnId: "turn-new" },
      ),
    );

    const staleRetry = gateway.handleCommand(
      commandParams({
        commandId: "cmd-stale-retry",
        type: "retryTurn",
        payload: { target: { rowId: assistant!.rowId, entityId: assistant!.entityId! } },
        baseRevision: snapshot!.revision,
        baseLogEpoch: snapshot!.logEpoch,
      }),
    );
    const staleFileRewind = gateway.handleCommand(
      commandParams({
        commandId: "cmd-stale-file",
        type: "applyFileRewind",
        payload: { target: { rowId: header!.rowId, entityId: header!.entityId! } },
        baseRevision: snapshot!.revision,
        baseLogEpoch: snapshot!.logEpoch,
      }),
    );

    await expect(staleRetry).resolves.toMatchObject({
      status: "stale",
      reasonCode: "proto.staleRevision",
    });
    await expect(staleFileRewind).resolves.toMatchObject({
      status: "stale",
      reasonCode: "proto.staleRevision",
    });
    expect(host.executed.map((envelope) => envelope.commandId)).toEqual(["cmd-new"]);
    expect(submitPrompt).not.toHaveBeenCalled();
    expect(applyWorkspaceFileRewind).not.toHaveBeenCalled();
    finishTurn();
  });

  it("logical TopicFrame 恰好 16MiB 接纳，UTF-8 后再多 1 byte 明确失败且不落 admission", async () => {
    const envelope = commandParams({
      commandId: "cmd-limit",
      payload: { text: "" },
    }) as CommandEnvelope;
    const admission = {
      admissionSeq: 1,
      admittedAt: 1_700_000_999_000,
      queueItemId: "queue_cmd-limit",
    };
    const probe = new ConversationTopicPublisher("session-1", "epoch-1", {
      now: () => 1_700_000_999_000,
    });
    const emptyBytes = probe.measureInputAdmissionProjectionBytes(envelope, admission);
    expect(emptyBytes).not.toBeNull();
    // emoji 验证按 UTF-8 字节而非 JS string.length 计数；其余 ASCII 精确补齐到 16MiB。
    const emoji = "🙂";
    const emojiBytes = Buffer.byteLength(JSON.stringify(emoji), "utf8") - 2;
    const text = `${"a".repeat(
      PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes - (emptyBytes as number) - emojiBytes,
    )}${emoji}`;
    const exactEnvelope = { ...envelope, payload: { text } };
    expect(probe.measureInputAdmissionProjectionBytes(exactEnvelope, admission)).toBe(
      PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes,
    );

    const acceptedHost = makeHost();
    const accepted = await makeGateway(acceptedHost).handleCommand(exactEnvelope);
    expect(accepted.status).toBe("accepted");
    expect(acceptedHost.inputAdmissions).toHaveLength(1);
    expect(acceptedHost.executed).toHaveLength(1);

    const rejectedHost = makeHost();
    const rejected = await makeGateway(rejectedHost).handleCommand({
      ...exactEnvelope,
      payload: { text: `${text}a` },
    });
    expect(rejected).toMatchObject({ status: "failed", reasonCode: "proto.payloadTooLarge" });
    expect(rejectedHost.inputAdmissions).toEqual([]);
    expect(rejectedHost.executed).toEqual([]);
  });

  it.each([
    [
      "sendGoalCommand",
      {
        text: "目标",
        displayText: "x".repeat(PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes),
      },
    ],
    [
      "createSession",
      {
        workspaceId: "/tmp/ws",
        firstInput: { text: "x".repeat(PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes) },
      },
    ],
    [
      "sendText",
      {
        text: "attachment",
        attachments: [
          {
            ref: "artifact://large",
            fileName: "x".repeat(PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes),
            mime: "application/octet-stream",
            bytes: 1,
          },
        ],
      },
    ],
  ] as const)("%s 的 firstInput/text/附件引用越界时不执行", async (type, payload) => {
    const host = makeHost();
    const ack = await makeGateway(host).handleCommand(
      commandParams({
        commandId: `cmd-${type}-large`,
        sessionId: type === "createSession" ? null : "session-1",
        type,
        payload,
      }),
    );
    expect(ack).toMatchObject({ status: "failed", reasonCode: "proto.payloadTooLarge" });
    expect(host.inputAdmissions).toEqual([]);
    expect(host.executed).toEqual([]);
  });

  // 2026-07-05 语义修正：handleCommand 等待副作用完成后随响应返回终态 ACK
  //（spec §6.2/§6.4「accepted 即时带 result」），settle 仍固化结果供 duplicate 重放。
  it("同 commandId 并发与 ACK 丢失重试等待同一 final result，只执行一次", async () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const log = new EventLog();
    gateway.ingest("session-1", sessionCreated(log));

    // 用手动 deferred 卡住副作用，验证在途重试语义（§6.3）。
    let releaseExecute!: () => void;
    host.executeImpl = async () => {
      await new Promise<void>((resolveExecute) => {
        releaseExecute = resolveExecute;
      });
      return { type: "forkAssistant" as const, sessionId: "child-same" };
    };

    const first = gateway.handleCommand(commandParams());
    await vi.waitFor(() => expect(host.executed).toHaveLength(1));
    let retrySettled = false;
    const inflightRetryPromise = gateway.handleCommand(commandParams()).then((ack) => {
      retrySettled = true;
      return ack;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(retrySettled).toBe(false);
    expect(host.executed).toHaveLength(1);
    expect(host.executed[0]!.type).toBe("sendText");
    expect(host.inputAdmissions).toEqual([{ commandId: "cmd-1", queueItemId: "queue_cmd-1" }]);

    releaseExecute();
    const [ack, inflightRetry] = await Promise.all([first, inflightRetryPromise]);
    expect(ack).toMatchObject({
      status: "accepted",
      result: { type: "forkAssistant", sessionId: "child-same" },
    });
    expect(inflightRetry).toMatchObject({
      status: "duplicate",
      result: { type: "forkAssistant", sessionId: "child-same" },
    });

    // settle 固化后重试回 duplicate，副作用仍只执行一次。
    const replay = await gateway.handleCommand(commandParams());
    expect(replay.status).toBe("duplicate");
    expect(replay.result).toEqual({ type: "forkAssistant", sessionId: "child-same" });
    expect(host.executed).toHaveLength(1);
  });

  it("admission projection measure 异常 settle 同一 failed final 并释放 session FIFO", async () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const log = new EventLog();
    gateway.ingest("session-1", sessionCreated(log));
    const measure = vi
      .spyOn(ConversationTopicPublisher.prototype, "measureInputAdmissionProjectionBytes")
      .mockImplementationOnce(() => {
        throw new Error("measure exploded");
      });
    try {
      const first = gateway
        .handleCommand(commandParams({ commandId: "cmd-measure-fault" }))
        .catch((error) => ({ thrown: String(error) }));
      const duplicate = gateway
        .handleCommand(commandParams({ commandId: "cmd-measure-fault" }))
        .catch((error) => ({ thrown: String(error) }));
      const pair = await Promise.race([
        Promise.all([first, duplicate]),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 100)),
      ]);

      expect(pair).toEqual([
        expect.objectContaining({
          commandId: "cmd-measure-fault",
          status: "failed",
          reasonCode: "fault.command.executionFailed",
          message: "measure exploded",
        }),
        expect.objectContaining({
          commandId: "cmd-measure-fault",
          status: "failed",
          reasonCode: "fault.command.executionFailed",
          message: "measure exploded",
        }),
      ]);
      expect(host.executed).toHaveLength(0);

      const next = await gateway.handleCommand(
        commandParams({ commandId: "cmd-after-measure-fault" }),
      );
      expect(next.status).toBe("accepted");
      expect(host.executed).toHaveLength(1);
    } finally {
      measure.mockRestore();
    }
  });

  it("输入执行失败：durable admission 收口 cancelled，不遗留 restart discarded 假象", async () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const log = new EventLog();
    gateway.ingest("session-1", sessionCreated(log));
    host.executeImpl = async () => {
      throw Object.assign(new Error("runtime rejected input"), {
        reasonCode: "fault.command.inputRejected",
      });
    };

    const ack = await gateway.handleCommand(commandParams({ commandId: "command-rejected" }));
    expect(ack).toMatchObject({
      commandId: "command-rejected",
      status: "failed",
      reasonCode: "fault.command.inputRejected",
    });
    expect(host.inputCancellations).toEqual([
      {
        commandId: "command-rejected",
        queueItemId: "queue_command-rejected",
        reason: "fault.command.inputRejected",
      },
    ]);
  });

  it("createSession：sessionId=null 放行，ACK 即时携带 result.sessionId", async () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    host.executeImpl = async () => ({
      type: "createSession",
      sessionId: "session-new",
    });

    const ack = await gateway.handleCommand(
      commandParams({
        commandId: "cmd-create",
        sessionId: null,
        type: "createSession",
        payload: { workspaceId: "/tmp/ws" },
      }),
    );
    expect(ack.status).toBe("accepted");
    // spec §6.4：createSession 的 accepted ACK 必带 result.sessionId
    //（曾经只回初始 ACK，客户端拿不到 sessionId —— M3 全链路验收抓出的 bug）。
    expect(ack.result).toEqual({
      type: "createSession",
      sessionId: "session-new",
    });
    expect(host.executed).toHaveLength(1);

    // settle 固化后 duplicate 回放携带执行结果。
    const replay = await gateway.handleCommand(
      commandParams({
        commandId: "cmd-create",
        sessionId: null,
        type: "createSession",
        payload: { workspaceId: "/tmp/ws" },
      }),
    );
    expect(replay.status).toBe("duplicate");
    expect(replay.result).toEqual({
      type: "createSession",
      sessionId: "session-new",
    });
  });

  it("未知会话 → rejected proto.sessionNotFound，不触发执行", async () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const ack = await gateway.handleCommand(commandParams({ sessionId: "ghost" }));
    expect(ack.status).toBe("rejected");
    expect(ack.reasonCode).toBe("proto.sessionNotFound");
    expect(host.executed).toHaveLength(0);
  });

  it("未接线命令 → ACK failed fault.command.notImplemented（failed 重试保真）", async () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const log = new EventLog();
    gateway.ingest("session-1", sessionCreated(log));
    host.executeImpl = async (envelope) => {
      throw new V4CommandNotImplementedError(envelope.type);
    };

    // compact 是可排队输入命令，不做 CAS；否则 renderer 在 running snapshot 上提交后
    // 会因并发 stream revision 变化而无意义 stale。
    const ack = await gateway.handleCommand(
      commandParams({
        commandId: "cmd-compact",
        type: "compact",
        payload: {},
      }),
    );
    expect(ack.status).toBe("failed");
    expect(ack.reasonCode).toBe("fault.command.notImplemented");
    expect(host.errors).toHaveLength(1);
    expect(host.errors[0]!.scope).toBe("v4.command.execute");

    const replay = await gateway.handleCommand(
      commandParams({
        commandId: "cmd-compact",
        type: "compact",
        payload: {},
      }),
    );
    expect(replay.status).toBe("failed");
    expect(replay.reasonCode).toBe("fault.command.notImplemented");
  });

  it("commands/query 保持输入顺序，并与 command in-flight 共用 gate", async () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const log = new EventLog();
    gateway.ingest("session-1", sessionCreated(log));
    let releaseExecute!: () => void;
    host.executeImpl = async () =>
      new Promise<void>((resolve) => {
        releaseExecute = resolve;
      });

    const executing = gateway.handleCommand(commandParams({ commandId: "command-running" }));
    await vi.waitFor(() => expect(host.executed).toHaveLength(1));
    host.persistentCommands.discarded.set("session-1\0command-discarded", {
      commandId: "command-discarded",
      status: "failed",
      reasonCode: "fault.command.inputDiscardedOnRestart",
      revisionAtDecision: 0,
    });
    let querySettled = false;
    const resultPromise = gateway
      .queryCommands({
        commands: [
          { sessionId: "session-1", commandId: "command-running" },
          { sessionId: "session-1", commandId: "command-missing" },
          { sessionId: "session-1", commandId: "command-discarded" },
        ],
      })
      .then((result) => {
        querySettled = true;
        return result;
      });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(querySettled).toBe(false);
    releaseExecute();
    await executing;
    const result = await resultPromise;
    expect(result.results.map((item) => item.result)).toEqual([
      {
        commandId: "command-running",
        status: "accepted",
        revisionAtDecision: 0,
      },
      "unknown",
      {
        commandId: "command-discarded",
        status: "failed",
        reasonCode: "fault.command.inputDiscardedOnRestart",
        revisionAtDecision: 0,
      },
    ]);
  });

  it("busy input event pin 完整 intent；settle/LRU 不会把 live queue 变 unknown", async () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const log = new EventLog();
    gateway.ingest("session-1", sessionCreated(log));
    host.executeImpl = async (envelope, admission) => {
      const queueItemId = admission?.queueItemId ?? "missing-queue-id";
      gateway.ingest(
        "session-1",
        log.push(
          SessionEventType.TurnSteerQueued,
          {
            pendingInputId: queueItemId,
            inputId: envelope.commandId,
            input: "queued text",
            inputPreview: "queued text",
            inputSize: 11,
            delivery: "queue",
            targetTurnId: "turn-1",
            queueLength: 1,
            intent: {
              sourceCommandId: envelope.commandId,
              queueItemId,
              clientId: envelope.clientId,
              kind: "sendText",
              admissionSeq: admission?.admissionSeq ?? -1,
              admittedAt: admission?.admittedAt ?? -1,
              requestedDelivery: "queue",
              admittedDelivery: "queue",
            },
          },
          { turnId: "turn-1" },
        ),
      );
      return undefined;
    };

    const ack = await gateway.handleCommand(
      commandParams({ commandId: "command-live", clientId: "mobile-client" }),
    );
    expect(ack.status).toBe("accepted");
    const queried = await gateway.queryCommands({
      commands: [{ sessionId: "session-1", commandId: "command-live" }],
    });
    expect(queried.results[0]?.result).toMatchObject({
      commandId: "command-live",
      status: "accepted",
    });
    const subscribed = await gateway.subscribe(subscribeParams());
    expect(
      subscribed.initialFrame?.payload.kind === "snapshot"
        ? subscribed.initialFrame.payload.snapshot.queue.items[0]
        : null,
    ).toMatchObject({
      sourceCommandId: "command-live",
      queueItemId: "queue_command-live",
      clientId: "mobile-client",
      order: { admissionSeq: 1 },
      dispatch: { state: "queued" },
    });
  });

  it("send-now remove 不提前解 pin；只在 session_input 原子 promotion 后释放", async () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const log = new EventLog();
    gateway.ingest("session-1", sessionCreated(log));
    host.executeImpl = async (envelope, admission) => {
      gateway.ingest(
        "session-1",
        log.push(
          SessionEventType.TurnSteerQueued,
          {
            pendingInputId: admission!.queueItemId,
            inputId: envelope.commandId,
            input: "queued text",
            inputPreview: "queued text",
            inputSize: 11,
            delivery: "queue",
            targetTurnId: "turn-1",
            queueLength: 1,
            intent: {
              sourceCommandId: envelope.commandId,
              queueItemId: admission!.queueItemId,
              clientId: envelope.clientId,
              kind: "sendText",
              admissionSeq: admission!.admissionSeq,
              admittedAt: admission!.admittedAt,
              requestedDelivery: "queue",
              admittedDelivery: "queue",
            },
          },
          { turnId: "turn-1" },
        ),
      );
      return undefined;
    };
    await gateway.handleCommand(commandParams({ commandId: "command-promoting" }));

    gateway.ingest(
      "session-1",
      log.push(
        SessionEventType.TurnSteerDiscarded,
        {
          pendingInputIds: ["queue_command-promoting"],
          reason: "promoted",
          targetTurnId: "turn-1",
        },
        { turnId: "turn-1" },
      ),
    );
    host.executeImpl = async () => undefined;
    for (let index = 0; index <= PROTOCOL_V4_LIMITS.idempotencyTablePerSession; index += 1) {
      await gateway.handleCommand(
        commandParams({
          commandId: `pre-promotion-churn-${index}`,
          payload: {},
          type: "stop",
        }),
      );
    }
    const beforePromotion = await gateway.queryCommands({
      commands: [{ sessionId: "session-1", commandId: "command-promoting" }],
    });
    expect(beforePromotion.results[0]?.result).toMatchObject({ status: "accepted" });

    gateway.ingest(
      "session-1",
      log.push(SessionEventType.SessionInputPromoted, {
        pendingInputId: "queue_command-promoting",
        sourceCommandId: "command-promoting",
        messageId: "message-promoting",
      }),
    );
    for (let index = 0; index <= PROTOCOL_V4_LIMITS.idempotencyTablePerSession; index += 1) {
      await gateway.handleCommand(
        commandParams({
          commandId: `post-promotion-churn-${index}`,
          payload: {},
          type: "stop",
        }),
      );
    }
    const afterPromotion = await gateway.queryCommands({
      commands: [{ sessionId: "session-1", commandId: "command-promoting" }],
    });
    expect(afterPromotion.results[0]?.result).toBe("unknown");
  });
});

// 会话工具设计 0.7：长回合的 turnHeader 滚出快照尾窗后，Host 的 wait 依赖 owner 在
// commands/query 中给出的回合状态；global bucket 不带该字段。
describe("commands/query 回合状态（header 在尾窗之外）", () => {
  function turnComplete(log: EventLog, turnId: string): SessionEvent {
    return log.push(
      SessionEventType.TurnComplete,
      { duration: 1, response: "done", resultType: "success", tokenCount: 1, toolCallCount: 0 },
      { turnId },
    );
  }

  it("按 sourceCommandId 返回全量投影中的回合状态", async () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const log = new EventLog();
    gateway.ingest("session-1", sessionCreated(log));
    gateway.ingest(
      "session-1",
      log.push(
        SessionEventType.TurnStarted,
        { turnNumber: 1, input: "long", inputId: "command-long" },
        { turnId: "turn-long" },
      ),
    );
    gateway.ingest("session-1", turnComplete(log, "turn-long"));
    for (let index = 0; index < PROTOCOL_V4_LIMITS.snapshotTailWindowRows; index += 1) {
      const turnId = `turn-after-${index}`;
      gateway.ingest(
        "session-1",
        log.push(
          SessionEventType.TurnStarted,
          { turnNumber: index + 2, input: "next", inputId: `command-after-${index}` },
          { turnId },
        ),
      );
      gateway.ingest("session-1", turnComplete(log, turnId));
    }

    const subscribed = await gateway.subscribe(subscribeParams());
    const wire =
      subscribed.initialFrame?.payload.kind === "snapshot"
        ? subscribed.initialFrame.payload.snapshot
        : undefined;
    expect(wire?.rows.window.length).toBe(PROTOCOL_V4_LIMITS.snapshotTailWindowRows);
    expect(
      wire?.rows.window.some(
        (row) => row.kind === "turnHeader" && row.sourceCommandId === "command-long",
      ),
    ).toBe(false);

    const query = await gateway.queryCommands({
      commands: [
        { sessionId: "session-1", commandId: "command-long" },
        { sessionId: null, commandId: "command-long" },
        { sessionId: "session-1", commandId: "command-missing" },
      ],
    });
    expect(query.results[0]?.turn).toEqual({
      turnId: expect.any(String),
      state: "completedSuccess",
    });
    expect(query.results[1]?.turn).toBeUndefined();
    expect(query.results[2]?.turn).toBeUndefined();
  });
});

// R-19（10 §4.2.3）：config 种子接线——ensurePublisher 创建即注入、hydration 收尾补注，
// 种子不产 delta / 不 bump revision，日志事件值优先。
describe("config 种子（R-19 gateway 接线）", () => {
  const SEED: SessionConfigSeed = {
    provider: "prov-a",
    model: "model-1",
    thought: "high",
    mode: "yolo",
  };

  it("live 路径：ingest 建 publisher 时种入，snapshot.config = runtime 真值且 revision 不动", async () => {
    const host = makeHost();
    host.configSeeds.set("session-1", SEED);
    const gateway = makeGateway(host);
    const log = new EventLog();
    gateway.ingest("session-1", sessionCreated(log));

    const result = await gateway.subscribe(subscribeParams());
    expect(result.initialFrame!.payload.kind).toBe("snapshot");
    if (result.initialFrame!.payload.kind !== "snapshot") return;
    const snapshot = result.initialFrame!.payload.snapshot;
    expect(snapshot.config).toMatchObject({
      provider: "prov-a",
      model: "model-1",
      thought: "high",
      mode: "yolo",
    });
    // 种子是初值不是变化：不产 delta、revision 保持 0（CAS 不变量不受种子影响）。
    expect(snapshot.revision).toBe(0);
  });

  it("冷恢复路径：hydration 重放后补种——日志 ModelSelected 优先，未触碰的 mode 吃种子", async () => {
    const host = makeHost();
    host.configSeeds.set("session-1", SEED);
    const log = new EventLog();
    sessionCreated(log);
    log.push(SessionEventType.ModelSelected, {
      modelSelection: {
        providerId: "prov-b",
        modelId: "model-2",
        options: { reasoningLevel: "low" },
      },
    });
    host.persistedEvents.set("session-1", log.events);
    const gateway = makeGateway(host);

    const result = await gateway.subscribe(subscribeParams());
    if (result.initialFrame!.payload.kind !== "snapshot") {
      throw new Error("expected snapshot frame");
    }
    const snapshot = result.initialFrame!.payload.snapshot;
    // 模型区：日志有 ModelSelected → 日志值权威（种子不覆盖）。
    expect(snapshot.config).toMatchObject({
      provider: "prov-b",
      model: "model-2",
      thought: "low",
    });
    // mode：日志无 SessionModeChanged → 吃种子（历史会话 resume 恢复的持久化偏好）。
    expect(snapshot.config.mode).toBe("yolo");
  });

  it("种子钩子抛错：防御式吞掉进 onError，conversation 主路径不受影响", async () => {
    const host = makeHost();
    const gateway = new ConversationV4Gateway(
      {
        sessionExists: (sessionId) => host.sessions.has(sessionId),
        emitWireFrame: (wire) => collectCompleteConversationFrame(host.frames, wire),
        executeCommand: async () => undefined,
        getSessionConfigSeed: () => {
          throw new Error("seed boom");
        },
        onError: (scope, error) => host.errors.push({ scope, error }),
      },
      { now: () => 1_700_000_999_000, createLogEpoch: () => "epoch-1" },
    );
    const log = new EventLog();
    gateway.ingest("session-1", sessionCreated(log));
    const result = await gateway.subscribe(subscribeParams());
    expect(result.initialFrame!.payload.kind).toBe("snapshot");
    expect(host.errors.some((entry) => entry.scope === "v4.configSeed")).toBe(true);
  });
});

describe("ConversationV4Gateway.collectMemoryDiagnostics", () => {
  it("返回 publisher / detached 子 session / raw seq 状态表的只读大小", () => {
    const gateway = makeGateway(makeHost());
    expect(gateway.collectMemoryDiagnostics()).toEqual({
      publishers: 0,
      detachedLive: 0,
      detachedTerminal: 0,
      rawSeqStates: 0,
      hydrations: 0,
      historyOpenings: 0,
      binaryCacheEntries: 0,
      binaryCacheBytes: 0,
    });
  });
});

describe("detached subagent child publisher 生命周期（session-idle-deactivation.md）", () => {
  function childTurnComplete(log: EventLog): SessionEvent {
    return log.push(
      SessionEventType.TurnComplete,
      { duration: 1, response: "done", resultType: "success", tokenCount: 1, toolCallCount: 0 },
      { turnId: "turn-1" },
    );
  }

  it("父 record 释放时连带释放没有 record 的 detached child publisher", () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    gateway.ingest("session-1", sessionCreated(new EventLog("session-1")));
    const childLog = new EventLog("child-1");
    gateway.ingestDetachedLiveSession("child-1", sessionCreated(childLog), "session-1");
    gateway.ingestDetachedLiveSession("child-1", textDelta(childLog, "x"), "session-1");
    expect(gateway.collectMemoryDiagnostics()).toMatchObject({ publishers: 2, detachedLive: 1 });

    gateway.disposeSession("session-1");

    expect(gateway.collectMemoryDiagnostics()).toMatchObject({
      publishers: 0,
      detachedLive: 0,
      detachedTerminal: 0,
    });
  });

  it("child 已有自己的 record 时，父释放不碰它，交给 child 自己的生命周期", () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    gateway.ingest("session-1", sessionCreated(new EventLog("session-1")));
    const childLog = new EventLog("child-2");
    gateway.ingestDetachedLiveSession("child-2", sessionCreated(childLog), "session-1");
    host.sessions.add("child-2");

    gateway.disposeSession("session-1");
    expect(gateway.collectMemoryDiagnostics()).toMatchObject({ publishers: 1, detachedLive: 1 });

    gateway.disposeSession("child-2");
    expect(gateway.collectMemoryDiagnostics()).toMatchObject({ publishers: 0, detachedLive: 0 });
  });

  it("时间兜底：child 终态后无订阅者且超过 grace 才释放；有订阅者不释放", async () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    gateway.ingest("session-1", sessionCreated(new EventLog("session-1")));
    const childLog = new EventLog("child-3");
    gateway.ingestDetachedLiveSession("child-3", sessionCreated(childLog), "session-1");
    gateway.ingestDetachedLiveSession("child-3", textDelta(childLog, "x"), "session-1");
    gateway.ingestDetachedLiveSession("child-3", childTurnComplete(childLog), "session-1");
    const terminalAt = Date.now();
    expect(gateway.collectMemoryDiagnostics()).toMatchObject({ detachedTerminal: 1 });

    // grace 内不释放。
    expect(gateway.pruneDetachedChildPublishers(terminalAt + 60_000)).toBe(0);

    // 有订阅者时即使超过 grace 也不释放。
    const { ack } = await gateway.subscribe(subscribeParams({ topic: "conversation/child-3" }));
    expect(gateway.pruneDetachedChildPublishers(terminalAt + 3 * 60_000)).toBe(0);
    expect(gateway.collectMemoryDiagnostics()).toMatchObject({ publishers: 2 });

    gateway.unsubscribe({
      topic: "conversation/child-3",
      subscriptionId: ack.subscriptionId,
      connectionId: "conn-1",
    });
    expect(gateway.pruneDetachedChildPublishers(terminalAt + 3 * 60_000)).toBe(1);
    expect(gateway.collectMemoryDiagnostics()).toMatchObject({
      publishers: 1,
      detachedLive: 0,
      detachedTerminal: 0,
    });
    // 父 record 后续释放不受影响（child 映射已摘除）。
    gateway.disposeSession("session-1");
    expect(gateway.collectMemoryDiagnostics()).toMatchObject({ publishers: 0 });
  });

  it("child 再次 turn_started 撤销终态记录，时间兜底不再释放它", () => {
    const host = makeHost();
    const gateway = makeGateway(host);
    const childLog = new EventLog("child-4");
    gateway.ingestDetachedLiveSession("child-4", sessionCreated(childLog), "session-1");
    gateway.ingestDetachedLiveSession("child-4", childTurnComplete(childLog), "session-1");
    gateway.ingestDetachedLiveSession(
      "child-4",
      childLog.push(
        SessionEventType.TurnStarted,
        { turnNumber: 2, input: "again" },
        { turnId: "turn-2" },
      ),
      "session-1",
    );
    expect(gateway.collectMemoryDiagnostics()).toMatchObject({ detachedTerminal: 0 });
    expect(gateway.pruneDetachedChildPublishers(Date.now() + 10 * 60_000)).toBe(0);
    expect(gateway.collectMemoryDiagnostics()).toMatchObject({ publishers: 1, detachedLive: 1 });
  });
});
