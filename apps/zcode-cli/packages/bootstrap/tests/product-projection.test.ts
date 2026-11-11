// ProductProjection 黄金测试首批（M2，docs/v4-refactor/13-golden-test-mapping）。
// 形态：事件序列进、投影断言出（L1）。测试名携带 catalog 组别，供 coverage matrix 对账。
import { describe, expect, it, vi } from "vitest";
import type {
  EventId,
  SessionEvent,
  SessionEventType as SessionEventTypeUnion,
  SessionId,
  TraceId,
  TurnId,
} from "@zcode/contracts";
import { HookEventName, SessionEventType, ModelErrorCode } from "@zcode/contracts";
import type {
  ConversationDelta,
  ConversationSnapshot,
  DeliveryProfile,
} from "@zcode/shared/zcode-protocol-v4";
import {
  DELIVERY_PROFILES,
  WORKFLOW_RUNS_LIMITS,
  applyConversationDeltas,
  coalesceConversationDeltas,
  conversationSnapshotSchema,
  filterConversationDeltasForProfile,
  hookInvocationRowSchema,
  workflowRunStepCounts,
} from "@zcode/shared/zcode-protocol-v4";
import { ProductProjection } from "../src/zcode-protocol-v4/index.js";

// ── 事件序列构造器 ──

class EventLog {
  private seq = 0;
  readonly events: SessionEvent[] = [];

  constructor(private readonly sessionId = "session-1") {}

  push(
    type: SessionEventTypeUnion,
    payload: unknown,
    opts: { timestampMs?: number; turnId?: string } = {},
  ): SessionEvent {
    this.seq += 1;
    const event: SessionEvent = {
      id: `event-${this.seq}` as EventId,
      sessionId: this.sessionId as SessionId,
      turnId: opts.turnId as TurnId | undefined,
      type,
      timestamp: new Date(opts.timestampMs ?? 1_700_000_000_000 + this.seq * 1000),
      traceId: "trace-1" as TraceId,
      sequenceNumber: this.seq,
      payload,
    };
    this.events.push(event);
    return event;
  }
}

function basicTurnEvents(log: EventLog, turnId = "turn-1"): void {
  log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
  log.push(
    SessionEventType.TurnStarted,
    { turnNumber: 1, input: "写一个 hello world" },
    { turnId },
  );
  log.push(
    SessionEventType.ModelStreaming,
    { kind: "text_start", delta: "", done: false },
    { turnId },
  );
  log.push(
    SessionEventType.ModelStreaming,
    { kind: "text_delta", delta: "Hello ", done: false },
    { turnId },
  );
  log.push(
    SessionEventType.ModelStreaming,
    { kind: "text_delta", delta: "world", done: false },
    { turnId },
  );
  log.push(
    SessionEventType.ModelStreaming,
    { kind: "text_end", delta: "", done: false },
    { turnId },
  );
  log.push(
    SessionEventType.ModelComplete,
    {
      content: "Hello world",
      stopReason: "end_turn",
      querySource: "main_turn",
      contextWindow: 200_000,
      usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 40, cacheWriteTokens: 10 },
    },
    { turnId },
  );
  log.push(
    SessionEventType.TurnComplete,
    {
      response: "Hello world",
      tokenCount: 30,
      toolCallCount: 0,
      duration: 5000,
      resultType: "success",
    },
    { turnId },
  );
}

function runAll(events: readonly SessionEvent[]): {
  projection: ProductProjection;
  deltasPerEvent: ConversationDelta[][];
  snapshots: ConversationSnapshot[];
} {
  const projection = new ProductProjection("session-1", "epoch-1");
  const deltasPerEvent: ConversationDelta[][] = [];
  const snapshots: ConversationSnapshot[] = [projection.getSnapshot()];
  for (const event of events) {
    deltasPerEvent.push(projection.applyEvent(event));
    snapshots.push(projection.getSnapshot());
  }
  return { projection, deltasPerEvent, snapshots };
}

function inputTextAppends(deltas: readonly ConversationDelta[]): string[] {
  return deltas.flatMap((delta) =>
    delta.op === "row.delta" && delta.path === "inputText" ? [delta.append] : [],
  );
}

// ── A 组：基础 turn 生命周期 ──

describe("ProductProjection 黄金测试（L1）", () => {
  it("Highspeed 单 Turn output tokens 由权威投影累计且不受快照观察时机影响", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    log.push(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: "first", inputId: "command-1", messageId: "user-1" },
      { turnId: "turn-1" },
    );
    for (const outputTokens of [5, 7]) {
      log.push(
        SessionEventType.ModelComplete,
        {
          content: "step",
          stopReason: "end_turn",
          querySource: "main_turn",
          usage: { inputTokens: 10, outputTokens },
        },
        { turnId: "turn-1" },
      );
    }
    log.push(
      SessionEventType.TurnComplete,
      { response: "done", tokenCount: 12, toolCallCount: 1, duration: 100, resultType: "success" },
      { turnId: "turn-1" },
    );
    log.push(
      SessionEventType.TurnStarted,
      { turnNumber: 2, input: "second", inputId: "command-2", messageId: "user-2" },
      { turnId: "turn-2" },
    );
    log.push(
      SessionEventType.ModelComplete,
      {
        content: "done",
        stopReason: "end_turn",
        querySource: "main_turn",
        usage: { inputTokens: 8, outputTokens: 4 },
      },
      { turnId: "turn-2" },
    );
    log.push(
      SessionEventType.TurnComplete,
      { response: "done", tokenCount: 4, toolCallCount: 0, duration: 50, resultType: "success" },
      { turnId: "turn-2" },
    );

    const snapshot = runAll(log.events).projection.getSnapshot();
    const headers = snapshot.rows.window.filter((row) => row.kind === "turnHeader");
    expect(headers).toEqual([
      expect.objectContaining({ sourceCommandId: "command-1", outputTokens: 12 }),
      expect.objectContaining({ sourceCommandId: "command-2", outputTokens: 4 }),
    ]);
    expect(conversationSnapshotSchema.parse(snapshot).rows.window).toEqual(snapshot.rows.window);
  });

  it("Highspeed turn 终态持久化 CLI 聚合的模型/工具真实耗时", () => {
    const log = new EventLog();
    const turnId = "turn-highspeed-timing";
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    log.push(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: "measure", inputId: "command-highspeed-timing", messageId: "user-1" },
      { turnId, timestampMs: 1_700_000_000_000 },
    );
    log.push(
      SessionEventType.ModelNetworkStatus,
      {
        type: "model_request_completed",
        requestId: "request-1",
        providerId: "account:bigmodel-highspeed-card",
        modelId: "glm-5.3",
        transport: "sse",
        attempt: 1,
        maxAttempts: 1,
        durationMs: 400,
      },
      { turnId, timestampMs: 1_700_000_000_500 },
    );
    log.push(
      SessionEventType.ModelNetworkStatus,
      {
        type: "model_request_completed",
        requestId: "request-fallback",
        providerId: "account:bigmodel-individual-coding-plan",
        modelId: "glm-5.3",
        transport: "sse",
        attempt: 1,
        maxAttempts: 1,
        durationMs: 10_000,
      },
      { turnId, timestampMs: 1_700_000_000_700 },
    );
    log.push(
      SessionEventType.ToolCallScheduled,
      {
        toolCallId: "tool-1",
        toolName: "Bash",
        input: { command: "echo ok" },
        schedule: { parallelGroups: [["tool-1"]], executionOrder: ["tool-1"] },
      },
      { turnId, timestampMs: 1_700_000_001_000 },
    );
    log.push(
      SessionEventType.ToolCallStarted,
      { toolCallId: "tool-1", toolName: "Bash", startedAt: new Date(1_700_000_001_000) },
      { turnId, timestampMs: 1_700_000_001_100 },
    );
    log.push(
      SessionEventType.ToolCallResult,
      { toolCallId: "tool-1", result: { success: true, content: "ok" }, duration: 900 },
      { turnId, timestampMs: 1_700_000_002_000 },
    );
    log.push(
      SessionEventType.TurnComplete,
      {
        response: "done",
        tokenCount: 20,
        toolCallCount: 1,
        duration: 3_000,
        resultType: "success",
      },
      { turnId, timestampMs: 1_700_000_003_000 },
    );

    const header = runAll(log.events)
      .projection.getSnapshot()
      .rows.window.find((row) => row.kind === "turnHeader");
    expect(header).toMatchObject({
      activeMs: 3_000,
      modelDurationMs: 400,
      toolDurationMs: 900,
      otherDurationMs: 1_700,
    });
  });

  it("Highspeed 卡失效降级后只记录 fallback 时间，不改变分享资格", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    log.push(
      SessionEventType.TurnStarted,
      {
        turnNumber: 1,
        input: "accelerated prompt",
        messageId: "user-highspeed-expired",
        inputId: "command-highspeed-expired",
        intent: {
          sourceCommandId: "command-highspeed-expired",
          queueItemId: "queue-highspeed-expired",
          clientId: "desktop",
          kind: "sendText",
          text: "accelerated prompt",
          admissionSeq: 1,
          admittedAt: 1_700_000_000_000,
          requestedDelivery: "startNow",
          admittedDelivery: "startNow",
          highspeed: {
            schemaVersion: 1,
            cardId: "hsc-expired",
            taskId: "session-1",
            provider: "builtin:bigmodel-coding-plan",
            model: "GLM-5.3",
            issuedAt: 1_700_000_000_000,
            expiresAt: 1_700_000_300_000,
            regularTps: 80,
          },
        },
      },
      { turnId: "turn-highspeed-expired" },
    );
    log.push(
      SessionEventType.TurnExecutionModelFallback,
      {
        inputId: "command-highspeed-expired",
        reason: "highspeed_card_expired",
        fromModelSelection: { providerId: "account:bigmodel-highspeed-card", modelId: "GLM-5.3" },
        toModelSelection: { providerId: "builtin:bigmodel-coding-plan", modelId: "GLM-5.3" },
      },
      { timestampMs: 1_700_000_301_000, turnId: "turn-highspeed-expired" },
    );

    const { projection } = runAll(log.events);
    const row = projection.getSnapshot().rows.window.find((row) => row.kind === "userInput");
    expect(row).toMatchObject({
      highspeed: { fallbackAt: 1_700_000_301_000, fallbackReason: "highspeed_card_expired" },
    });
    expect(row?.highspeed).not.toHaveProperty("shareExcludedReason");
  });

  it("加速请求其他失败的降级同样写入 fallbackAt，并以 fallbackReason 区分提示文案", () => {
    // spec §2.2：任何失败都退回；Renderer 按 fallbackReason 选择“卡已到期”或“加速服务不可用”文案。
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    log.push(
      SessionEventType.TurnStarted,
      {
        turnNumber: 1,
        input: "accelerated prompt",
        messageId: "user-highspeed-failed",
        inputId: "command-highspeed-failed",
        intent: {
          sourceCommandId: "command-highspeed-failed",
          queueItemId: "queue-highspeed-failed",
          clientId: "desktop",
          kind: "sendText",
          text: "accelerated prompt",
          admissionSeq: 1,
          admittedAt: 1_700_000_000_000,
          requestedDelivery: "startNow",
          admittedDelivery: "startNow",
          highspeed: {
            schemaVersion: 1,
            cardId: "hsc-failed",
            taskId: "session-1",
            provider: "builtin:bigmodel-coding-plan",
            model: "GLM-5.3",
            issuedAt: 1_700_000_000_000,
            expiresAt: 1_700_000_300_000,
          },
        },
      },
      { turnId: "turn-highspeed-failed" },
    );
    log.push(
      SessionEventType.TurnExecutionModelFallback,
      {
        inputId: "command-highspeed-failed",
        reason: "highspeed_request_failed",
        fromModelSelection: { providerId: "account:bigmodel-highspeed-card", modelId: "GLM-5.3" },
        toModelSelection: { providerId: "builtin:bigmodel-coding-plan", modelId: "GLM-5.3" },
      },
      { timestampMs: 1_700_000_002_000, turnId: "turn-highspeed-failed" },
    );

    const { projection } = runAll(log.events);
    const row = projection.getSnapshot().rows.window.find((row) => row.kind === "userInput");
    expect(row).toMatchObject({
      highspeed: { fallbackAt: 1_700_000_002_000, fallbackReason: "highspeed_request_failed" },
    });
  });

  it("Highspeed 流式输出降级时中断废弃内容，并让原模型从新行继续", () => {
    const log = new EventLog();
    const turnId = "turn-highspeed-stream-fallback";
    const projection = new ProductProjection("session-1", "epoch-1");
    const apply = (type: SessionEventTypeUnion, payload: unknown): void => {
      projection.applyEvent(log.push(type, payload, { turnId }));
    };

    apply(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    apply(SessionEventType.TurnStarted, {
      turnNumber: 1,
      input: "accelerated prompt",
      messageId: "user-highspeed-stream-fallback",
      inputId: "command-highspeed-stream-fallback",
      intent: {
        sourceCommandId: "command-highspeed-stream-fallback",
        kind: "sendText",
        text: "accelerated prompt",
        requestedDelivery: "startNow",
        highspeed: {
          schemaVersion: 1,
          cardId: "hsc-stream-fallback",
          taskId: "session-1",
          provider: "builtin:bigmodel-coding-plan",
          model: "GLM-5.3",
          issuedAt: 1_700_000_000_000,
          expiresAt: 1_700_000_300_000,
        },
      },
    });
    apply(SessionEventType.ModelStreaming, {
      kind: "reasoning_delta",
      delta: "discarded reasoning",
      done: false,
    });
    apply(SessionEventType.ModelStreaming, {
      kind: "text_delta",
      delta: "discarded accelerated output",
      done: false,
    });
    apply(SessionEventType.ModelStreaming, {
      kind: "tool_input_start",
      delta: "",
      done: false,
      toolCallId: "tool-highspeed-orphan",
      toolName: "CreateWorkflow",
    });
    apply(SessionEventType.ModelStreaming, {
      kind: "tool_input_delta",
      delta: '{"script":"unfinished',
      done: false,
      toolCallId: "tool-highspeed-orphan",
    });

    apply(SessionEventType.TurnExecutionModelFallback, {
      inputId: "command-highspeed-stream-fallback",
      reason: "highspeed_request_failed",
      fromModelSelection: { providerId: "account:zai-highspeed-card", modelId: "GLM-5.3" },
      toModelSelection: { providerId: "user-provider", modelId: "user-model" },
    });

    const discardedRows = projection.getSnapshot().rows.window;
    expect(discardedRows.find((row) => row.kind === "reasoning")).toMatchObject({
      state: "interrupted",
      text: "discarded reasoning",
    });
    expect(discardedRows.find((row) => row.kind === "assistantText")).toMatchObject({
      state: "interrupted",
      text: "discarded accelerated output",
    });
    expect(
      discardedRows.find(
        (row) => row.kind === "toolCall" && row.toolCallId === "tool-highspeed-orphan",
      ),
    ).toMatchObject({ status: "cancelled", inputText: '{"script":"unfinished' });

    // 部分 provider 不发送 text_start；降级事件也必须清空旧 row identity，避免 delta 拼进废弃输出。
    apply(SessionEventType.ModelStreaming, {
      kind: "text_delta",
      delta: "fresh session-model output",
      done: false,
    });
    expect(
      projection
        .getSnapshot()
        .rows.window.filter((row) => row.kind === "assistantText")
        .map((row) => ({ state: row.state, text: row.text })),
    ).toEqual([
      { state: "interrupted", text: "discarded accelerated output" },
      { state: "streaming", text: "fresh session-model output" },
    ]);
  });

  it("终态指标更新是增量合并，不清除同一 Turn 已产生的 fallbackAt", () => {
    // CR-02 回归：Highspeed 请求 3402 → TurnExecutionModelFallback 写入 fallbackAt → 普通模型跑完 →
    // persistHighspeedTiming 发 HighspeedMetricsUpdated。旧实现整体替换 row.highspeed，payload 又不含
    // live 才有的 fallbackAt，降级 Toast 依赖的字段被清掉。
    const highspeedMeta = {
      schemaVersion: 1,
      cardId: "hsc-expired",
      taskId: "session-1",
      provider: "builtin:bigmodel-coding-plan",
      model: "GLM-5.3",
      issuedAt: 1_700_000_000_000,
      expiresAt: 1_700_000_300_000,
      regularTps: 80,
    };
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    log.push(
      SessionEventType.TurnStarted,
      {
        turnNumber: 1,
        input: "accelerated prompt",
        messageId: "user-highspeed-expired",
        inputId: "command-highspeed-expired",
        intent: {
          sourceCommandId: "command-highspeed-expired",
          queueItemId: "queue-highspeed-expired",
          clientId: "desktop",
          kind: "sendText",
          text: "accelerated prompt",
          admissionSeq: 1,
          admittedAt: 1_700_000_000_000,
          requestedDelivery: "startNow",
          admittedDelivery: "startNow",
          highspeed: highspeedMeta,
        },
      },
      { turnId: "turn-highspeed-expired" },
    );
    log.push(
      SessionEventType.TurnExecutionModelFallback,
      {
        inputId: "command-highspeed-expired",
        reason: "highspeed_card_expired",
        fromModelSelection: { providerId: "account:bigmodel-highspeed-card", modelId: "GLM-5.3" },
        toModelSelection: { providerId: "builtin:bigmodel-coding-plan", modelId: "GLM-5.3" },
      },
      { timestampMs: 1_700_000_301_000, turnId: "turn-highspeed-expired" },
    );
    log.push(
      SessionEventType.HighspeedMetricsUpdated,
      {
        entityId: "user-highspeed-expired",
        highspeed: {
          ...highspeedMeta,
          outputTokens: 120,
          durationMs: 3_000,
          modelDurationMs: 400,
          toolDurationMs: 900,
          otherDurationMs: 1_700,
        },
      },
      { timestampMs: 1_700_000_305_000, turnId: "turn-highspeed-expired" },
    );

    const { projection } = runAll(log.events);
    const row = projection.getSnapshot().rows.window.find((row) => row.kind === "userInput");
    expect(row).toMatchObject({
      highspeed: {
        fallbackAt: 1_700_000_301_000,
        outputTokens: 120,
        durationMs: 3_000,
        modelDurationMs: 400,
        toolDurationMs: 900,
        otherDurationMs: 1_700,
      },
    });
  });

  it("CUA response 的 reasoning、text 与 tool row 共享 assistantResponseId", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    log.push(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: "检查权限", messageId: "user-cua" },
      { turnId: "turn-cua" },
    );
    log.push(
      SessionEventType.ModelStreaming,
      {
        kind: "reasoning_start",
        delta: "",
        done: false,
        assistantMessageId: "assistant-cua",
        partId: "reasoning-cua",
      },
      { turnId: "turn-cua" },
    );
    log.push(
      SessionEventType.ModelStreaming,
      {
        kind: "text_start",
        delta: "",
        done: false,
        assistantMessageId: "assistant-cua",
        partId: "text-cua",
      },
      { turnId: "turn-cua" },
    );
    log.push(
      SessionEventType.ModelStreaming,
      {
        kind: "tool_input_start",
        delta: "",
        done: false,
        assistantMessageId: "assistant-cua",
        toolCallId: "call-cua",
        toolName: "mcp__computer-use__request_access",
      },
      { turnId: "turn-cua" },
    );
    log.push(
      SessionEventType.ToolCallScheduled,
      {
        toolCallId: "call-cua",
        assistantMessageId: "assistant-cua",
        toolName: "mcp__computer-use__request_access",
        input: {},
        schedule: { parallelGroups: [["call-cua"]], executionOrder: ["call-cua"] },
      },
      { turnId: "turn-cua" },
    );

    const rows = runAll(log.events).projection.getSnapshot().rows.window;
    expect(rows.find((row) => row.kind === "reasoning")?.assistantResponseId).toBe("assistant-cua");
    expect(rows.find((row) => row.kind === "assistantText")?.assistantResponseId).toBe(
      "assistant-cua",
    );
    expect(rows.find((row) => row.kind === "toolCall")?.assistantResponseId).toBe("assistant-cua");
  });

  it("projects the submitted model, mode and Plan onto the user input row", () => {
    // docs/ui/composer-edit-mode.md：编辑最后一条消息时工具栏载入它提交时的配置，与排队项编辑一致。
    // 配置来自该输入的 canonical intent；旧输入没有这些字段时行上也不带，前端沿用当前配置。
    const modelSelection = {
      providerId: "provider-a",
      modelId: "model-a",
      options: { reasoningLevel: "high" },
    };
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    log.push(
      SessionEventType.TurnStarted,
      {
        turnNumber: 1,
        input: "with config",
        inputId: "command-with-config",
        intent: {
          sourceCommandId: "command-with-config",
          kind: "sendText",
          text: "with config",
          admissionSeq: 1,
          admittedAt: 10,
          requestedDelivery: "startNow",
          admittedDelivery: "startNow",
          modelSelection,
          mode: "yolo",
          planEnabled: true,
        },
      },
      { turnId: "turn-config" },
    );
    log.push(
      SessionEventType.TurnStarted,
      { turnNumber: 2, input: "legacy input" },
      { turnId: "turn-legacy" },
    );

    const userRows = runAll(log.events)
      .projection.getSnapshot()
      .rows.window.filter((row) => row.kind === "userInput");
    expect(userRows[0]).toMatchObject({ modelSelection, mode: "yolo", planEnabled: true });
    expect(userRows[1]).not.toHaveProperty("modelSelection");
    expect(userRows[1]).not.toHaveProperty("mode");
    expect(userRows[1]).not.toHaveProperty("planEnabled");
  });

  it("projects the submitted config onto user rows drained from the queue or guide", () => {
    // 队列续跑/guide 注入的 real-user 行同样可编辑；提交配置必须与 TurnStarted 行一致投影，
    // 否则编辑时会误当作旧消息而沿用当前工具栏（MR 3454 评审 CR-01）。
    const turnId = "turn-drain-config";
    const modelSelection = { providerId: "provider-a", modelId: "model-a" };
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "hi" }, { turnId });
    log.push(
      SessionEventType.TurnSteerDrained,
      {
        pendingInputIds: ["pi-config"],
        targetTurnId: turnId,
        injectedMessageIds: ["message-config"],
        drainedInputs: [
          {
            pendingInputId: "pi-config",
            messageId: "message-config",
            text: "drained with config",
            delivery: "guide",
            intent: {
              sourceCommandId: "command-config",
              queueItemId: "pi-config",
              clientId: "desktop",
              kind: "sendText",
              admissionSeq: 1,
              admittedAt: 10,
              requestedDelivery: "guide",
              admittedDelivery: "guide",
              modelSelection,
              mode: "yolo",
              planEnabled: true,
            },
          },
        ],
      },
      { turnId },
    );

    expect(runAll(log.events).projection.getSnapshot().rows.window.at(-1)).toMatchObject({
      kind: "userInput",
      text: "drained with config",
      modelSelection,
      mode: "yolo",
      planEnabled: true,
    });
  });

  it("preserves topic originals and attachment ownership when replaying accepted turn events", () => {
    const source = {
      provider: "feishu",
      botId: "bot",
      chatId: "group",
      threadId: "topic",
      senderId: "b",
      senderName: "Bob",
      messageId: "second",
      messages: [
        {
          messageId: "first",
          senderId: "a",
          senderName: "Alice",
          text: "First",
          attachmentIndexes: [0],
          conversationQuotes: [{ text: "Root", senderName: "Root author" }],
        },
        {
          messageId: "second",
          senderId: "b",
          senderName: "Bob",
          text: "Second",
          attachmentIndexes: [1],
        },
      ],
    };
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    log.push(
      SessionEventType.TurnStarted,
      {
        turnNumber: 1,
        input: "combined",
        messageId: "accepted",
        inputId: "command",
        intent: {
          sourceCommandId: "command",
          kind: "sendText",
          text: "combined",
          admissionSeq: 1,
          admittedAt: 10,
          requestedDelivery: "startNow",
          admittedDelivery: "startNow",
          botGroupSource: source,
          attachmentRefs: [
            { ref: "artifact://first", fileName: "first.txt", mime: "text/plain", bytes: 1 },
            { ref: "artifact://second", fileName: "second.txt", mime: "text/plain", bytes: 1 },
          ],
        },
      },
      { turnId: "topic-turn" },
    );
    const restored = log.events.map((event) => ({
      ...event,
      payload: JSON.parse(JSON.stringify(event.payload)),
    }));
    const snapshot = conversationSnapshotSchema.parse(runAll(restored).projection.getSnapshot());
    expect(snapshot.rows.window.find((row) => row.kind === "userInput")).toMatchObject({
      botGroupSource: source,
      attachments: [{ ref: "artifact://first" }, { ref: "artifact://second" }],
    });
  });

  it("TEL06：edit/rerun user row 保留 canonical root sourceCommandId", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    log.push(
      SessionEventType.TurnStarted,
      {
        turnNumber: 1,
        input: "retry prompt",
        messageId: "user-retry",
        inputId: "command-edit",
        foregroundExecutionId: "foreground-edit",
        intent: {
          sourceCommandId: "command-edit",
          queueItemId: "queue-edit",
          clientId: "desktop",
          kind: "sendText",
          text: "retry prompt",
          admissionSeq: 2,
          admittedAt: 1_700_000_000_000,
          requestedDelivery: "startNow",
          admittedDelivery: "startNow",
          provenance: { sourceCommandId: "command-original" },
        },
      },
      { turnId: "turn-retry" },
    );

    const { projection } = runAll(log.events);
    expect(conversationSnapshotSchema.parse(projection.getSnapshot()).control.activeWorks).toEqual([
      expect.objectContaining({
        foregroundExecutionId: "foreground-edit",
        sourceCommandId: "command-edit",
      }),
    ]);
    expect(
      projection.getSnapshot().rows.window.find((row) => row.kind === "userInput"),
    ).toMatchObject({
      sourceCommandId: "command-edit",
      rootSourceCommandId: "command-original",
      productTurnId: "user-retry",
    });
  });

  it("PV4-08：只给 completedSuccess 轮尾 assistant 下发 canFork，后续 turn running 时仍稳定", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    log.push(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: "first", messageId: "user-1" },
      { turnId: "turn-1" },
    );
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_start", delta: "", done: false, assistantMessageId: "assistant-1" },
      { turnId: "turn-1" },
    );
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_end", delta: "", done: false },
      { turnId: "turn-1" },
    );
    log.push(
      SessionEventType.TurnComplete,
      { response: "done", tokenCount: 1, toolCallCount: 0, duration: 1, resultType: "success" },
      { turnId: "turn-1" },
    );
    log.push(
      SessionEventType.TurnStarted,
      { turnNumber: 2, input: "second", messageId: "user-2" },
      { turnId: "turn-2" },
    );

    const { projection } = runAll(log.events);
    const firstAssistant = projection
      .getSnapshot()
      .rows.window.find((row) => row.kind === "assistantText" && row.turnId === "user-1");
    expect(firstAssistant?.actions).toEqual({ canFork: true });
    expect(projection.resolveStableForkCandidate(firstAssistant!.rowId)).toEqual({
      ok: true,
      candidate: {
        boundaryMessageId: "assistant-1",
        productTurnId: "user-1",
        startMessageId: "user-1",
        transcriptTurnId: "turn-1",
      },
    });
    expect(projection.getSnapshot().control.phase).toBe("running");
  });

  it("PV4-08：成功轮固化 fork 能力时不复制并反转完整 rows 窗口", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    log.push(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: "first", messageId: "user-1" },
      { turnId: "turn-1" },
    );
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_start", delta: "", done: false, assistantMessageId: "assistant-1" },
      { turnId: "turn-1" },
    );
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_end", delta: "", done: false },
      { turnId: "turn-1" },
    );

    const { projection } = runAll(log.events);
    const reverse = vi.spyOn(Array.prototype, "reverse").mockImplementation(() => {
      throw new Error("TurnComplete must not reverse the full rows window");
    });
    try {
      projection.applyEvent(
        log.push(
          SessionEventType.TurnComplete,
          {
            response: "done",
            tokenCount: 1,
            toolCallCount: 0,
            duration: 1,
            resultType: "success",
          },
          { turnId: "turn-1" },
        ),
      );
    } finally {
      reverse.mockRestore();
    }

    const assistant = projection
      .getSnapshot()
      .rows.window.find((row) => row.kind === "assistantText");
    expect(assistant?.actions?.canFork).toBe(true);
  });

  it("PV4-08：中间 assistant 段和 interrupted turn 都不可 fork", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    log.push(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: "first", messageId: "user-1" },
      { turnId: "turn-1" },
    );
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_start", delta: "", done: false, assistantMessageId: "assistant-1a" },
      { turnId: "turn-1" },
    );
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_end", delta: "", done: false },
      { turnId: "turn-1" },
    );
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_start", delta: "", done: false, assistantMessageId: "assistant-1b" },
      { turnId: "turn-1" },
    );
    log.push(
      SessionEventType.TurnComplete,
      {
        response: "partial",
        tokenCount: 1,
        toolCallCount: 0,
        duration: 1,
        resultType: "cancelled",
      },
      { turnId: "turn-1" },
    );

    const { projection } = runAll(log.events);
    const assistants = projection
      .getSnapshot()
      .rows.window.filter((row) => row.kind === "assistantText");
    expect(assistants.every((row) => row.actions?.canFork !== true)).toBe(true);
    expect(projection.resolveStableForkCandidate(assistants[0]!.rowId)).toEqual({
      ok: false,
      reasonCode: "guard.forkTargetNotStable",
    });
    expect(projection.resolveStableForkCandidate(assistants[1]!.rowId)).toEqual({
      ok: false,
      reasonCode: "guard.forkTargetNotStable",
    });
  });

  it("OTC08：同一 turn 的 output-limit Continue 只投影一条累计 assistantText", () => {
    const log = new EventLog();
    const turnId = "turn-output-continue";
    const appendAssistantResponse = (
      assistantMessageId: string,
      partId: string,
      text: string,
      stopReason: "length" | "end_turn",
    ) => {
      log.push(
        SessionEventType.ModelStreaming,
        {
          kind: "text_start",
          delta: "",
          done: false,
          assistantMessageId,
          partId,
        },
        { turnId },
      );
      log.push(
        SessionEventType.ModelStreaming,
        { kind: "text_delta", delta: text, done: false, assistantMessageId, partId },
        { turnId },
      );
      log.push(
        SessionEventType.ModelStreaming,
        { kind: "text_end", delta: "", done: false, assistantMessageId, partId },
        { turnId },
      );
      log.push(
        SessionEventType.ModelComplete,
        {
          content: text,
          stopReason,
          querySource: "main_turn",
          toolCallCount: 0,
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        },
        { turnId },
      );
    };

    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    log.push(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: "写一段长回复", messageId: "user-output-continue" },
      { turnId },
    );
    appendAssistantResponse("assistant-p1", "part-p1", "即使底层已经", "length");
    appendAssistantResponse("assistant-p2", "part-p2", "发起新的请求并停在", "length");
    appendAssistantResponse("assistant-p3", "part-p3", "一个尚未完成的位置。", "end_turn");
    log.push(
      SessionEventType.TurnComplete,
      {
        response: "一个尚未完成的位置。",
        tokenCount: 3,
        toolCallCount: 0,
        duration: 3_000,
        resultType: "success",
      },
      { turnId },
    );

    const { projection, deltasPerEvent } = runAll(log.events);
    const assistantRows = projection
      .getSnapshot()
      .rows.window.filter((row) => row.kind === "assistantText");
    expect(assistantRows).toHaveLength(1);
    expect(assistantRows[0]).toMatchObject({
      text: "即使底层已经发起新的请求并停在一个尚未完成的位置。",
      state: "complete",
      assistantResponseId: "assistant-p3",
      entityId: "assistant-p3",
      actions: { canFork: true },
    });
    expect(
      deltasPerEvent
        .flat()
        .filter((delta) => delta.op === "row.appended" && delta.row.kind === "assistantText"),
    ).toHaveLength(1);
    expect(projection.getMessageIdForRow(assistantRows[0]!.rowId)).toBe("assistant-p3");
    const header = projection.getSnapshot().rows.window.find((row) => row.kind === "turnHeader");
    expect(projection.getMessageIdsForTurnRow(header!.rowId)).toEqual(
      expect.arrayContaining([
        "user-output-continue",
        "assistant-p1",
        "assistant-p2",
        "assistant-p3",
      ]),
    );
  });

  it("OTC08：异步 session-title ModelComplete 不清除主 turn 的 Continue 资格", () => {
    const log = new EventLog();
    const turnId = "turn-output-continue-with-title-sidecar";
    const appendAssistantResponse = (
      assistantMessageId: string,
      text: string,
      stopReason: "length" | "end_turn",
    ) => {
      log.push(
        SessionEventType.ModelStreaming,
        { kind: "text_start", delta: "", done: false, assistantMessageId },
        { turnId },
      );
      log.push(
        SessionEventType.ModelStreaming,
        { kind: "text_delta", delta: text, done: false, assistantMessageId },
        { turnId },
      );
      log.push(
        SessionEventType.ModelStreaming,
        { kind: "text_end", delta: "", done: false, assistantMessageId },
        { turnId },
      );
      log.push(
        SessionEventType.ModelComplete,
        {
          content: text,
          querySource: "main_turn",
          stopReason,
          toolCallCount: 0,
          usage: {},
        },
        { turnId },
      );
    };

    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    log.push(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: "写一段长回复", messageId: "user-output-title-sidecar" },
      { turnId },
    );
    appendAssistantResponse("assistant-title-p1", "主 turn 第一段", "length");
    log.push(
      SessionEventType.ModelComplete,
      {
        content: "标题",
        querySource: "session_title",
        stopReason: "end_turn",
        toolCallCount: 0,
        usage: {},
      },
      { turnId },
    );
    appendAssistantResponse("assistant-title-p2", "继续拼接完成。", "end_turn");

    const { projection } = runAll(log.events);
    const assistantRows = projection
      .getSnapshot()
      .rows.window.filter((row) => row.kind === "assistantText");
    expect(assistantRows).toHaveLength(1);
    expect(assistantRows[0]).toMatchObject({
      text: "主 turn 第一段继续拼接完成。",
      assistantResponseId: "assistant-title-p2",
      state: "complete",
    });
  });

  it.each([
    { label: "含工具边界", stopReason: "length", toolCallCount: 1 },
    { label: "缺少明确 zero-tool 事实", stopReason: "length", toolCallCount: undefined },
    { label: "不是 output-limit", stopReason: "end_turn", toolCallCount: 0 },
  ] as const)("OTC08：$label 时不复用 assistantText row", ({ stopReason, toolCallCount }) => {
    const log = new EventLog();
    const turnId = `turn-output-boundary-${stopReason}-${String(toolCallCount)}`;
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    log.push(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: "执行工具", messageId: "user-output-tool-boundary" },
      { turnId },
    );
    log.push(
      SessionEventType.ModelStreaming,
      {
        kind: "text_start",
        delta: "",
        done: false,
        assistantMessageId: "assistant-before-tool",
      },
      { turnId },
    );
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_delta", delta: "先执行工具。", done: false },
      { turnId },
    );
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_end", delta: "", done: false },
      { turnId },
    );
    log.push(
      SessionEventType.ModelComplete,
      {
        content: "先执行工具。",
        stopReason,
        querySource: "main_turn",
        ...(toolCallCount === undefined ? {} : { toolCallCount }),
        usage: {},
      },
      { turnId },
    );
    log.push(
      SessionEventType.ModelStreaming,
      {
        kind: "text_start",
        delta: "",
        done: false,
        assistantMessageId: "assistant-after-tool",
      },
      { turnId },
    );

    const { projection } = runAll(log.events);
    expect(
      projection.getSnapshot().rows.window.filter((row) => row.kind === "assistantText"),
    ).toHaveLength(2);
  });

  it("A：完整成功 turn —— rows 结构、phase、usage、schema 合法", () => {
    const log = new EventLog();
    basicTurnEvents(log);
    const { projection } = runAll(log.events);
    const snapshot = projection.getSnapshot();

    // schema 合法性（M1 数据模型被 reducer 锤炼的第一道闸）。
    expect(() => conversationSnapshotSchema.parse(snapshot)).not.toThrow();

    const kinds = snapshot.rows.window.map((row) => row.kind);
    expect(kinds).toEqual(["turnHeader", "userInput", "assistantText"]);

    const [header, userInput, assistant] = snapshot.rows.window;
    expect(header).toMatchObject({
      kind: "turnHeader",
      origin: "userInput",
      state: "completedSuccess",
      activeMs: 5000,
    });
    expect(userInput).toMatchObject({
      kind: "userInput",
      text: "写一个 hello world",
      origin: "realUser",
    });
    expect(assistant).toMatchObject({
      kind: "assistantText",
      text: "Hello world",
      state: "complete",
    });

    expect(snapshot.control.phase).toBe("completedSuccess");
    expect(snapshot.control.sessionEnded).toBe(true);
    expect(snapshot.control.canStop).toBe(false);
    expect(snapshot.inputRouting.mode).toBe("startNow");
    expect(snapshot.usage.contextWindow).toEqual({
      usedTokens: 150,
      maxTokens: 200_000,
      autoCompactThresholdTokens: null,
    });
    expect(snapshot.usage.cumulative.inputTokens).toBe(120);
    expect(snapshot.seq).toBe(log.events.length);
  });

  it("A：主轮次 usage 保留 cache 命中率和 context breakdown", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "hi" }, { turnId: "turn-1" });
    log.push(
      SessionEventType.ModelComplete,
      {
        content: "done",
        stopReason: "end_turn",
        querySource: "main_turn",
        contextWindow: 200_000,
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 80,
          cacheWriteTokens: 10,
        },
        cacheHit: {
          inputTokens: 100,
          cacheReadTokens: 80,
          cacheWriteTokens: 10,
          latestHitRate: 0.8,
          hitRate: 0.8,
          hitRateRequestCount: 1,
          totalInputTokens: 100,
          totalCacheReadTokens: 80,
          totalCacheWriteTokens: 10,
        },
        contextUsageBreakdown: [
          { source: "messages", chars: 900 },
          { source: "system_tool_schemas", chars: 100 },
        ],
      },
      { turnId: "turn-1" },
    );

    const { projection } = runAll(log.events);
    const contextWindow = projection.getSnapshot().usage.contextWindow;

    expect(contextWindow?.usedTokens).toBe(120);
    expect(contextWindow?.maxTokens).toBe(200_000);
    expect(contextWindow?.cache).toMatchObject({ hitRate: 0.8, totalCacheReadTokens: 80 });
    expect(contextWindow?.breakdown).toEqual([
      { source: "messages", chars: 900 },
      { source: "system_tool_schemas", chars: 100 },
    ]);
  });

  it("A：sidecar usage 不覆盖输入栏 context cache 和 breakdown", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "hi" }, { turnId: "turn-1" });
    log.push(
      SessionEventType.ModelComplete,
      {
        content: "title",
        stopReason: "end_turn",
        querySource: "session_title",
        contextWindow: 200_000,
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 80,
          cacheWriteTokens: 10,
        },
        cacheHit: {
          inputTokens: 100,
          cacheReadTokens: 80,
          cacheWriteTokens: 10,
          latestHitRate: 0.8,
          hitRate: 0.8,
          hitRateRequestCount: 1,
          totalInputTokens: 100,
          totalCacheReadTokens: 80,
          totalCacheWriteTokens: 10,
        },
        contextUsageBreakdown: [{ source: "messages", chars: 900 }],
      },
      { turnId: "turn-1" },
    );

    const { projection } = runAll(log.events);

    expect(projection.getSnapshot().usage.contextWindow).toBeNull();
  });

  it("A：running 期 inputRouting=enqueue，完成后 startNow", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "hi" }, { turnId: "turn-1" });
    const { projection } = runAll(log.events);
    expect(projection.getSnapshot().inputRouting.mode).toBe("enqueue");
    // 回归原因：busy 期间 compact 已改为进入 typed FIFO，旧黄金断言仍按直接执行
    // 门禁判为不可用；这里同时补齐标题承诺的完成态路由收口。
    expect(projection.getSnapshot().availability.compact.allowed).toBe(true);

    projection.applyEvent(
      log.push(
        SessionEventType.TurnComplete,
        {
          response: "done",
          tokenCount: 1,
          toolCallCount: 0,
          duration: 100,
          resultType: "success",
        },
        { turnId: "turn-1" },
      ),
    );
    expect(projection.getSnapshot().inputRouting.mode).toBe("startNow");
  });

  it("A：model-only 输入（goal continuation 等）不产生 userInput row", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(
      SessionEventType.TurnStarted,
      {
        turnNumber: 1,
        input: "continue the goal",
        inputSource: "goal-continuation",
        inputVisibility: "model-only",
      },
      { turnId: "turn-1" },
    );
    const { projection } = runAll(log.events);
    const kinds = projection.getSnapshot().rows.window.map((row) => row.kind);
    expect(kinds).toEqual(["turnHeader"]);
    expect(projection.getSnapshot().rows.window[0]).toMatchObject({
      origin: "goalContinuation",
    });
  });

  it("BG27/BG28：background model-only turn 把结构化标题投影到 turnHeader", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(
      SessionEventType.TurnStarted,
      {
        turnNumber: 1,
        input: "background result",
        inputSource: "background_task",
        inputVisibility: "model-only",
        originMeta: {
          backgroundSource: "subagent",
          title: "Review the projection chain",
          workId: "agent-review",
        },
      } as never,
      { turnId: "turn-background" },
    );

    const rows = runAll(log.events).projection.getSnapshot().rows.window;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "turnHeader",
      origin: "backgroundResult",
      originMeta: {
        backgroundSource: "subagent",
        title: "Review the projection chain",
        workId: "agent-review",
      },
    });
  });

  it("workflow 终态通知：manifest 载荷随 originMeta 投影到 turnHeader（BG27 姊妹）", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    const workflowNotification = {
      kind: "terminal" as const,
      status: "completed" as const,
      summary: "nightly audit",
      result: "final artifact",
      resultForm: "prose" as const,
      reports: { count: 2, shown: 1, preview: ["第一步"] },
      durationMs: 5_000,
    };
    log.push(
      SessionEventType.TurnStarted,
      {
        turnNumber: 1,
        input: "workflow result",
        inputSource: "background_task",
        inputVisibility: "model-only",
        originMeta: {
          backgroundSource: "workflow",
          title: "nightly audit",
          workId: "dwfrun-proj",
          workflowNotification,
        },
      } as never,
      { turnId: "turn-workflow" },
    );

    const rows = runAll(log.events).projection.getSnapshot().rows.window;
    expect(rows).toHaveLength(1);
    // originMeta 被投影层整体拷贝——manifest 载荷免费搭车，不被逐字段重构剥掉。
    expect(rows[0]).toMatchObject({
      kind: "turnHeader",
      origin: "backgroundResult",
      originMeta: {
        backgroundSource: "workflow",
        title: "nightly audit",
        workId: "dwfrun-proj",
        workflowNotification,
      },
    });
  });

  it("BG26：background Agent 失败通知按 tool-use-id 覆盖 launch ACK 终态", () => {
    const turnId = "turn-agent-launch";
    const toolCallId = "tool-agent-rate-limit";
    const error = "Requests are too frequent. Request id: bg26";
    const result = `Agent general-purpose task \"分析世界杯\" failed. ${error}`;
    const notification = [
      "<task-notification>",
      `<tool-use-id>${toolCallId}</tool-use-id>`,
      "<status>failed</status>",
      `<result>${result}</result>`,
      `<error>${error}</error>`,
      "</task-notification>",
    ].join("\n");
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: "launch agent", messageId: "user-agent-launch" },
      { turnId },
    );
    log.push(
      SessionEventType.ToolCallScheduled,
      {
        toolCallId,
        toolName: "Agent",
        input: {
          description: "分析世界杯",
          run_in_background: true,
          subagent_type: "general-purpose",
        },
        schedule: { parallelGroups: [[toolCallId]], executionOrder: [toolCallId] },
      },
      { turnId },
    );
    log.push(
      SessionEventType.ToolCallStarted,
      { toolCallId, toolName: "Agent", startedAt: new Date(1_700_000_003_000) },
      { turnId },
    );
    log.push(
      SessionEventType.ToolCallResult,
      {
        toolCallId,
        result: { success: true, content: "Async agent launched successfully." },
        duration: 1,
      },
      { turnId },
    );
    log.push(
      SessionEventType.TurnComplete,
      { response: "", tokenCount: 0, toolCallCount: 1, duration: 1, resultType: "success" },
      { turnId },
    );
    log.push(
      SessionEventType.TurnStarted,
      {
        turnNumber: 2,
        input: notification,
        inputSource: "background_task",
        inputVisibility: "model-only",
        messageId: "user-agent-notification",
      },
      { turnId: "turn-agent-notification" },
    );

    const rows = runAll(log.events).projection.getSnapshot().rows.window;
    expect(rows.filter((row) => row.kind === "userInput")).toHaveLength(1);
    expect(
      rows.find((row) => row.kind === "toolCall" && row.toolCallId === toolCallId),
    ).toMatchObject({
      error: {
        code: "fault.runtime.backgroundTaskFailed",
        message: error,
      },
      output: { text: result },
      status: "error",
    });
  });

  it("BG26：不带 <error> 的失败通知按 originMeta.subagentResult 取失败原因，不解析 summary", () => {
    const turnId = "turn-agent-launch";
    const toolCallId = "tool-agent-rate-limit";
    const error = "Requests are too frequent. Request id: bg26";
    // 失败通知不带 <error>；失败原文由 originMeta.subagentResult 结构化下发，
    // hover 只显示 provider 原文。
    const summary = `Agent "分析世界杯" failed: ${error}`;
    const notification = [
      "<task-notification>",
      `<tool-use-id>${toolCallId}</tool-use-id>`,
      "<status>failed</status>",
      `<summary>${summary}</summary>`,
      "</task-notification>",
    ].join("\n");
    const toolRowFor = (originMeta?: Record<string, unknown>) => {
      const log = new EventLog();
      log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
      log.push(
        SessionEventType.TurnStarted,
        { turnNumber: 1, input: "launch agent", messageId: "user-agent-launch" },
        { turnId },
      );
      log.push(
        SessionEventType.ToolCallScheduled,
        {
          toolCallId,
          toolName: "Agent",
          input: {
            description: "分析世界杯",
            run_in_background: true,
            subagent_type: "general-purpose",
          },
          schedule: { parallelGroups: [[toolCallId]], executionOrder: [toolCallId] },
        },
        { turnId },
      );
      log.push(
        SessionEventType.ToolCallStarted,
        { toolCallId, toolName: "Agent", startedAt: new Date(1_700_000_003_000) },
        { turnId },
      );
      log.push(
        SessionEventType.ToolCallResult,
        {
          toolCallId,
          result: { success: true, content: "Async agent launched successfully." },
          duration: 1,
        },
        { turnId },
      );
      log.push(
        SessionEventType.TurnComplete,
        { response: "", tokenCount: 0, toolCallCount: 1, duration: 1, resultType: "success" },
        { turnId },
      );
      log.push(
        SessionEventType.TurnStarted,
        {
          turnNumber: 2,
          input: notification,
          inputSource: "background_task",
          inputVisibility: "model-only",
          messageId: "user-agent-notification",
          ...(originMeta ? { originMeta } : {}),
        },
        { turnId: "turn-agent-notification" },
      );

      const rows = runAll(log.events).projection.getSnapshot().rows.window;
      expect(rows.filter((row) => row.kind === "userInput")).toHaveLength(1);
      return rows.find((row) => row.kind === "toolCall" && row.toolCallId === toolCallId);
    };

    expect(
      toolRowFor({
        backgroundSource: "subagent",
        workId: "agent-bg26",
        title: "分析世界杯",
        subagentResult: { status: "failed", error },
      }),
    ).toMatchObject({
      error: { code: "fault.runtime.backgroundTaskFailed", message: error },
      output: { text: summary },
      status: "error",
    });
    // 产品数据不依赖模型可见文案：没有结构化结果（合并轮）时不从 summary 猜原因，
    // 失败详情退回整句 summary。
    expect(toolRowFor()).toMatchObject({
      error: { code: "fault.runtime.backgroundTaskFailed", message: summary },
      status: "error",
    });
  });

  it("BG26：合并通知按块投影，失败任务不读下一条通知的结果", () => {
    const turnId = "turn-agent-launch";
    const failedSummary = 'Agent "A" failed: Permission denied';
    const partialFailedSummary = 'Agent "C" failed: Requests are too frequent.';
    const notification = (toolCallId: string, lines: string[]) =>
      [
        "<task-notification>",
        `<tool-use-id>${toolCallId}</tool-use-id>`,
        ...lines,
        "</task-notification>",
      ].join("\n");
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: "launch agents", messageId: "user-agent-launch" },
      { turnId },
    );
    for (const toolCallId of ["tool-agent-a", "tool-agent-b", "tool-agent-c"]) {
      log.push(
        SessionEventType.ToolCallScheduled,
        {
          toolCallId,
          toolName: "Agent",
          input: {
            description: toolCallId,
            run_in_background: true,
            subagent_type: "general-purpose",
          },
          schedule: { parallelGroups: [[toolCallId]], executionOrder: [toolCallId] },
        },
        { turnId },
      );
      log.push(
        SessionEventType.ToolCallResult,
        {
          toolCallId,
          result: { success: true, content: "Async agent launched successfully." },
          duration: 1,
        },
        { turnId },
      );
    }
    log.push(
      SessionEventType.TurnComplete,
      { response: "", tokenCount: 0, toolCallCount: 3, duration: 1, resultType: "success" },
      { turnId },
    );
    // 合并轮的 originMeta 只有基字段，没有逐任务的结构化结果。
    log.push(
      SessionEventType.TurnStarted,
      {
        turnNumber: 2,
        input: [
          notification("tool-agent-a", [
            "<status>failed</status>",
            `<summary>${failedSummary}</summary>`,
          ]),
          notification("tool-agent-b", [
            "<status>completed</status>",
            '<summary>Agent "B" finished</summary>',
            "<result>Tests passed</result>",
          ]),
          // local agent 失败通知带 <note>，<result> 是只给模型的部分报告。
          notification("tool-agent-c", [
            "<status>failed</status>",
            `<summary>${partialFailedSummary}</summary>`,
            "<note>A task-notification fires each time this agent stops.</note>",
            "<result>Interim findings: module A.</result>",
          ]),
        ].join("\n\n"),
        inputSource: "background_task",
        inputVisibility: "model-only",
        messageId: "user-agent-notification",
        originMeta: { backgroundSource: "subagent", workId: "agent-a", title: "A · B" },
      },
      { turnId: "turn-agent-notification" },
    );

    const rows = runAll(log.events).projection.getSnapshot().rows.window;
    const toolRow = (toolCallId: string) =>
      rows.find((row) => row.kind === "toolCall" && row.toolCallId === toolCallId);
    expect(toolRow("tool-agent-a")).toMatchObject({
      error: { code: "fault.runtime.backgroundTaskFailed", message: failedSummary },
      output: { text: failedSummary },
      status: "error",
    });
    expect(toolRow("tool-agent-b")).toMatchObject({
      output: { text: "Tests passed" },
      status: "success",
    });
    // 回归：失败原因不能退到部分报告，卡片 output 与 hover 仍是这条通知自己的 summary。
    expect(toolRow("tool-agent-c")).toMatchObject({
      error: { code: "fault.runtime.backgroundTaskFailed", message: partialFailedSummary },
      output: { text: partialFailedSummary },
      status: "error",
    });
  });

  // ── B 组：stop / 迟到终态 ──

  it("B：cancelled turn —— streaming 行收口为 interrupted，phase=completedInterrupted", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "hi" }, { turnId: "turn-1" });
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_start", delta: "", done: false },
      { turnId: "turn-1" },
    );
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_delta", delta: "partial", done: false },
      { turnId: "turn-1" },
    );
    log.push(
      SessionEventType.TurnComplete,
      { response: "", tokenCount: 0, toolCallCount: 0, duration: 1000, resultType: "cancelled" },
      { turnId: "turn-1" },
    );
    const { projection } = runAll(log.events);
    const snapshot = projection.getSnapshot();
    expect(snapshot.control.phase).toBe("completedInterrupted");
    const assistant = snapshot.rows.window.find((row) => row.kind === "assistantText");
    expect(assistant).toMatchObject({ text: "partial", state: "interrupted" });
    const header = snapshot.rows.window.find((row) => row.kind === "turnHeader");
    expect(header).toMatchObject({ state: "completedInterrupted" });
  });

  it("B/结构性2：stop 后迟到的流式/工具终态被拒收，投影逐字节不变", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "hi" }, { turnId: "turn-1" });
    log.push(
      SessionEventType.TurnComplete,
      { response: "", tokenCount: 0, toolCallCount: 0, duration: 100, resultType: "cancelled" },
      { turnId: "turn-1" },
    );
    const { projection } = runAll(log.events);
    const before = structuredClone(projection.getSnapshot());

    const late = new EventLog();
    late.push(
      SessionEventType.ModelStreaming,
      { kind: "text_delta", delta: "ghost", done: false },
      { turnId: "turn-1" },
    );
    late.push(
      SessionEventType.ToolCallResult,
      { toolCallId: "tc-1", result: { success: true, content: "ghost" }, duration: 1 },
      { turnId: "turn-1" },
    );
    for (const event of late.events) {
      expect(projection.applyEvent(event)).toEqual([]);
    }
    expect({ ...projection.getSnapshot(), seq: before.seq }).toEqual(before);
  });

  // ── O/Q 组：tool call 状态机与权限交互 ──

  it("CUA：PID 工具按事件顺序固化最近一次成功 list_apps 快照", () => {
    const turnId = "turn-cua-app-snapshot";
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "操作应用" }, { turnId });
    const listApps = (id: string, name: string, success = true) => {
      log.push(
        SessionEventType.ToolCallScheduled,
        {
          toolCallId: id,
          toolName: "mcp__computer-use__list_apps",
          input: {},
          schedule: { parallelGroups: [[id]], executionOrder: [id] },
        },
        { turnId },
      );
      log.push(
        SessionEventType.ToolCallResult,
        {
          toolCallId: id,
          result: {
            success,
            content: success
              ? JSON.stringify([{ pid: 42, name, bundle_id: `com.example.${name}` }])
              : "failed",
            ...(!success ? { error: { type: "toolFailed", message: "failed" } } : {}),
          },
          duration: 1,
        },
        { turnId },
      );
    };
    const scheduleKey = (
      id: string,
      toolName = "mcp__computer-use__key",
      appRef: unknown = { pid: 42 },
    ) =>
      log.push(
        SessionEventType.ToolCallScheduled,
        {
          toolCallId: id,
          toolName,
          input: { app_ref: appRef, key: "TAB" },
          schedule: { parallelGroups: [[id]], executionOrder: [id] },
        },
        { turnId },
      );

    listApps("list-1", "One");
    scheduleKey("key-1");
    listApps("list-failed", "Ignored", false);
    scheduleKey("key-after-failure");
    listApps("list-2", "Two");
    scheduleKey("key-2");
    scheduleKey("bundle-only", "mcp__computer-use__get_app_state", {
      bundle_id: "com.example.Two",
    });
    scheduleKey("serialized-pid", "mcp__computer-use__get_app_state", '{"pid":42}');
    scheduleKey("lookalike", "mcp__other__computer-use__key");

    const rows = runAll(log.events).projection.getSnapshot().rows.window;
    const appOf = (id: string) => {
      const row = rows.find(
        (candidate) => candidate.kind === "toolCall" && candidate.toolCallId === id,
      );
      return row?.kind === "toolCall" ? row.cuaApp : undefined;
    };
    expect(appOf("key-1")).toEqual({ pid: 42, name: "One", bundleId: "com.example.One" });
    expect(appOf("key-after-failure")).toEqual({
      pid: 42,
      name: "One",
      bundleId: "com.example.One",
    });
    expect(appOf("key-2")).toEqual({ pid: 42, name: "Two", bundleId: "com.example.Two" });
    expect(appOf("bundle-only")).toEqual({
      pid: 42,
      name: "Two",
      bundleId: "com.example.Two",
    });
    expect(appOf("serialized-pid")).toEqual({
      pid: 42,
      name: "Two",
      bundleId: "com.example.Two",
    });
    expect(appOf("lookalike")).toBeUndefined();
  });

  it("CUA：原子实时投影提交后保留 list_apps 快照", () => {
    const turnId = "turn-cua-atomic-snapshot";
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "操作飞书" }, { turnId });
    log.push(
      SessionEventType.ToolCallScheduled,
      {
        toolCallId: "list-apps",
        toolName: "mcp__computer-use__list_apps",
        input: {},
        schedule: { parallelGroups: [["list-apps"]], executionOrder: ["list-apps"] },
      },
      { turnId },
    );
    log.push(
      SessionEventType.ToolCallResult,
      {
        toolCallId: "list-apps",
        result: {
          success: true,
          content: JSON.stringify([{ pid: 691, name: "Feishu", bundle_id: "com.electron.lark" }]),
        },
        duration: 1,
      },
      { turnId },
    );
    log.push(
      SessionEventType.ToolCallScheduled,
      {
        toolCallId: "get-app-state",
        toolName: "mcp__computer-use__get_app_state",
        input: { app_ref: '{"pid":691}', title: "查看飞书当前界面" },
        schedule: {
          parallelGroups: [["get-app-state"]],
          executionOrder: ["get-app-state"],
        },
      },
      { turnId },
    );

    const projection = new ProductProjection("session-1", "epoch-1");
    for (const event of log.events) {
      expect(projection.applyEventAtomically(event, () => true)).not.toBeNull();
    }

    const row = projection
      .getSnapshot()
      .rows.window.find(
        (candidate) => candidate.kind === "toolCall" && candidate.toolCallId === "get-app-state",
      );
    expect(row?.kind === "toolCall" ? row.cuaApp : undefined).toEqual({
      pid: 691,
      name: "Feishu",
      bundleId: "com.electron.lark",
    });
  });

  it("BTA01：保留 turn-end Node REPL 图片 display 到 live tool row", () => {
    const turnId = "turn-browser-shot";
    const toolCallId = "tool-browser-shot";
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "打开页面" }, { turnId });
    log.push(
      SessionEventType.ToolCallScheduled,
      {
        toolCallId,
        toolName: "mcp__node_repl__js",
        input: { source: "browser_turn_end" },
        schedule: { parallelGroups: [[toolCallId]], executionOrder: [toolCallId] },
      },
      { turnId },
    );
    log.push(
      SessionEventType.ToolCallResult,
      {
        toolCallId,
        result: {
          success: true,
          content: "",
          display: {
            kind: "node_repl_images",
            source: "browser_turn_end",
            images: [{ base64: "AAAA", mimeType: "image/png" }],
          },
        },
        duration: 0,
      },
      { turnId },
    );

    const snapshot = runAll(log.events).projection.getSnapshot();
    expect(() => conversationSnapshotSchema.parse(snapshot)).not.toThrow();
    expect(
      snapshot.rows.window.find((row) => row.kind === "toolCall" && row.toolCallId === toolCallId),
    ).toMatchObject({
      status: "success",
      display: { kind: "node_repl_images", source: "browser_turn_end" },
    });
  });

  it("CUA：保留实时工具结果的截图 display 到 output", () => {
    const turnId = "turn-cua-screenshot";
    const toolCallId = "tool-cua-screenshot";
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "截图" }, { turnId });
    log.push(
      SessionEventType.ToolCallScheduled,
      {
        toolCallId,
        toolName: "mcp__computer-use__computer-use",
        input: { action: "screenshot" },
        schedule: { parallelGroups: [[toolCallId]], executionOrder: [toolCallId] },
      },
      { turnId },
    );
    log.push(
      SessionEventType.ToolCallResult,
      {
        toolCallId,
        result: {
          success: true,
          content: "[Attached image/jpeg: MCP image]",
          display: {
            kind: "cua",
            schemaVersion: 1,
            toolName: "computer-use",
            status: "success",
            input: '{"action":"screenshot"}',
            media: [{ mimeType: "image/jpeg", data: "AAAA" }],
          },
        },
        duration: 10,
      },
      { turnId },
    );

    expect(
      runAll(log.events)
        .projection.getSnapshot()
        .rows.window.find((row) => row.kind === "toolCall" && row.toolCallId === toolCallId),
    ).toMatchObject({
      status: "success",
      output: {
        text: "[Attached image/jpeg: MCP image]",
        display: {
          kind: "cua",
          media: [{ mimeType: "image/jpeg", data: "AAAA" }],
        },
      },
    });
  });

  it.each([
    {
      toolName: "TaskOutput",
      display: {
        kind: "task_output",
        retrievalStatus: "not_ready",
        taskStatus: "running",
        output: "partial output",
      } as const,
    },
    {
      toolName: "RespondToCoordinator",
      display: {
        kind: "respond_to_coordinator",
        status: "success",
      } as const,
    },
    {
      toolName: "CreateWorkflow",
      display: {
        kind: "create_workflow",
        ok: true,
        errorCount: 0,
        diagnostics: [],
        causalityGraph: {
          steps: [
            {
              id: "ask#1",
              kind: "ask",
              label: "scout",
              line: 3,
              column: 20,
              lane: "actor#1",
            },
          ],
          lanes: [{ id: "actor#1", name: "scout", line: 3, column: 11 }],
          // 第二层是子代理导向：每阶段一张参与者卡 + 交接边（docs/dynamic-workflow/presentation.md）。
          participants: [
            { id: "unphased:actor#1", phase: "unphased", lane: "actor#1", steps: ["ask#1"] },
          ],
          handoffs: [],
          sink: ["ask#1"],
        },
      } as const,
    },
    // 观察类工作流工具的五个 display kind（spec：docs/dynamic-workflow/launch.md「Run introspection tools」
    // 「工具卡 display」、同文件「The model catalog」）——whitelist 不放行就整块被剥，UI 只能退回文本投影。
    {
      toolName: "GetWorkflowRun",
      display: {
        kind: "get_workflow_run",
        runId: "wf_demo",
        label: "demo",
        status: "running",
        usage: {
          spentTokens: 1_000,
          nodesObserved: 3,
          nodesRunning: 1,
          nodesCompleted: 2,
          nodesFailed: 0,
        },
        actors: [{ siteId: "agent#1", ordinal: 1, name: "scout" }],
        logTail: [{ sequence: 1, message: "started" }],
      } as const,
    },
    {
      toolName: "ListWorkflowRuns",
      display: {
        kind: "list_workflow_runs",
        runs: [
          {
            runId: "wf_demo",
            label: "demo",
            labelSource: "name",
            status: "completed",
            ownedByThisSession: true,
            createdAt: 1,
            updatedAt: 2,
            spentTokens: 42,
          },
        ],
      } as const,
    },
    {
      toolName: "EvalWorkflowSnippet",
      display: {
        kind: "eval_workflow_snippet",
        ok: true,
        diagnostics: [],
        logs: ["glob matched 3 files"],
        response: "3",
        durationMs: 120,
      } as const,
    },
    {
      toolName: "ResumeWorkflowRun",
      display: {
        kind: "resume_workflow_run",
        runId: "wf_demo",
      } as const,
    },
    // 模型目录卡（spec：docs/dynamic-workflow/launch.md「The model catalog」）：白名单漏了它，
    // UI 只能退回那段以 providerId 开头的 `<models>` 文本。
    {
      toolName: "ListModels",
      display: {
        kind: "list_models",
        current: "account:bigmodel-team-coding-plan/GLM-5.3-Flash",
        models: [
          {
            id: "account:bigmodel-team-coding-plan/GLM-5.3-Flash",
            providerId: "account:bigmodel-team-coding-plan",
            modelId: "GLM-5.3-Flash",
            providerLabel: "BigModel",
            reasoningLevels: ["low", "medium", "high"],
            defaultReasoningLevel: "high",
            contextWindow: 128_000,
          },
        ],
      } as const,
    },
    {
      toolName: "ListSavedWorkflows",
      display: {
        kind: "saved_workflow_list",
        workflows: [
          {
            name: "nightly-sync",
            scope: "project",
            path: ".zcode/workflows/nightly-sync.dwf.ts",
            argNames: ["question"],
          },
        ],
      } as const,
    },
  ])("保留 $toolName display 到 live tool row", ({ toolName, display }) => {
    const turnId = `turn-${toolName}`;
    const toolCallId = `tool-${toolName}`;
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "run tool" }, { turnId });
    log.push(
      SessionEventType.ToolCallScheduled,
      {
        toolCallId,
        toolName,
        input: {},
        schedule: { parallelGroups: [[toolCallId]], executionOrder: [toolCallId] },
      },
      { turnId },
    );
    log.push(
      SessionEventType.ToolCallResult,
      {
        toolCallId,
        result: {
          success: true,
          content: "provider content remains independent",
          display,
        },
        duration: 0,
      },
      { turnId },
    );

    expect(
      runAll(log.events)
        .projection.getSnapshot()
        .rows.window.find((row) => row.kind === "toolCall" && row.toolCallId === toolCallId),
    ).toMatchObject({
      status: "success",
      display,
      output: { text: "provider content remains independent" },
    });
  });

  it("不把未声明支持的 display kind 顺带开放到 V4 row", () => {
    const turnId = "turn-file-diff-display";
    const toolCallId = "tool-file-diff-display";
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "edit file" }, { turnId });
    log.push(
      SessionEventType.ToolCallScheduled,
      {
        toolCallId,
        toolName: "Edit",
        input: {},
        schedule: { parallelGroups: [[toolCallId]], executionOrder: [toolCallId] },
      },
      { turnId },
    );
    log.push(
      SessionEventType.ToolCallResult,
      {
        toolCallId,
        result: {
          success: true,
          content: "updated",
          display: {
            kind: "file_diff",
            filePath: "/workspace/app.ts",
            additions: 1,
            deletions: 0,
            structuredPatch: [],
            truncated: false,
          },
        },
        duration: 0,
      },
      { turnId },
    );

    const row = runAll(log.events)
      .projection.getSnapshot()
      .rows.window.find((candidate) => candidate.kind === "toolCall");
    expect(row).not.toHaveProperty("display");
  });

  it("不把 mirrored RespondToCoordinator 物化到父会话", () => {
    const turnId = "turn-mirrored-response";
    const toolCallId = "tool_subagent_agent-1_response";
    const mirrored = {
      agentId: "agent-1",
      agentType: "general-purpose",
      childSessionId: "session-child-1",
      childToolCallId: "response",
      parentToolCallId: "parent-agent-call",
      source: "subagent",
    };
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "run child" }, { turnId });
    log.push(
      SessionEventType.ToolCallScheduled,
      {
        ...mirrored,
        toolCallId,
        toolName: "RespondToCoordinator",
        input: { summary: "reply", message: "details" },
        schedule: { parallelGroups: [[toolCallId]], executionOrder: [toolCallId] },
      },
      { turnId },
    );
    log.push(
      SessionEventType.ToolCallResult,
      {
        ...mirrored,
        toolCallId,
        result: {
          success: true,
          content: "Response response-1 was queued for the coordinator.",
          display: { kind: "respond_to_coordinator", status: "success" },
        },
        duration: 0,
      },
      { turnId },
    );

    expect(
      runAll(log.events)
        .projection.getSnapshot()
        .rows.window.filter((row) => row.kind === "toolCall"),
    ).toEqual([]);
  });

  it("MCP discovery 展示元数据进入 live tool row，不依赖合成工具名解析", () => {
    const turnId = "turn-mcp-presentation";
    const toolCallId = "tool-mcp-presentation";
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "查询 issue" }, { turnId });
    log.push(
      SessionEventType.ToolCallScheduled,
      {
        toolCallId,
        toolName: "custom-provider-visible-name",
        input: { query: "is:open" },
        display: {
          kind: "mcp_tool",
          serverName: "company-github-prod",
          toolName: "issue_query_v2",
          description: "Query issues visible to the current user.",
        },
        schedule: { parallelGroups: [[toolCallId]], executionOrder: [toolCallId] },
      },
      { turnId },
    );

    const pendingRow = runAll(log.events.slice(0, 3))
      .projection.getSnapshot()
      .rows.window.find((row) => row.kind === "toolCall" && row.toolCallId === toolCallId);
    expect(pendingRow).toMatchObject({
      status: "inputStreaming",
      display: { kind: "mcp_tool", toolName: "issue_query_v2" },
    });
    log.push(
      SessionEventType.ToolCallResult,
      {
        toolCallId,
        result: {
          success: true,
          content: "12 issues",
          display: {
            kind: "mcp_tool",
            serverName: "company-github-prod",
            toolName: "issue_query_v2",
            description: "Query issues visible to the current user.",
          },
        },
        duration: 12,
      },
      { turnId },
    );

    expect(
      runAll(log.events)
        .projection.getSnapshot()
        .rows.window.find((row) => row.kind === "toolCall" && row.toolCallId === toolCallId),
    ).toMatchObject({
      toolName: "custom-provider-visible-name",
      status: "success",
      display: {
        kind: "mcp_tool",
        serverName: "company-github-prod",
        toolName: "issue_query_v2",
      },
    });
  });

  it("MCP display 在 running、failed 与 stopped 生命周期更新中保持不变", () => {
    const display = {
      kind: "mcp_tool" as const,
      serverName: "firebase",
      toolName: "get_environment",
    };
    const createLog = () => {
      const log = new EventLog();
      log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
      log.push(
        SessionEventType.TurnStarted,
        { turnNumber: 1, input: "inspect" },
        { turnId: "turn-mcp-lifecycle" },
      );
      log.push(
        SessionEventType.ToolCallScheduled,
        {
          toolCallId: "mcp-lifecycle",
          toolName: "opaque-name",
          input: {},
          display,
          schedule: { parallelGroups: [["mcp-lifecycle"]], executionOrder: ["mcp-lifecycle"] },
        },
        { turnId: "turn-mcp-lifecycle" },
      );
      log.push(
        SessionEventType.ToolCallStarted,
        { toolCallId: "mcp-lifecycle", toolName: "opaque-name", startedAt: new Date() },
        { turnId: "turn-mcp-lifecycle" },
      );
      return log;
    };

    const failedLog = createLog();
    failedLog.push(
      SessionEventType.ToolCallError,
      { toolCallId: "mcp-lifecycle", error: { type: "tool_failed", message: "boom" } },
      { turnId: "turn-mcp-lifecycle" },
    );
    const failedRow = runAll(failedLog.events).projection.getSnapshot().rows.window.at(-1);
    expect(failedRow).toMatchObject({ status: "error", display });

    const stoppedLog = createLog();
    stoppedLog.push(
      SessionEventType.TurnComplete,
      { response: "", tokenCount: 0, toolCallCount: 1, duration: 1, resultType: "cancelled" },
      { turnId: "turn-mcp-lifecycle" },
    );
    const stoppedRow = runAll(stoppedLog.events).projection.getSnapshot().rows.window.at(-1);
    expect(stoppedRow).toMatchObject({ status: "cancelled", display });
  });

  it("工具主动取消错误直接投影为 cancelled，不等待 turn complete 纠正", () => {
    const turnId = "turn-tool-cancelled";
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "run long bash" }, { turnId });
    log.push(
      SessionEventType.ToolCallScheduled,
      {
        toolCallId: "bash-cancelled",
        toolName: "Bash",
        input: { command: "sleep 60" },
        schedule: { parallelGroups: [["bash-cancelled"]], executionOrder: ["bash-cancelled"] },
      },
      { turnId },
    );
    log.push(
      SessionEventType.ToolCallStarted,
      { toolCallId: "bash-cancelled", toolName: "Bash", startedAt: new Date() },
      { turnId },
    );
    log.push(
      SessionEventType.ToolCallError,
      {
        toolCallId: "bash-cancelled",
        error: {
          code: "TOOL_CANCELLED",
          type: "tool_cancelled",
          message: "Bash was cancelled and the child process was asked to stop",
        },
      },
      { turnId },
    );

    const row = runAll(log.events).projection.getSnapshot().rows.window.at(-1);
    expect(row).toMatchObject({ kind: "toolCall", status: "cancelled" });
  });

  it("O/Q：tool 输入流式 → 权限等待 → 放行执行 → 成功终态", () => {
    const turnId = "turn-1";
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "run ls" }, { turnId });
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "tool_input_start", delta: "", done: false, toolCallId: "tc-1", toolName: "bash" },
      { turnId },
    );
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "tool_input_delta", delta: '{"command":"ls"}', done: false, toolCallId: "tc-1" },
      { turnId },
    );
    log.push(
      SessionEventType.ToolCallScheduled,
      {
        toolCallId: "tc-1",
        toolName: "bash",
        input: { command: "ls" },
        schedule: { parallelGroups: [["tc-1"]], executionOrder: ["tc-1"] },
      },
      { turnId },
    );
    log.push(
      SessionEventType.PermissionRequested,
      {
        requestId: "req-1",
        toolCallId: "tc-1",
        toolName: "bash",
        riskLevel: "medium",
        reason: "Run shell command",
        input: { command: "ls" },
        suggestedPermissionUpdates: [
          {
            behavior: "allow",
            rules: [{ ruleContent: "pnpm run lint:*", toolName: "Bash" }],
            type: "addRules",
          },
        ],
      },
      { turnId },
    );

    const { projection } = runAll(log.events);
    const pending = projection.getSnapshot();
    const toolRow = pending.rows.window.find((row) => row.kind === "toolCall");
    expect(toolRow).toMatchObject({
      status: "pendingApproval",
      inputText: '{"command":"ls"}',
      approvalInteractionId: "req-1",
    });
    expect(pending.pendingInteractions).toHaveLength(1);
    expect(pending.pendingInteractions[0]).toMatchObject({
      kind: "permission",
      anchorRowId: toolRow?.rowId,
    });
    expect(pending.pendingInteractions[0]?.payload).toMatchObject({
      freeText: true,
      options: [
        { optionId: "allowOnce", response: { decision: "allow" } },
        {
          optionId: "allowAlways",
          response: {
            decision: "allow",
            permissionUpdates: [
              {
                behavior: "allow",
                rules: [{ ruleContent: "pnpm run lint:*", toolName: "Bash" }],
                type: "addRules",
              },
            ],
          },
        },
        { optionId: "deny", response: { decision: "deny" } },
      ],
    });

    const resume = new EventLog();
    // EventLog seq 从 1 重新计数不影响断言主体（seq 水位单独断言于 A 组）。
    resume.push(
      SessionEventType.PermissionResolved,
      { requestId: "req-1", toolCallId: "tc-1", decision: "allow" },
      { turnId },
    );
    resume.push(
      SessionEventType.ToolCallStarted,
      { toolCallId: "tc-1", toolName: "bash", startedAt: new Date() },
      { turnId },
    );
    resume.push(
      SessionEventType.ToolCallResult,
      { toolCallId: "tc-1", result: { success: true, content: "file-a\nfile-b" }, duration: 42 },
      { turnId },
    );
    for (const event of resume.events) projection.applyEvent(event);

    const done = projection.getSnapshot();
    expect(done.pendingInteractions).toHaveLength(0);
    const doneRow = done.rows.window.find((row) => row.kind === "toolCall");
    expect(doneRow).toMatchObject({
      status: "success",
      output: { text: "file-a\nfile-b" },
    });
    expect(
      doneRow && "approvalInteractionId" in doneRow && doneRow.approvalInteractionId,
    ).toBeFalsy();
  });

  it.each([
    { label: "空字符串", streamName: "" },
    { label: "纯空白", streamName: " \t " },
  ])("O/ETN：$label 工具名只参与恢复，不物化可见工具行", ({ streamName }) => {
    const turnId = "turn-empty-tool-name";
    const toolCallId = "call-empty-tool-name";
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "continue" }, { turnId });
    log.push(
      SessionEventType.ModelStreaming,
      {
        kind: "tool_input_start",
        delta: "",
        done: false,
        toolCallId,
        toolName: streamName,
      },
      { turnId },
    );
    log.push(
      SessionEventType.ModelStreaming,
      {
        kind: "tool_input_delta",
        delta: '{"value":1}',
        done: false,
        toolCallId,
      },
      { turnId },
    );
    log.push(
      SessionEventType.ModelStreaming,
      {
        kind: "tool_call",
        delta: "",
        done: true,
        input: { value: 1 },
        toolCallId,
        toolName: streamName,
      },
      { turnId },
    );
    log.push(
      SessionEventType.ToolCallError,
      {
        toolCallId,
        error: {
          type: "fault.runtime.toolFailed",
          message: "Model returned an invalid tool call: tool name is empty.",
        },
      },
      { turnId },
    );
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_start", delta: "", done: false },
      { turnId },
    );
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_delta", delta: "continued", done: false },
      { turnId },
    );
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_end", delta: "", done: false },
      { turnId },
    );
    log.push(
      SessionEventType.TurnComplete,
      {
        response: "continued",
        tokenCount: 1,
        toolCallCount: 1,
        duration: 10,
        resultType: "success",
      },
      { turnId },
    );

    const { deltasPerEvent, projection, snapshots } = runAll(log.events);
    expect(projection.getSnapshot().rows.window.filter((row) => row.kind === "toolCall")).toEqual(
      [],
    );
    expect(
      projection.getSnapshot().rows.window.find((row) => row.kind === "assistantText"),
    ).toMatchObject({ text: "continued", state: "complete" });
    expect(
      deltasPerEvent
        .flat()
        .some(
          (delta) =>
            (delta.op === "row.appended" || delta.op === "row.upserted") &&
            delta.row.kind === "toolCall",
        ),
    ).toBe(false);
    const direct = applyConversationDeltas(snapshots[0]!, deltasPerEvent.flat());
    for (const profile of [DELIVERY_PROFILES.continuous, DELIVERY_PROFILES.replayable]) {
      const delivered = coalesceConversationDeltas(
        filterConversationDeltasForProfile(deltasPerEvent.flat(), profile),
      );
      expect(applyConversationDeltas(snapshots[0]!, delivered)).toEqual(direct);
    }
  });

  it("O/ETN：合法 empty_tool_name 工具保留 live 与 replayable 可见生命周期", () => {
    const turnId = "turn-legitimate-empty-tool-name";
    const toolCallId = "call-legitimate-empty-tool-name";
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "run tool" }, { turnId });
    log.push(
      SessionEventType.ModelStreaming,
      {
        kind: "tool_input_start",
        delta: "",
        done: false,
        toolCallId,
        toolName: "empty_tool_name",
      },
      { turnId },
    );
    log.push(
      SessionEventType.ModelStreaming,
      {
        kind: "tool_input_delta",
        delta: '{"value":1}',
        done: false,
        toolCallId,
      },
      { turnId },
    );
    log.push(
      SessionEventType.ModelStreaming,
      {
        kind: "tool_call",
        delta: "",
        done: true,
        input: { value: 1 },
        toolCallId,
        toolName: "empty_tool_name",
      },
      { turnId },
    );
    log.push(
      SessionEventType.ToolCallScheduled,
      {
        toolCallId,
        toolName: "empty_tool_name",
        input: { value: 1 },
        schedule: { parallelGroups: [[toolCallId]], executionOrder: [toolCallId] },
      },
      { turnId },
    );
    log.push(
      SessionEventType.ToolCallResult,
      {
        toolCallId,
        result: { success: true, content: "ok" },
        duration: 1,
      },
      { turnId },
    );

    const { deltasPerEvent, projection, snapshots } = runAll(log.events);
    expect(
      projection.getSnapshot().rows.window.find((row) => row.kind === "toolCall"),
    ).toMatchObject({
      input: { value: 1 },
      status: "success",
      toolCallId,
      toolName: "empty_tool_name",
    });
    const direct = applyConversationDeltas(snapshots[0]!, deltasPerEvent.flat());
    for (const profile of [DELIVERY_PROFILES.continuous, DELIVERY_PROFILES.replayable]) {
      const delivered = coalesceConversationDeltas(
        filterConversationDeltasForProfile(deltasPerEvent.flat(), profile),
      );
      expect(applyConversationDeltas(snapshots[0]!, delivered)).toEqual(direct);
    }
  });

  it("O/ETN：普通非空 unknown tool 仍保留 terminal error 工具行", () => {
    const turnId = "turn-unknown-tool";
    const toolCallId = "call-unknown-tool";
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "continue" }, { turnId });
    log.push(
      SessionEventType.ToolCallScheduled,
      {
        toolCallId,
        toolName: "DefinitelyMissingTool",
        input: {},
        schedule: { parallelGroups: [[toolCallId]], executionOrder: [toolCallId] },
      },
      { turnId },
    );
    log.push(
      SessionEventType.ToolCallError,
      {
        toolCallId,
        error: { type: "fault.runtime.toolNotFound", message: "Tool not found" },
      },
      { turnId },
    );

    expect(
      runAll(log.events)
        .projection.getSnapshot()
        .rows.window.find((row) => row.kind === "toolCall"),
    ).toMatchObject({
      toolCallId,
      toolName: "DefinitelyMissingTool",
      status: "error",
    });
  });

  it.each(["Write", "Edit"])(
    "STIP06：%s 首包立即，后续 inputText 按事件时间戳每秒合并一次",
    (toolName) => {
      const turnId = "turn-file-tool";
      const base = 1_700_000_010_000;
      const log = new EventLog();
      log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
      log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "modify file" }, { turnId });
      log.push(
        SessionEventType.ModelStreaming,
        { kind: "tool_input_start", delta: "", done: false, toolCallId: "tc-file", toolName },
        { timestampMs: base, turnId },
      );
      log.push(
        SessionEventType.ModelStreaming,
        {
          kind: "tool_input_delta",
          delta: '{"file_path":"src/app.ts",',
          done: false,
          toolCallId: "tc-file",
        },
        { timestampMs: base + 100, turnId },
      );
      log.push(
        SessionEventType.ModelStreaming,
        { kind: "tool_input_delta", delta: '"content":"a', done: false, toolCallId: "tc-file" },
        { timestampMs: base + 400, turnId },
      );
      log.push(
        SessionEventType.ModelStreaming,
        { kind: "tool_input_delta", delta: 'b"}', done: false, toolCallId: "tc-file" },
        { timestampMs: base + 1_100, turnId },
      );

      const { deltasPerEvent, projection } = runAll(log.events);
      expect(inputTextAppends(deltasPerEvent[3] ?? [])).toEqual(['{"file_path":"src/app.ts",']);
      expect(inputTextAppends(deltasPerEvent[4] ?? [])).toEqual([]);
      expect(inputTextAppends(deltasPerEvent[5] ?? [])).toEqual(['"content":"ab"}']);
      expect(
        projection.getSnapshot().rows.window.find((row) => row.kind === "toolCall"),
      ).toMatchObject({ inputText: '{"file_path":"src/app.ts","content":"ab"}' });

      const estimateProjection = new ProductProjection("session-1", "epoch-1");
      const appendEstimates = log.events.map((event) => {
        const estimate = estimateProjection.establishedStreamingAppend(event);
        estimateProjection.applyEvent(event);
        return estimate;
      });
      expect(appendEstimates.slice(3)).toEqual([
        '{"file_path":"src/app.ts",',
        "",
        '"content":"ab"}',
      ]);
    },
  );

  it("STIP07：Write input end 立即冲刷窗口内尚未发布的 suffix", () => {
    const turnId = "turn-write-end";
    const base = 1_700_000_020_000;
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "write" }, { turnId });
    log.push(
      SessionEventType.ModelStreaming,
      {
        kind: "tool_input_start",
        delta: "",
        done: false,
        toolCallId: "tc-write",
        toolName: "Write",
      },
      { timestampMs: base, turnId },
    );
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "tool_input_delta", delta: '{"content":"a', done: false, toolCallId: "tc-write" },
      { timestampMs: base + 100, turnId },
    );
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "tool_input_delta", delta: 'b"}', done: false, toolCallId: "tc-write" },
      { timestampMs: base + 200, turnId },
    );
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "tool_input_end", delta: "", done: true, toolCallId: "tc-write" },
      { timestampMs: base + 300, turnId },
    );

    const { deltasPerEvent, projection } = runAll(log.events);
    expect(inputTextAppends(deltasPerEvent[4] ?? [])).toEqual([]);
    expect(inputTextAppends(deltasPerEvent[5] ?? [])).toEqual(['b"}']);
    expect(
      projection.getSnapshot().rows.window.find((row) => row.kind === "toolCall"),
    ).toMatchObject({ inputText: '{"content":"ab"}' });
  });

  it("STIP07：Write 被取消时把窗口内 suffix 收进 cancelled row", () => {
    const turnId = "turn-write-cancel";
    const base = 1_700_000_030_000;
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "write" }, { turnId });
    log.push(
      SessionEventType.ModelStreaming,
      {
        kind: "tool_input_start",
        delta: "",
        done: false,
        toolCallId: "tc-write",
        toolName: "Write",
      },
      { timestampMs: base, turnId },
    );
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "tool_input_delta", delta: '{"content":"a', done: false, toolCallId: "tc-write" },
      { timestampMs: base + 100, turnId },
    );
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "tool_input_delta", delta: 'b"}', done: false, toolCallId: "tc-write" },
      { timestampMs: base + 200, turnId },
    );
    log.push(
      SessionEventType.TurnComplete,
      { response: "", tokenCount: 0, toolCallCount: 0, duration: 300, resultType: "cancelled" },
      { timestampMs: base + 300, turnId },
    );

    const { deltasPerEvent, projection } = runAll(log.events);
    expect(inputTextAppends(deltasPerEvent[4] ?? [])).toEqual([]);
    expect(
      projection.getSnapshot().rows.window.find((row) => row.kind === "toolCall"),
    ).toMatchObject({ status: "cancelled", inputText: '{"content":"ab"}' });
  });

  it("STIP08：非 Write/Edit 工具保留逐投影增量", () => {
    const turnId = "turn-bash";
    const base = 1_700_000_040_000;
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "run" }, { turnId });
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "tool_input_start", delta: "", done: false, toolCallId: "tc-bash", toolName: "Bash" },
      { timestampMs: base, turnId },
    );
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "tool_input_delta", delta: '{"command":"p', done: false, toolCallId: "tc-bash" },
      { timestampMs: base + 100, turnId },
    );
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "tool_input_delta", delta: 'wd"}', done: false, toolCallId: "tc-bash" },
      { timestampMs: base + 200, turnId },
    );

    const { deltasPerEvent } = runAll(log.events);
    expect(inputTextAppends(deltasPerEvent[3] ?? [])).toEqual(['{"command":"p']);
    expect(inputTextAppends(deltasPerEvent[4] ?? [])).toEqual(['wd"}']);
  });

  it("Q：AskUserQuestion 权限等待态 → structured userInput pendingInteraction", () => {
    const turnId = "turn-ask";
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "帮我做个番茄钟" }, { turnId });
    log.push(
      SessionEventType.ToolCallScheduled,
      {
        toolCallId: "ask-1",
        toolName: "AskUserQuestion",
        input: {
          questions: [
            {
              question: "你想把这个番茄时钟作为什么形式存在？",
              header: "形式",
              options: [
                { label: "独立新页面", description: "新增页面", preview: "新增页面预览" },
                { label: "独立小工具视图", description: "嵌入现有界面" },
              ],
            },
          ],
        },
        schedule: { parallelGroups: [["ask-1"]], executionOrder: ["ask-1"] },
      },
      { turnId },
    );
    log.push(
      SessionEventType.PermissionRequested,
      {
        requestId: "ask-request-1",
        toolCallId: "ask-1",
        toolName: "AskUserQuestion",
        riskLevel: "low",
        reason: "AskUserQuestion pauses execution to collect answers from the user",
        origin: {
          kind: "subagent",
          agentId: "agent-ask",
          agentType: "general-purpose",
          childSessionId: "sess-child-ask",
          description: "Ask from child",
          parentSessionId: "session-1",
          parentToolCallId: "call-parent-agent",
          parentTurnId: turnId,
        },
        input: {
          questions: [
            {
              question: "你想把这个番茄时钟作为什么形式存在？",
              header: "形式",
              options: [
                { label: "独立新页面", description: "新增页面", preview: "新增页面预览" },
                { label: "独立小工具视图", description: "嵌入现有界面" },
              ],
            },
          ],
        },
      },
      { turnId },
    );

    const { projection } = runAll(log.events);
    const snapshot = projection.getSnapshot();
    const toolRow = snapshot.rows.window.find((row) => row.kind === "toolCall");
    expect(toolRow).toMatchObject({
      status: "pendingApproval",
      approvalInteractionId: "ask-request-1",
    });
    expect(snapshot.pendingInteractions).toHaveLength(1);
    expect(snapshot.pendingInteractions[0]).toMatchObject({
      interactionId: "ask-request-1",
      kind: "userInput",
      anchorRowId: toolRow?.rowId,
      payload: {
        kind: "userInput",
        toolName: "AskUserQuestion",
        toolCallId: "ask-1",
        origin: {
          kind: "subagent",
          agentId: "agent-ask",
          childSessionId: "sess-child-ask",
          parentSessionId: "session-1",
          parentToolCallId: "call-parent-agent",
        },
        prompt: "AskUserQuestion pauses execution to collect answers from the user",
        freeText: true,
        schema: { toolName: "AskUserQuestion" },
        questions: [
          {
            question: "你想把这个番茄时钟作为什么形式存在？",
            header: "形式",
            options: [
              {
                value: "独立新页面",
                label: "独立新页面",
                description: "新增页面",
                preview: "新增页面预览",
              },
              { value: "独立小工具视图", label: "独立小工具视图", description: "嵌入现有界面" },
            ],
          },
        ],
      },
    });

    const autoResolutionLog = new EventLog();
    const hiddenGrace = {
      state: "hiddenGrace" as const,
      startedAt: 1_700_000_000_000,
      visibleAt: 1_700_000_060_000,
      deadlineAt: 1_700_000_300_000,
    };
    projection.applyEvent(
      autoResolutionLog.push(
        SessionEventType.UserInputAutoResolutionUpdated,
        {
          interactionId: "ask-request-1",
          toolCallId: "ask-1",
          autoResolution: hiddenGrace,
        },
        { turnId },
      ),
    );
    expect(projection.getSnapshot().pendingInteractions[0]?.autoResolution).toEqual(hiddenGrace);

    const visibleCountdown = { ...hiddenGrace, state: "visibleCountdown" as const };
    projection.applyEvent(
      autoResolutionLog.push(
        SessionEventType.UserInputAutoResolutionUpdated,
        {
          interactionId: "ask-request-1",
          toolCallId: "ask-1",
          autoResolution: visibleCountdown,
        },
        { turnId },
      ),
    );
    expect(projection.getSnapshot().pendingInteractions[0]?.autoResolution).toEqual(
      visibleCountdown,
    );

    const snoozed = {
      state: "snoozed" as const,
      startedAt: hiddenGrace.startedAt,
      snoozedAt: 1_700_000_299_000,
    };
    projection.applyEvent(
      autoResolutionLog.push(
        SessionEventType.UserInputAutoResolutionUpdated,
        {
          interactionId: "ask-request-1",
          toolCallId: "ask-1",
          autoResolution: snoozed,
        },
        { turnId },
      ),
    );
    expect(projection.getSnapshot().pendingInteractions[0]?.autoResolution).toEqual(snoozed);

    const resume = new EventLog();
    projection.applyEvent(
      resume.push(
        SessionEventType.PermissionResolved,
        { requestId: "ask-request-1", toolCallId: "ask-1", decision: "allow" },
        { turnId },
      ),
    );
    expect(projection.getSnapshot().pendingInteractions).toHaveLength(0);
  });

  it("Q：ExitPlanMode 权限等待态 → plan approval elicitation pendingInteraction", () => {
    const turnId = "turn-plan";
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "进入计划模式" }, { turnId });
    log.push(
      SessionEventType.ToolCallScheduled,
      {
        toolCallId: "exit-plan-1",
        toolName: "ExitPlanMode",
        input: { plan: "1. 增加协议\n2. 补 UI" },
        schedule: { parallelGroups: [["exit-plan-1"]], executionOrder: ["exit-plan-1"] },
      },
      { turnId },
    );
    log.push(
      SessionEventType.PermissionRequested,
      {
        requestId: "plan-request-1",
        toolCallId: "exit-plan-1",
        toolName: "ExitPlanMode",
        riskLevel: "low",
        reason: "ExitPlanMode requires user approval before implementation",
        input: { plan: "1. 增加协议\n2. 补 UI" },
      },
      { turnId },
    );

    const { projection } = runAll(log.events);
    expect(projection.getSnapshot().pendingInteractions[0]).toMatchObject({
      kind: "userInput",
      payload: {
        kind: "userInput",
        toolName: "ExitPlanMode",
        toolCallId: "exit-plan-1",
        schema: { interaction: "plan_approval", toolName: "ExitPlanMode" },
        questions: [
          {
            header: "Plan",
            question: "ExitPlanMode requires user approval before implementation",
            options: [
              {
                value: "approve",
                label: "Approve",
                description: "Exit plan mode and start implementation.",
              },
            ],
          },
        ],
      },
    });
  });

  it("Q：权限拒绝 → toolCall cancelled，交互清除", () => {
    const turnId = "turn-1";
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "rm -rf" }, { turnId });
    log.push(
      SessionEventType.ToolCallScheduled,
      {
        toolCallId: "tc-1",
        toolName: "bash",
        input: { command: "rm -rf /" },
        schedule: { parallelGroups: [["tc-1"]], executionOrder: ["tc-1"] },
      },
      { turnId },
    );
    log.push(
      SessionEventType.PermissionRequested,
      {
        requestId: "req-1",
        toolCallId: "tc-1",
        toolName: "bash",
        riskLevel: "high",
        reason: "Destructive",
        input: {},
      },
      { turnId },
    );
    log.push(
      SessionEventType.PermissionResolved,
      { requestId: "req-1", toolCallId: "tc-1", decision: "deny" },
      { turnId },
    );
    const { projection } = runAll(log.events);
    const snapshot = projection.getSnapshot();
    expect(snapshot.pendingInteractions).toHaveLength(0);
    expect(snapshot.rows.window.find((row) => row.kind === "toolCall")).toMatchObject({
      status: "cancelled",
    });
  });

  it("O：SubagentSpawned/Stopped → subagent row success 并保留 child session 下钻信息", () => {
    const turnId = "turn-1";
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "派子代理" }, { turnId });
    log.push(
      SessionEventType.SubagentSpawned,
      {
        agentId: "agent-1",
        agentType: "Explore",
        childSessionId: "sess_child_1",
        description: "探索项目结构",
        parentToolCallId: "call-agent-1",
        prompt: "请探索项目",
        status: "running",
      },
      { turnId },
    );
    log.push(
      SessionEventType.SubagentStopped,
      {
        agentId: "agent-1",
        agentType: "Explore",
        childSessionId: "sess_child_1",
        status: "completed",
        summaryText: "项目结构已经梳理完成",
      },
      { turnId },
    );
    const { projection } = runAll(log.events);
    expect(
      projection.getSnapshot().rows.window.find((row) => row.kind === "subagent"),
    ).toMatchObject({
      childSessionId: "sess_child_1",
      parentToolCallId: "call-agent-1",
      status: "success",
      subagentType: "Explore",
      summaryText: "项目结构已经梳理完成",
    });
    expect(projection.getSnapshot().subagents).toMatchObject({
      childSessionIds: ["sess_child_1"],
      running: [],
      endedTotal: 1,
    });
  });

  it("SAT12：SendMessage resumed spawn 在同一次投影中恢复原 row 和 cancellable work", () => {
    const turnId = "turn-send-message-resume";
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: "先运行前台 Agent" },
      { turnId },
    );
    log.push(
      SessionEventType.SubagentSpawned,
      {
        agentId: "agent-resume",
        agentType: "general-purpose",
        childSessionId: "sess-child-resume",
        description: "前台任务",
        parentToolCallId: "call-agent",
        status: "running",
      },
      { turnId },
    );
    log.push(
      SessionEventType.SubagentStopped,
      {
        agentId: "agent-resume",
        agentType: "general-purpose",
        childSessionId: "sess-child-resume",
        parentToolCallId: "call-agent",
        status: "completed",
      },
      { turnId },
    );

    const projection = new ProductProjection("session-1", "epoch-1");
    for (const item of log.events) projection.applyEvent(item);
    const resumedEvent = log.push(
      SessionEventType.SubagentSpawned,
      {
        agentId: "agent-resume",
        agentType: "general-purpose",
        background: true,
        childSessionId: "sess-child-resume",
        description: "恢复到后台",
        parentToolCallId: "call-send-message",
        resumed: true,
        status: "running",
      },
      { turnId },
    );
    const deltas = projection.applyEvent(resumedEvent);
    const snapshot = projection.getSnapshot();

    expect(
      snapshot.rows.window.filter(
        (row) => row.kind === "subagent" && row.entityId === "agent-resume",
      ),
    ).toHaveLength(1);
    expect(snapshot.rows.window.find((row) => row.kind === "subagent")).toMatchObject({
      childSessionId: "sess-child-resume",
      parentToolCallId: "call-agent",
      status: "running",
    });
    expect(snapshot.backgroundWorks).toEqual([
      expect.objectContaining({
        workId: "agent-resume",
        kind: "subagent",
        childSessionId: "sess-child-resume",
        cancellable: true,
        status: "running",
        title: "恢复到后台",
      }),
    ]);
    expect(snapshot.subagents).toMatchObject({
      childSessionIds: ["sess-child-resume"],
      running: [expect.objectContaining({ childSessionId: "sess-child-resume" })],
      endedTotal: 0,
    });
    expect(
      deltas.some(
        (delta) => delta.op === "state.updated" && delta.patch.backgroundWorks?.length === 1,
      ),
    ).toBe(true);
    expect(
      deltas.some(
        (delta) => delta.op === "state.updated" && delta.patch.subagents?.running.length === 1,
      ),
    ).toBe(true);

    projection.applyEvent(
      log.push(
        SessionEventType.BackgroundTaskCompleted,
        {
          taskId: "agent-resume",
          toolName: "Agent",
          taskKind: "subagent",
          childSessionId: "sess-child-resume",
          status: "cancelled",
          cancellable: false,
        },
        { turnId },
      ),
    );
    projection.applyEvent(
      log.push(
        SessionEventType.SubagentStopped,
        {
          agentId: "agent-resume",
          agentType: "general-purpose",
          background: true,
          childSessionId: "sess-child-resume",
          parentToolCallId: "call-send-message",
          status: "cancelled",
        },
        { turnId },
      ),
    );
    const terminalSnapshot = projection.getSnapshot();
    expect(terminalSnapshot.rows.window.find((row) => row.kind === "subagent")).toMatchObject({
      parentToolCallId: "call-agent",
      status: "cancelled",
    });
    expect(terminalSnapshot.backgroundWorks).toEqual([
      expect.objectContaining({ workId: "agent-resume", status: "cancelled" }),
    ]);
  });

  it("SAT24：7 个毫秒级并行 spawn 在每次 row 提交中原子发布完整 running 投影", () => {
    const turnId = "turn-parallel-subagents";
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, {
      mode: "default",
      contextWindow: 1000,
    });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "并行派生" }, { turnId });
    for (let index = 1; index <= 7; index += 1) {
      log.push(
        SessionEventType.SubagentSpawned,
        {
          agentId: `agent-${index}`,
          agentType: "Explore",
          childSessionId: `sess_child_${index}`,
          description: `并行子智能体 ${index}`,
          parentToolCallId: `call-agent-${index}`,
          status: "running",
        },
        { turnId, timestampMs: 1_700_000_000_000 + index },
      );
    }

    const projection = new ProductProjection("session-1", "epoch-1");
    for (const event of log.events) {
      const deltas = projection.applyEvent(event);
      if (event.type !== SessionEventType.SubagentSpawned) continue;
      const expectedCount = Number((event.payload as { agentId: string }).agentId.split("-")[1]);
      const subagentPatch = deltas.find(
        (delta) => delta.op === "state.updated" && delta.patch.subagents,
      );
      expect(deltas.some((delta) => delta.op === "row.appended")).toBe(true);
      expect(subagentPatch).toMatchObject({
        op: "state.updated",
        patch: {
          subagents: {
            childSessionIds: expect.arrayContaining([`sess_child_${expectedCount}`]),
            endedTotal: 0,
          },
        },
      });
      expect(projection.getSnapshot().subagents?.running).toHaveLength(expectedCount);
    }
    expect(projection.getSnapshot().subagents).toMatchObject({
      childSessionIds: Array.from({ length: 7 }, (_, index) => `sess_child_${index + 1}`),
      endedTotal: 0,
    });
  });

  it("SAT22：cold seed 持续排除未持久化 ghost，直到新的合法 spawn", () => {
    const turnId = "turn-cold-subagent-seed";
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, {
      mode: "default",
      contextWindow: 1000,
    });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "历史派生" }, { turnId });
    log.push(
      SessionEventType.SubagentSpawned,
      {
        agentId: "agent-reliable",
        agentType: "Explore",
        childSessionId: "sess-reliable",
        description: "可靠 child",
        status: "running",
      },
      { turnId },
    );
    log.push(
      SessionEventType.SubagentSpawned,
      {
        agentId: "agent-ghost",
        agentType: "Explore",
        childSessionId: "sess-ghost",
        description: "旧版本 ghost",
        status: "running",
      },
      { turnId },
    );

    const projection = new ProductProjection("session-1", "epoch-1");
    for (const event of log.events) projection.applyEvent(event);
    projection.seedSubagents({
      revision: 10,
      childSessionIds: ["sess-reliable"],
      running: [
        {
          agentId: "agent-reliable",
          childSessionId: "sess-reliable",
          status: "running",
          subagentType: "Explore",
          title: "可靠 child",
        },
      ],
    });
    expect(projection.getSnapshot().subagents).toMatchObject({
      revision: 10,
      childSessionIds: ["sess-reliable"],
      running: [{ childSessionId: "sess-reliable" }],
      endedTotal: 0,
    });

    projection.applyEvent(
      log.push(SessionEventType.ModelSelected, {
        modelSelection: {
          providerId: "test-provider",
          modelId: "test-model",
        },
      }),
    );
    expect(projection.getSnapshot().subagents?.childSessionIds).toEqual(["sess-reliable"]);

    projection.applyEvent(
      log.push(
        SessionEventType.SubagentSpawned,
        {
          agentId: "agent-ghost",
          agentType: "Explore",
          childSessionId: "sess-ghost",
          description: "已持久化后恢复",
          resumed: true,
          status: "running",
        },
        { turnId },
      ),
    );
    expect(projection.getSnapshot().subagents?.childSessionIds).toEqual([
      "sess-reliable",
      "sess-ghost",
    ]);
    expect(projection.getSnapshot().subagents?.running).toHaveLength(2);
  });

  it("SAT22：非空 cold manifest 即使旧查询 revision 为 0 也会建立有效版本", () => {
    const projection = new ProductProjection("session-1", "epoch-1");
    projection.seedSubagents({
      revision: 0,
      childSessionIds: ["sess-reliable"],
      running: [],
    });
    expect(projection.getSnapshot().subagents).toMatchObject({
      revision: 1,
      childSessionIds: ["sess-reliable"],
      endedTotal: 1,
    });
  });

  // ── M 组：turn steer 队列 ──

  it("M：steer 入队/注入 —— queue.items 生命周期", () => {
    const turnId = "turn-1";
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "hi" }, { turnId });
    log.push(
      SessionEventType.TurnSteerQueued,
      {
        pendingInputId: "pi-1",
        inputId: "command-original",
        input: "顺便加个测试",
        inputPreview: "顺便加个测试",
        inputSize: 6,
        targetTurnId: turnId,
        queueLength: 1,
        delivery: "guide",
        intent: {
          sourceCommandId: "command-original",
          queueItemId: "pi-1",
          clientId: "mobile-client",
          kind: "sendText",
          admissionSeq: 12,
          admittedAt: 1234,
          requestedDelivery: "guide",
          admittedDelivery: "guide",
          highspeed: {
            schemaVersion: 1,
            cardId: "hsc-queue",
            taskId: "session-1",
            provider: "builtin:bigmodel-coding-plan",
            model: "GLM-5.3",
            issuedAt: 1_700_000_000_000,
            expiresAt: 1_700_000_900_000,
          },
          attachmentRefs: [
            { ref: "artifact://one", fileName: "one.txt", mime: "text/plain", bytes: 3 },
          ],
        },
      },
      { turnId },
    );
    const { projection } = runAll(log.events);
    expect(projection.getSnapshot().queue.items).toHaveLength(1);
    expect(projection.getSnapshot().queue.items[0]).toMatchObject({
      queueItemId: "pi-1",
      kind: "sendText",
      text: "顺便加个测试",
      sourceCommandId: "command-original",
      clientId: "mobile-client",
      attachments: [{ ref: "artifact://one", fileName: "one.txt", mime: "text/plain", bytes: 3 }],
      delivery: { requested: "guide", admitted: "guide" },
      order: { admissionSeq: 12, queuePosition: 0 },
      steer: { state: "steering" },
      dispatch: { state: "queued" },
      highspeed: { cardId: "hsc-queue", expiresAt: 1_700_000_900_000 },
      admittedAt: 1234,
    });

    const drain = new EventLog();
    drain.push(
      SessionEventType.TurnSteerDrained,
      {
        pendingInputIds: ["pi-1"],
        targetTurnId: turnId,
        injectedMessageIds: ["message-drained"],
        drainedInputs: [
          {
            pendingInputId: "pi-1",
            messageId: "message-drained",
            text: "顺便加个测试",
            delivery: "guide",
            intent: {
              sourceCommandId: "command-original",
              queueItemId: "pi-1",
              clientId: "mobile-client",
              kind: "sendText",
              admissionSeq: 12,
              admittedAt: 1234,
              requestedDelivery: "guide",
              admittedDelivery: "guide",
              attachmentRefs: [
                {
                  ref: "artifact://one",
                  fileName: "one.txt",
                  mime: "text/plain",
                  bytes: 3,
                },
              ],
            },
          },
        ],
      },
      { turnId },
    );
    for (const event of drain.events) projection.applyEvent(event);
    expect(projection.getSnapshot().queue.items).toHaveLength(0);
    expect(projection.getSnapshot().rows.window.at(-1)).toMatchObject({
      kind: "userInput",
      text: "顺便加个测试",
      guided: true,
      sourceCommandId: "command-original",
      clientId: "mobile-client",
      attachments: [{ ref: "artifact://one", fileName: "one.txt", mime: "text/plain", bytes: 3 }],
    });
  });

  it("M：goal command 入队 —— queue item 保留 sendGoalCommand kind", () => {
    const turnId = "turn-1";
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "hi" }, { turnId });
    log.push(
      SessionEventType.TurnSteerQueued,
      {
        pendingInputId: "pi-goal",
        commandKind: "sendGoalCommand",
        input: "/goal 新目标",
        inputPreview: "/goal 新目标",
        inputSize: 12,
        targetTurnId: turnId,
        queueLength: 1,
      },
      { turnId },
    );
    const { projection } = runAll(log.events);
    expect(projection.getSnapshot().queue.items[0]).toMatchObject({
      queueItemId: "pi-goal",
      kind: "sendGoalCommand",
      text: "/goal 新目标",
    });
  });

  it("M：guide/附件 fallback 保留 requested/admitted 与 reasonCode", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(
      SessionEventType.TurnSteerQueued,
      {
        pendingInputId: "queue-fallback",
        inputId: "command-fallback",
        input: "带附件",
        inputPreview: "带附件",
        inputSize: 9,
        delivery: "queue",
        targetTurnId: "turn-1",
        queueLength: 1,
        intent: {
          sourceCommandId: "command-fallback",
          queueItemId: "queue-fallback",
          clientId: "desktop-client",
          kind: "sendText",
          admissionSeq: 2,
          admittedAt: 50,
          requestedDelivery: "guide",
          admittedDelivery: "queue",
          fallbackReasonCode: "guide.attachmentsUnsupported",
          attachmentRefs: [
            { ref: "artifact://a", fileName: "a.txt", mime: "text/plain", bytes: 1 },
          ],
        },
      },
      { turnId: "turn-1" },
    );
    const { projection } = runAll(log.events);
    expect(projection.getSnapshot().queue.items[0]).toMatchObject({
      sourceCommandId: "command-fallback",
      attachments: [{ ref: "artifact://a" }],
      delivery: {
        requested: "guide",
        admitted: "queue",
        fallbackReasonCode: "guide.attachmentsUnsupported",
      },
      steer: { state: "fellBack", reasonCode: "guide.attachmentsUnsupported" },
    });
  });

  it("M：text-only terminal 以 delivery changed 原地把 guide 改投 queue", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(
      SessionEventType.TurnSteerQueued,
      {
        pendingInputId: "queue-guide-terminal",
        input: "等下一个工具边界",
        inputPreview: "等下一个工具边界",
        inputSize: 9,
        delivery: "guide",
        targetTurnId: "turn-1",
        queueLength: 1,
        intent: {
          sourceCommandId: "command-guide-terminal",
          queueItemId: "queue-guide-terminal",
          clientId: "desktop-client",
          kind: "sendText",
          admissionSeq: 3,
          admittedAt: 60,
          requestedDelivery: "guide",
          admittedDelivery: "guide",
        },
      },
      { turnId: "turn-1" },
    );
    log.push(
      SessionEventType.TurnSteerDeliveryChanged,
      {
        pendingInputId: "queue-guide-terminal",
        targetTurnId: "turn-1",
        requestedDelivery: "guide",
        admittedDelivery: "queue",
        fallbackReasonCode: "guide.noToolBoundary",
      },
      { turnId: "turn-1" },
    );

    const { projection } = runAll(log.events);

    expect(projection.getSnapshot().queue.items).toEqual([
      expect.objectContaining({
        queueItemId: "queue-guide-terminal",
        text: "等下一个工具边界",
        delivery: {
          requested: "guide",
          admitted: "queue",
          fallbackReasonCode: "guide.noToolBoundary",
        },
        steer: { state: "fellBack", reasonCode: "guide.noToolBoundary" },
      }),
    ]);
  });

  // ── 错误态 ──

  it("错误：turn_error → phase=error + lastError + turnHeader failed", () => {
    const turnId = "turn-1";
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "hi" }, { turnId });
    log.push(
      SessionEventType.TurnError,
      { error: { type: "ProviderError", message: "rate limited" }, turnPhase: "model" },
      { turnId },
    );
    const { projection } = runAll(log.events);
    const snapshot = projection.getSnapshot();
    expect(snapshot.control.phase).toBe("error");
    expect(snapshot.control.lastError).toMatchObject({
      code: "ProviderError",
      message: "rate limited",
      recoverable: true,
      source: "runtime",
    });
    expect(snapshot.rows.window.find((row) => row.kind === "turnHeader")).toMatchObject({
      state: "failed",
    });
  });

  it("错误：TurnError 保留底层错误详情到 V4 lastError", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "hi" }, { turnId: "turn-1" });
    log.push(
      SessionEventType.TurnError,
      {
        error: {
          type: "ModelError",
          message: "Model request failed",
          underlyingErrorMessage: "Runtime headers request failed",
          underlyingErrorDetail: "Runtime headers helper timed out after 10000ms.",
        },
        turnPhase: "model",
      },
      { turnId: "turn-1" },
    );

    expect(runAll(log.events).projection.getSnapshot().control.lastError).toMatchObject({
      underlyingErrorMessage: "Runtime headers request failed",
      underlyingErrorDetail: "Runtime headers helper timed out after 10000ms.",
    });
  });

  it.each([
    ["card-highspeed-1", "card-highspeed-1"],
    [null, null],
  ] as const)("错误：TurnError 的 Highspeed 卡归因 %s 透传到 V4 lastError", (value, expected) => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(
      SessionEventType.TurnError,
      {
        error: {
          type: "ModelError",
          message: "Model creation failed",
          code: "provider_not_found",
          attribution: { source: "provider", highspeedCardId: value },
        },
        turnPhase: "model_creation",
      },
      { turnId: "turn-1" },
    );

    expect(runAll(log.events).projection.getSnapshot().control.lastError).toMatchObject({
      code: "provider_not_found",
      attribution: { source: "provider", highspeedCardId: expected },
    });
  });

  it("错误：请求期 Highspeed 无处可退的归因原样透传到 V4 lastError", () => {
    // 3402 是 provider 错误码而非目录错误；Renderer 退卡只能依赖 Core 发布的结构化事实。
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(
      SessionEventType.TurnError,
      {
        error: {
          type: "ModelError",
          message: "highspeed card is invalid",
          code: "3402",
          attribution: {
            source: "provider",
            providerId: "account:bigmodel-highspeed-card",
            providerErrorCode: "3402",
            statusCode: 400,
            highspeedCardId: "card-highspeed-request",
            highspeedFallbackUnavailable: true,
          },
        },
        turnPhase: "model",
      },
      { turnId: "turn-1" },
    );

    expect(runAll(log.events).projection.getSnapshot().control.lastError).toMatchObject({
      code: "3402",
      source: "provider",
      attribution: {
        providerErrorCode: "3402",
        highspeedCardId: "card-highspeed-request",
        highspeedFallbackUnavailable: true,
      },
    });
  });

  it("错误：TurnError 保留 future queue 并暂停自动消费", () => {
    const turnId = "turn-error-queue";
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "首轮失败" }, { turnId });
    log.push(
      SessionEventType.TurnSteerQueued,
      {
        pendingInputId: "queue-after-error",
        inputId: "input-after-error",
        input: "错误后仍要发送",
        inputPreview: "错误后仍要发送",
        inputSize: 24,
        targetTurnId: turnId,
        queueLength: 1,
        delivery: "queue",
      },
      { turnId },
    );
    log.push(
      SessionEventType.TurnError,
      { error: { type: "ProviderError", message: "provider 失败" }, turnPhase: "model" },
      { turnId },
    );

    const { projection } = runAll(log.events);
    const snapshot = projection.getSnapshot();
    expect(snapshot.control.phase).toBe("error");
    expect(snapshot.queue).toMatchObject({
      autoDrain: false,
      pauseReason: "error",
      items: [expect.objectContaining({ queueItemId: "queue-after-error" })],
    });
    expect(() => conversationSnapshotSchema.parse(snapshot)).not.toThrow();
  });

  it.each([true, false])("错误：TurnError retryable=%s 原样映射 recoverable", (retryable) => {
    const turnId = "turn-retryable";
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "hi" }, { turnId });
    log.push(
      SessionEventType.TurnError,
      {
        error: { type: "ProviderError", message: "failed", retryable },
        turnPhase: "model",
      },
      { turnId },
    );

    const { projection } = runAll(log.events);

    expect(projection.getSnapshot().control.lastError?.recoverable).toBe(retryable);
  });

  it("错误：TurnError 结构化归因进入 lastError，但不改写既有 recoverable", () => {
    const turnId = "turn-attribution";
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "hi" }, { turnId });
    log.push(
      SessionEventType.TurnError,
      {
        error: {
          type: "model_request_failed",
          message: "Provider stream failed",
          attribution: {
            source: "network",
            reason: "network_error",
            providerId: "default-deepseek",
            modelId: "deepseek-v4-flash",
            providerKind: "anthropic",
            transport: "sse",
            statusCode: 503,
            retryable: false,
          },
        },
        turnPhase: "model",
      },
      { turnId },
    );

    const { projection } = runAll(log.events);
    const snapshot = projection.getSnapshot();

    expect(snapshot.control.lastError).toMatchObject({
      source: "network",
      recoverable: true,
      attribution: {
        source: "network",
        reason: "network_error",
        providerId: "default-deepseek",
        modelId: "deepseek-v4-flash",
        providerKind: "anthropic",
        transport: "sse",
        statusCode: 503,
        retryable: false,
      },
    });
    expect(() => conversationSnapshotSchema.parse(snapshot)).not.toThrow();
  });

  it("错误后新 turn 清除 lastError（与旧 reducer 同一裁决）", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "hi" }, { turnId: "turn-1" });
    log.push(
      SessionEventType.TurnError,
      { error: { type: "X", message: "boom" }, turnPhase: "model" },
      { turnId: "turn-1" },
    );
    log.push(SessionEventType.TurnStarted, { turnNumber: 2, input: "retry" }, { turnId: "turn-2" });
    const { projection } = runAll(log.events);
    expect(projection.getSnapshot().control.lastError).toBeNull();
    expect(projection.getSnapshot().control.phase).toBe("running");
  });

  it("K10：retry 目标只允许全时间线最后一条 assistantText row", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    for (const turnNumber of [1, 2]) {
      const turnId = `turn-${turnNumber}`;
      log.push(
        SessionEventType.TurnStarted,
        { turnNumber, input: `Q${turnNumber}`, messageId: `user-${turnNumber}` },
        { turnId },
      );
      log.push(
        SessionEventType.ModelStreaming,
        {
          kind: "text_start",
          delta: "",
          done: false,
          assistantMessageId: `assistant-${turnNumber}`,
        },
        { turnId },
      );
      log.push(
        SessionEventType.ModelStreaming,
        { kind: "text_delta", delta: `A${turnNumber}`, done: false },
        { turnId },
      );
      log.push(
        SessionEventType.ModelStreaming,
        { kind: "text_end", delta: "", done: false },
        { turnId },
      );
      log.push(
        SessionEventType.TurnComplete,
        {
          response: `A${turnNumber}`,
          tokenCount: 1,
          toolCallCount: 0,
          duration: 100,
          resultType: "success",
        },
        { turnId },
      );
    }
    const { projection } = runAll(log.events);
    const assistantRows = projection
      .getSnapshot()
      .rows.window.filter((row) => row.kind === "assistantText");

    expect(assistantRows).toHaveLength(2);
    expect(projection.isLatestRetryAssistantRow(assistantRows[0]!.rowId)).toBe(false);
    expect(projection.isLatestRetryAssistantRow(assistantRows[1]!.rowId)).toBe(true);
    expect(assistantRows[0]!.actions?.canRetry).not.toBe(true);
    expect(assistantRows[1]!.actions?.canRetry).toBe(true);
    expect(projection.getMessageIdForRow(assistantRows[1]!.rowId)).toBe("assistant-2");
  });

  it("BG33/K11：background 结果轮无普通 retry，且不会恢复更早真实用户轮", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    const { projection } = runAll(log.events);
    const apply = (type: SessionEventTypeUnion, payload: unknown, turnId: string): void => {
      projection.applyEvent(log.push(type, payload, { turnId }));
    };
    const appendCompletedTurn = (input: {
      assistantMessageId: string;
      input: string;
      inputSource?: "background_task";
      messageId: string;
      turnId: string;
      turnNumber: number;
    }): void => {
      apply(
        SessionEventType.TurnStarted,
        {
          turnNumber: input.turnNumber,
          input: input.input,
          messageId: input.messageId,
          ...(input.inputSource
            ? { inputSource: input.inputSource, inputVisibility: "model-only" }
            : {}),
        },
        input.turnId,
      );
      apply(
        SessionEventType.ModelStreaming,
        {
          kind: "text_start",
          delta: "",
          done: false,
          assistantMessageId: input.assistantMessageId,
        },
        input.turnId,
      );
      apply(
        SessionEventType.ModelStreaming,
        { kind: "text_delta", delta: `answer ${input.turnNumber}`, done: false },
        input.turnId,
      );
      apply(
        SessionEventType.ModelStreaming,
        { kind: "text_end", delta: "", done: false },
        input.turnId,
      );
      apply(
        SessionEventType.TurnComplete,
        {
          response: `answer ${input.turnNumber}`,
          tokenCount: 1,
          toolCallCount: 0,
          duration: 100,
          resultType: "success",
        },
        input.turnId,
      );
    };

    appendCompletedTurn({
      assistantMessageId: "assistant-user-1",
      input: "Q1",
      messageId: "user-1",
      turnId: "turn-user-1",
      turnNumber: 1,
    });
    let assistantRows = projection
      .getSnapshot()
      .rows.window.filter((row) => row.kind === "assistantText");
    expect(assistantRows.map((row) => row.actions?.canRetry === true)).toEqual([true]);

    appendCompletedTurn({
      assistantMessageId: "assistant-background-1",
      input: "background result",
      inputSource: "background_task",
      messageId: "wake-1",
      turnId: "turn-background-1",
      turnNumber: 2,
    });
    assistantRows = projection
      .getSnapshot()
      .rows.window.filter((row) => row.kind === "assistantText");
    expect(assistantRows.map((row) => row.actions?.canRetry === true)).toEqual([false, false]);
    expect(assistantRows[1]!.actions?.canFork).toBe(true);
    const backgroundEntityId = projection.getEntityIdForRow(assistantRows[1]!.rowId);
    expect(backgroundEntityId).toBeTruthy();
    expect(
      projection.resolveRowActionTarget(
        { rowId: assistantRows[1]!.rowId, entityId: backgroundEntityId! },
        "retryTurn",
      ),
    ).toEqual({ ok: false, status: "rejected", reasonCode: "guard.actionUnavailable" });

    appendCompletedTurn({
      assistantMessageId: "assistant-user-2",
      input: "Q2",
      messageId: "user-2",
      turnId: "turn-user-2",
      turnNumber: 3,
    });
    assistantRows = projection
      .getSnapshot()
      .rows.window.filter((row) => row.kind === "assistantText");
    expect(assistantRows.map((row) => row.actions?.canRetry === true)).toEqual([
      false,
      false,
      true,
    ]);
  });
});

describe("V4 API 重试状态投影", () => {
  function runningProjection(): { log: EventLog; projection: ProductProjection } {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    log.push(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: "触发模型请求", messageId: "user-retry-1" },
      { turnId: "turn-retry-1" },
    );
    return { log, projection: runAll(log.events).projection };
  }

  function modelStatus(overrides: Record<string, unknown>): Record<string, unknown> {
    return {
      timestamp: "2026-07-14T07:25:25.985Z",
      traceId: "trace-1",
      requestId: "request-retry-1",
      model: { providerId: "bigmodel", modelId: "glm-5.2" },
      transport: "sse",
      attempt: 1,
      maxAttempts: 11,
      ...overrides,
    };
  }

  it("配置读取重试保留错误类别，桌面与手机使用同一状态", () => {
    const { log, projection } = runningProjection();
    const deltas = projection.applyEvent(
      log.push(
        SessionEventType.ModelNetworkStatus,
        modelStatus({
          type: "model_retry_scheduled",
          delayMs: 2000,
          nextAttempt: 2,
          reason: "network_error",
          errorCode: ModelErrorCode.ModelRequestVerificationConfigNetwork,
        }),
        { turnId: "turn-retry-1" },
      ),
    );
    expect(projection.getSnapshot().control.apiRetry?.reasonCode).toBe(
      "request_verification_config_network",
    );
    expect(() => conversationSnapshotSchema.parse(projection.getSnapshot())).not.toThrow();
    for (const profile of [DELIVERY_PROFILES.continuous, DELIVERY_PROFILES.replayable]) {
      expect(filterConversationDeltasForProfile(deltas, profile)).toEqual(deltas);
    }
  });

  it("429 重试在两个 delivery profile 中可见，并保持到首次有效模型进展", () => {
    const { log, projection } = runningProjection();
    const scheduledAt = 1_721_000_000_000;
    const scheduled = log.push(
      SessionEventType.ModelNetworkStatus,
      modelStatus({
        type: "model_retry_scheduled",
        delayMs: 44_000,
        nextAttempt: 2,
        reason: "rate_limited",
        message: "rate limited",
        statusCode: 429,
      }),
      { turnId: "turn-retry-1", timestampMs: scheduledAt },
    );

    const retryDeltas = projection.applyEvent(scheduled);
    expect(projection.getSnapshot().control.apiRetry).toEqual({
      attempt: 1,
      maxAttempts: 11,
      nextRetryAt: scheduledAt + 44_000,
      reasonCode: "fault.provider.rateLimited",
    });
    expect(() => conversationSnapshotSchema.parse(projection.getSnapshot())).not.toThrow();
    for (const profile of [DELIVERY_PROFILES.continuous, DELIVERY_PROFILES.replayable]) {
      expect(filterConversationDeltasForProfile(retryDeltas, profile)).toEqual(retryDeltas);
    }

    const retryStarted = log.push(
      SessionEventType.ModelNetworkStatus,
      modelStatus({ type: "model_request_started", attempt: 2 }),
      { turnId: "turn-retry-1" },
    );
    expect(projection.applyEvent(retryStarted)).toEqual([]);
    expect(projection.getSnapshot().control.apiRetry?.attempt).toBe(1);

    projection.applyEvent(
      log.push(
        SessionEventType.ModelStreaming,
        {
          kind: "text_start",
          delta: "",
          done: false,
          assistantMessageId: "assistant-retry-1",
        },
        { turnId: "turn-retry-1" },
      ),
    );
    expect(projection.getSnapshot().control.apiRetry?.attempt).toBe(1);

    projection.applyEvent(
      log.push(
        SessionEventType.ModelStreaming,
        { kind: "text_delta", delta: "连接已恢复", done: false },
        { turnId: "turn-retry-1" },
      ),
    );
    expect(projection.getSnapshot().control.apiRetry).toBeNull();
  });

  it("签名修复复用 provider retry live-tail 状态", () => {
    const { log, projection } = runningProjection();
    const scheduledAt = 1_721_000_000_000;

    projection.applyEvent(
      log.push(
        SessionEventType.ModelNetworkStatus,
        modelStatus({
          type: "model_retry_scheduled",
          delayMs: 0,
          maxAttempts: 2,
          nextAttempt: 2,
          reason: "reasoning_signature_repair",
          message: "thinking signature rejected",
          statusCode: 400,
        }),
        { turnId: "turn-retry-1", timestampMs: scheduledAt },
      ),
    );

    expect(projection.getSnapshot().control.apiRetry).toEqual({
      attempt: 1,
      maxAttempts: 2,
      nextRetryAt: scheduledAt,
      reasonCode: "fault.provider.requestFailed",
    });
  });

  it("忽略非当前 turn 的迟到重试与完成事件", () => {
    const { log, projection } = runningProjection();
    const retryPayload = modelStatus({
      type: "model_retry_scheduled",
      delayMs: 1_000,
      nextAttempt: 2,
      reason: "rate_limited",
      message: "rate limited",
      statusCode: 429,
    });

    projection.applyEvent(
      log.push(SessionEventType.ModelNetworkStatus, retryPayload, { turnId: "turn-stale" }),
    );
    expect(projection.getSnapshot().control.apiRetry).toBeNull();

    projection.applyEvent(
      log.push(SessionEventType.ModelNetworkStatus, retryPayload, { turnId: "turn-retry-1" }),
    );
    expect(projection.getSnapshot().control.apiRetry).not.toBeNull();

    projection.applyEvent(
      log.push(
        SessionEventType.ModelNetworkStatus,
        modelStatus({ type: "model_request_completed", durationMs: 50 }),
        { turnId: "turn-stale" },
      ),
    );
    expect(projection.getSnapshot().control.apiRetry).not.toBeNull();
  });

  it("请求完成、不可重试失败和 turn 终态都会清理重试状态", () => {
    const { log, projection } = runningProjection();
    const scheduleRetry = (attempt: number) =>
      projection.applyEvent(
        log.push(
          SessionEventType.ModelNetworkStatus,
          modelStatus({
            type: "model_retry_scheduled",
            attempt,
            delayMs: 1_000,
            nextAttempt: attempt + 1,
            reason: "server_error",
            message: "server error",
            statusCode: 503,
          }),
          { turnId: "turn-retry-1" },
        ),
      );

    scheduleRetry(1);
    projection.applyEvent(
      log.push(
        SessionEventType.ModelNetworkStatus,
        modelStatus({
          type: "model_request_failed",
          reason: "server_error",
          retryable: true,
          message: "retryable",
          statusCode: 503,
        }),
        { turnId: "turn-retry-1" },
      ),
    );
    expect(projection.getSnapshot().control.apiRetry).not.toBeNull();

    projection.applyEvent(
      log.push(
        SessionEventType.ModelNetworkStatus,
        modelStatus({ type: "model_request_completed", attempt: 2, durationMs: 50 }),
        { turnId: "turn-retry-1" },
      ),
    );
    expect(projection.getSnapshot().control.apiRetry).toBeNull();

    scheduleRetry(2);
    projection.applyEvent(
      log.push(
        SessionEventType.ModelNetworkStatus,
        modelStatus({
          type: "model_request_failed",
          attempt: 3,
          reason: "server_error",
          retryable: false,
          message: "exhausted",
          statusCode: 503,
        }),
        { turnId: "turn-retry-1" },
      ),
    );
    expect(projection.getSnapshot().control.apiRetry).toBeNull();

    scheduleRetry(3);
    projection.applyEvent(
      log.push(
        SessionEventType.TurnComplete,
        {
          response: "done",
          tokenCount: 1,
          toolCallCount: 0,
          duration: 100,
          resultType: "success",
        },
        { turnId: "turn-retry-1" },
      ),
    );
    expect(projection.getSnapshot().control.apiRetry).toBeNull();
  });

  it("core SSE 恢复次数进入同一 apiRetry，并在工具进展后清理", () => {
    const { log, projection } = runningProjection();
    const recoveryStartedAt = 1_721_000_100_000;
    projection.applyEvent(
      log.push(
        SessionEventType.StreamRecoveryStarted,
        {
          attemptId: "stream-attempt-1",
          assistantMessageId: "assistant-retry-1",
          failedRequestId: "request-retry-1",
          failureKind: "provider_stream_error",
          message: "stream disconnected",
          retryNumber: 3,
          maxRetries: 10,
        },
        { turnId: "turn-retry-1", timestampMs: recoveryStartedAt },
      ),
    );
    expect(projection.getSnapshot().control.apiRetry).toEqual({
      attempt: 3,
      maxAttempts: 11,
      nextRetryAt: recoveryStartedAt,
      reasonCode: "fault.network.sseDisconnected",
    });

    projection.applyEvent(
      log.push(
        SessionEventType.StreamRecoveryRetryStarted,
        {
          attemptId: "stream-attempt-1",
          anchorId: "anchor-1",
          failedRequestId: "request-retry-1",
          retryNumber: 3,
          maxRetries: 10,
          streamMode: "sse",
        },
        { turnId: "turn-retry-1" },
      ),
    );
    projection.applyEvent(
      log.push(
        SessionEventType.ModelNetworkStatus,
        modelStatus({
          type: "model_request_started",
          streamRecovery: {
            attemptId: "stream-attempt-1",
            anchorId: "anchor-1",
            recoveredFromRequestId: "request-retry-1",
            retryNumber: 3,
            maxRetries: 10,
          },
        }),
        { turnId: "turn-retry-1" },
      ),
    );
    expect(projection.getSnapshot().control.apiRetry).toMatchObject({
      attempt: 3,
      maxAttempts: 11,
      reasonCode: "fault.network.sseDisconnected",
    });

    projection.applyEvent(
      log.push(
        SessionEventType.ModelStreaming,
        {
          kind: "tool_input_start",
          delta: "",
          done: false,
          toolCallId: "tool-retry-1",
          toolName: "Read",
        },
        { turnId: "turn-retry-1" },
      ),
    );
    expect(projection.getSnapshot().control.apiRetry).toBeNull();
  });

  it("reasoning-only recovery 将旧思考行收口为 interrupted，再用新行承接恢复流", () => {
    const { log, projection } = runningProjection();
    projection.applyEvent(
      log.push(
        SessionEventType.ModelStreaming,
        { kind: "reasoning_start", delta: "", done: false },
        { turnId: "turn-retry-1" },
      ),
    );
    projection.applyEvent(
      log.push(
        SessionEventType.ModelStreaming,
        { kind: "reasoning_delta", delta: "unfinished", done: false },
        { turnId: "turn-retry-1" },
      ),
    );

    projection.applyEvent(
      log.push(
        SessionEventType.StreamRecoveryTailDiscarded,
        {
          attemptId: "stream-attempt-1",
          anchorId: "anchor-1",
          assistantMessageId: "assistant-retry-1",
          discardedReasoningBytes: 10,
          discardedTextBytes: 0,
          discardedToolCallIds: [],
        },
        { turnId: "turn-retry-1" },
      ),
    );
    expect(projection.getSnapshot().rows.window.filter((row) => row.kind === "reasoning")).toEqual([
      expect.objectContaining({ state: "interrupted", text: "unfinished" }),
    ]);

    projection.applyEvent(
      log.push(
        SessionEventType.ModelStreaming,
        { kind: "reasoning_delta", delta: "fresh", done: false },
        { turnId: "turn-retry-1" },
      ),
    );
    expect(
      projection
        .getSnapshot()
        .rows.window.filter((row) => row.kind === "reasoning")
        .map((row) => ({ state: row.state, text: row.text })),
    ).toEqual([
      { state: "interrupted", text: "unfinished" },
      { state: "streaming", text: "fresh" },
    ]);
  });

  it("tail_discarded 收口未定稿的流式 tool row，已提交的 running 行不动，恢复流用新 id 重开", () => {
    const { log, projection } = runningProjection();
    const turnId = "turn-retry-1";
    // 已提交并在执行中的工具：它的终态由 executor 发布，recovery 不能替它收口。
    projection.applyEvent(
      log.push(
        SessionEventType.ToolCallScheduled,
        {
          toolCallId: "tool-committed",
          assistantMessageId: "assistant-retry-1",
          toolName: "Read",
          input: { file_path: "a.ts" },
          schedule: { parallelGroups: [["tool-committed"]], executionOrder: ["tool-committed"] },
        },
        { turnId },
      ),
    );
    projection.applyEvent(
      log.push(
        SessionEventType.ToolCallStarted,
        { toolCallId: "tool-committed", toolName: "Read", startedAt: new Date() },
        { turnId },
      ),
    );
    // 断流时只写到一半的 CreateWorkflow：tool_input_start 已开行，tool_call 永远不会来。
    projection.applyEvent(
      log.push(
        SessionEventType.ModelStreaming,
        {
          kind: "tool_input_start",
          delta: "",
          done: false,
          toolCallId: "tool-orphan",
          toolName: "CreateWorkflow",
        },
        { turnId },
      ),
    );
    projection.applyEvent(
      log.push(
        SessionEventType.ModelStreaming,
        {
          kind: "tool_input_delta",
          delta: '{"script":"const a = agent(',
          done: false,
          toolCallId: "tool-orphan",
        },
        { turnId },
      ),
    );

    projection.applyEvent(
      log.push(
        SessionEventType.StreamRecoveryTailDiscarded,
        {
          attemptId: "stream-attempt-1",
          anchorId: "anchor-1",
          assistantMessageId: "assistant-retry-1",
          discardedReasoningBytes: 0,
          discardedTextBytes: 12,
          discardedToolCallIds: [],
        },
        { turnId },
      ),
    );
    const toolRows = () =>
      projection
        .getSnapshot()
        .rows.window.filter((row) => row.kind === "toolCall")
        .map((row) => ({
          toolCallId: row.toolCallId,
          status: row.status,
          inputText: row.inputText,
        }));
    expect(toolRows()).toEqual([
      { toolCallId: "tool-committed", status: "running", inputText: '{"file_path":"a.ts"}' },
      { toolCallId: "tool-orphan", status: "cancelled", inputText: '{"script":"const a = agent(' },
    ]);

    // 恢复请求重新写脚本：新 id 开新行，旧行保持已收口，不会并排两张「正在编写工作流」。
    projection.applyEvent(
      log.push(
        SessionEventType.ModelStreaming,
        {
          kind: "tool_input_start",
          delta: "",
          done: false,
          toolCallId: "tool-retry",
          toolName: "CreateWorkflow",
        },
        { turnId },
      ),
    );
    expect(toolRows().map((row) => [row.toolCallId, row.status])).toEqual([
      ["tool-committed", "running"],
      ["tool-orphan", "cancelled"],
      ["tool-retry", "inputStreaming"],
    ]);
  });
});

// ── 结构性黄金测试（13-golden-test-mapping §v4 新增）──

describe("结构性不变量", () => {
  function fullDeltaStream(events: readonly SessionEvent[]): {
    deltasPerEvent: ConversationDelta[][];
    snapshots: ConversationSnapshot[];
  } {
    const { deltasPerEvent, snapshots } = runAll(events);
    return { deltasPerEvent, snapshots };
  }

  it("结构性1：任意水位 W 取 snapshot + 续流 ≡ 全量重放（R-03）", () => {
    const log = new EventLog();
    basicTurnEvents(log);
    const { deltasPerEvent, snapshots } = fullDeltaStream(log.events);
    const final = snapshots[snapshots.length - 1]!;

    for (let w = 0; w < log.events.length; w++) {
      const snapshotAtW = snapshots[w + 1]!;
      const tail = deltasPerEvent.slice(w + 1).flat();
      const resumed = applyConversationDeltas(snapshotAtW, tail);
      // seq 由帧区间记账推进（不在 delta 内），对比时对齐到终值。
      expect({ ...resumed, seq: final.seq }).toEqual(final);
    }
  });

  it("结构性4（半）：coalesce 后的 delta 流与逐条投递终态逐字节一致", () => {
    const log = new EventLog();
    basicTurnEvents(log);
    const { deltasPerEvent, snapshots } = fullDeltaStream(log.events);
    const base = snapshots[0]!;
    const all = deltasPerEvent.flat();
    const direct = applyConversationDeltas(base, all);
    const coalesced = applyConversationDeltas(base, coalesceConversationDeltas(all));
    expect(coalesced).toEqual(direct);
  });

  it("结构性10：fault 注入 session A，session B 投影逐字节不变（X 组）", () => {
    const logA = new EventLog("session-a");
    logA.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    logA.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "hi" }, { turnId: "turn-a" });

    const logB = new EventLog("session-b");
    basicTurnEvents(logB, "turn-b");

    const projectionA = new ProductProjection("session-a", "epoch-1");
    const projectionB = new ProductProjection("session-b", "epoch-1");
    for (const event of logB.events) projectionB.applyEvent(event);
    const snapshotB = structuredClone(projectionB.getSnapshot());

    for (const event of logA.events) projectionA.applyEvent(event);
    const fault = new EventLog("session-a");
    fault.push(
      SessionEventType.TurnError,
      { error: { type: "fault.network.unreachable", message: "ECONNREFUSED" }, turnPhase: "model" },
      { turnId: "turn-a" },
    );
    for (const event of fault.events) projectionA.applyEvent(event);

    expect(projectionA.getSnapshot().control.phase).toBe("error");
    expect(projectionB.getSnapshot()).toEqual(snapshotB);
  });

  it("revision 递进：结构性事件 +1 且随帧携带；纯 row.delta 不递增（R-04）", () => {
    const log = new EventLog();
    basicTurnEvents(log);
    const { deltasPerEvent, snapshots } = fullDeltaStream(log.events);

    deltasPerEvent.forEach((deltas, index) => {
      const structural = deltas.some(
        (delta) =>
          delta.op === "row.appended" ||
          delta.op === "row.upserted" ||
          delta.op === "row.removed" ||
          (delta.op === "state.updated" &&
            Object.keys(delta.patch).some((key) => key !== "revision" && key !== "usage")),
      );
      const prev = snapshots[index]!.revision;
      const next = snapshots[index + 1]!.revision;
      if (structural) {
        expect(next).toBe(prev + 1);
        // 携带规则：含 revision 递增事件的帧，deltas 必含 state.updated.revision。
        const carried = deltas.some(
          (delta) => delta.op === "state.updated" && delta.patch.revision === next,
        );
        expect(carried).toBe(true);
      } else {
        expect(next).toBe(prev);
      }
    });

    // 纯文本流事件（text_delta）revision 不动。
    const textDeltaIndex = log.events.findIndex(
      (event) =>
        event.type === SessionEventType.ModelStreaming &&
        (event.payload as { kind?: string }).kind === "text_delta",
    );
    expect(snapshots[textDeltaIndex + 1]!.revision).toBe(snapshots[textDeltaIndex]!.revision);
  });

  it("确定性：同一事件日志重放两次，投影与 delta 流逐字节一致（rowId 纯函数，R-04）", () => {
    const log = new EventLog();
    basicTurnEvents(log);
    const first = runAll(log.events);
    const second = runAll(log.events);
    expect(second.projection.getSnapshot()).toEqual(first.projection.getSnapshot());
    expect(second.deltasPerEvent).toEqual(first.deltasPerEvent);
  });
});

// ── 结构性4：两 profile 终态逐字节一致（05 §delivery-profile 收敛性黄金测试）──
// 同一事件序列跑 continuous / replayable 两档 flush 管线（filter → coalesce → apply），
// 断言终态与逐条直投逐字节一致。replayable 只是中间帧少，终态必须相同——
// 这同时机械验证收口不变量：被 profile 过滤的 row.delta（inputText/output.text/
// summaryText）必须被后续不可过滤的 row.upserted 蕴含。

describe("结构性4：两 profile 终态一致", () => {
  function pipelineFinalState(
    events: readonly SessionEvent[],
    profile: DeliveryProfile,
  ): ConversationSnapshot {
    const { deltasPerEvent, snapshots } = runAll(events);
    const base = snapshots[0]!;
    const piped = coalesceConversationDeltas(
      filterConversationDeltasForProfile(deltasPerEvent.flat(), profile),
    );
    return applyConversationDeltas(base, piped);
  }

  function assertProfileConvergence(events: readonly SessionEvent[]): void {
    const { deltasPerEvent, snapshots } = runAll(events);
    const direct = applyConversationDeltas(snapshots[0]!, deltasPerEvent.flat());
    expect(pipelineFinalState(events, DELIVERY_PROFILES.continuous)).toEqual(direct);
    expect(pipelineFinalState(events, DELIVERY_PROFILES.replayable)).toEqual(direct);
  }

  it("基础 turn（文本流式）", () => {
    const log = new EventLog();
    basicTurnEvents(log);
    assertProfileConvergence(log.events);
  });

  it("tool 输入流式 → 权限 → 执行成功（inputText 被 upsert 收口）", () => {
    const turnId = "turn-1";
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "run ls" }, { turnId });
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "tool_input_start", delta: "", done: false, toolCallId: "tc-1", toolName: "bash" },
      { turnId },
    );
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "tool_input_delta", delta: '{"command":', done: false, toolCallId: "tc-1" },
      { turnId },
    );
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "tool_input_delta", delta: '"ls"}', done: false, toolCallId: "tc-1" },
      { turnId },
    );
    log.push(
      SessionEventType.ToolCallScheduled,
      {
        toolCallId: "tc-1",
        toolName: "bash",
        input: { command: "ls" },
        schedule: { parallelGroups: [["tc-1"]], executionOrder: ["tc-1"] },
      },
      { turnId },
    );
    log.push(
      SessionEventType.PermissionRequested,
      {
        requestId: "req-1",
        toolCallId: "tc-1",
        toolName: "bash",
        riskLevel: "medium",
        reason: "Run",
        input: { command: "ls" },
      },
      { turnId },
    );
    log.push(
      SessionEventType.PermissionResolved,
      { requestId: "req-1", toolCallId: "tc-1", decision: "allow" },
      { turnId },
    );
    log.push(
      SessionEventType.ToolCallStarted,
      { toolCallId: "tc-1", toolName: "bash", startedAt: new Date() },
      { turnId },
    );
    log.push(
      SessionEventType.ToolCallResult,
      { toolCallId: "tc-1", result: { success: true, content: "file-a" }, duration: 42 },
      { turnId },
    );
    log.push(
      SessionEventType.TurnComplete,
      { response: "done", tokenCount: 1, toolCallCount: 1, duration: 100, resultType: "success" },
      { turnId },
    );
    assertProfileConvergence(log.events);
  });

  it("BG13：foreground subagent child tool 只留在 child conversation，main 仍由父 Agent 保持 running", () => {
    const turnId = "turn-foreground-agent";
    const parentToolCallId = "call_parent_agent";
    const childToolCallId = "tool_subagent_agent-1_call_child_todo";
    const mirrored = {
      agentId: "agent-1",
      agentType: "general-purpose",
      childSessionId: "session-child-1",
      childToolCallId: "call_child_todo",
      description: "Inspect the project",
      parentToolCallId,
      source: "subagent",
    };
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: "inspect with a foreground agent" },
      { turnId },
    );
    log.push(
      SessionEventType.ToolCallScheduled,
      {
        toolCallId: parentToolCallId,
        toolName: "Agent",
        input: { description: "Inspect the project", prompt: "Inspect the project" },
        schedule: {
          parallelGroups: [[parentToolCallId]],
          executionOrder: [parentToolCallId],
        },
      },
      { turnId },
    );
    log.push(
      SessionEventType.ToolCallStarted,
      { toolCallId: parentToolCallId, toolName: "Agent", startedAt: new Date() },
      { turnId },
    );
    log.push(
      SessionEventType.SubagentSpawned,
      {
        agentId: "agent-1",
        agentType: "general-purpose",
        childSessionId: "session-child-1",
        description: "Inspect the project",
        parentToolCallId,
        status: "running",
      },
      { turnId },
    );
    log.push(
      SessionEventType.ToolCallScheduled,
      {
        ...mirrored,
        toolCallId: childToolCallId,
        toolName: "TodoWrite",
        input: { todos: [{ id: "child-only", content: "Read files", status: "in_progress" }] },
        schedule: {
          parallelGroups: [[childToolCallId]],
          executionOrder: [childToolCallId],
        },
      },
      { turnId },
    );
    log.push(
      SessionEventType.ToolCallStarted,
      { ...mirrored, toolCallId: childToolCallId, toolName: "TodoWrite", startedAt: new Date() },
      { turnId },
    );
    log.push(
      SessionEventType.ToolCallResult,
      {
        ...mirrored,
        toolCallId: childToolCallId,
        result: { success: true, content: "child todo updated" },
        duration: 10,
      },
      { turnId },
    );

    assertProfileConvergence(log.events);
    const snapshot = runAll(log.events).projection.getSnapshot();
    expect(snapshot.control.phase).toBe("running");
    expect(snapshot.plan).toBeNull();
    expect(
      snapshot.rows.window.filter((row) => row.kind === "toolCall").map((row) => row.toolCallId),
    ).toEqual([parentToolCallId]);
    expect(snapshot.rows.window).toContainEqual(
      expect.objectContaining({
        kind: "subagent",
        childSessionId: "session-child-1",
        parentToolCallId,
        status: "running",
      }),
    );

    const childLog = new EventLog();
    childLog.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    childLog.push(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: "Inspect the project" },
      { turnId: "turn-child-1" },
    );
    childLog.push(
      SessionEventType.ToolCallScheduled,
      {
        toolCallId: "call_child_todo",
        toolName: "TodoWrite",
        input: { todos: [{ id: "child-only", content: "Read files", status: "in_progress" }] },
        schedule: {
          parallelGroups: [["call_child_todo"]],
          executionOrder: ["call_child_todo"],
        },
      },
      { turnId: "turn-child-1" },
    );
    childLog.push(
      SessionEventType.ToolCallStarted,
      { toolCallId: "call_child_todo", toolName: "TodoWrite", startedAt: new Date() },
      { turnId: "turn-child-1" },
    );
    childLog.push(
      SessionEventType.ToolCallResult,
      {
        toolCallId: "call_child_todo",
        result: { success: true, content: "child todo updated" },
        duration: 10,
      },
      { turnId: "turn-child-1" },
    );
    assertProfileConvergence(childLog.events);
    expect(runAll(childLog.events).projection.getSnapshot().rows.window).toContainEqual(
      expect.objectContaining({
        kind: "toolCall",
        toolCallId: "call_child_todo",
        status: "success",
      }),
    );
  });

  it("BG26：真实失败 lifecycle 归并 hydration 合成行并补齐 child session 身份", () => {
    const turnId = "turn-background-agent-rate-limit";
    const parentToolCallId = "call-background-agent-rate-limit";
    const realAgentId = "agent-background-rate-limit";
    const childSessionId = "session-child-rate-limit";
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: "launch background agent" },
      { turnId },
    );
    log.push(
      SessionEventType.ToolCallScheduled,
      {
        toolCallId: parentToolCallId,
        toolName: "Agent",
        input: {
          description: "Trigger provider rate limit",
          prompt: "Trigger provider rate limit",
          run_in_background: true,
        },
        schedule: {
          parallelGroups: [[parentToolCallId]],
          executionOrder: [parentToolCallId],
        },
      },
      { turnId },
    );
    log.push(
      SessionEventType.ToolCallStarted,
      { toolCallId: parentToolCallId, toolName: "Agent", startedAt: new Date() },
      { turnId },
    );
    // transcript hydration 只能从文本 tool output 合成出 toolCallId 身份，拿不到 childSessionId。
    log.push(
      SessionEventType.SubagentSpawned,
      {
        agentId: parentToolCallId,
        agentType: "general-purpose",
        description: "Trigger provider rate limit",
        parentToolCallId,
        status: "running",
      },
      { turnId },
    );
    // hydration await 窗口内补回的真实 spawned 也必须复用合成行，并建立真实 agentId 映射。
    log.push(
      SessionEventType.SubagentSpawned,
      {
        agentId: realAgentId,
        agentType: "general-purpose",
        background: true,
        childSessionId,
        description: "Trigger provider rate limit",
        parentToolCallId,
        status: "running",
      },
      { turnId },
    );
    // live terminal 事件携带真实 runtime 身份，必须更新上一行而不是追加重复 SubagentRow。
    log.push(
      SessionEventType.SubagentStopped,
      {
        agentId: realAgentId,
        agentType: "general-purpose",
        background: true,
        parentToolCallId,
        status: "failed",
        error: "PROVIDER_ERROR: 429 rate limited",
      },
      { turnId },
    );

    const snapshot = runAll(log.events).projection.getSnapshot();
    const subagentRows = snapshot.rows.window.filter(
      (row): row is Extract<(typeof snapshot.rows.window)[number], { kind: "subagent" }> =>
        row.kind === "subagent",
    );
    expect(subagentRows).toHaveLength(1);
    expect(subagentRows[0]).toMatchObject({
      childSessionId,
      parentToolCallId,
      status: "failed",
      summaryText: "PROVIDER_ERROR: 429 rate limited",
    });
  });

  it("BG35：background subagent child tool 不生成父 row，迟到终态也不复活", () => {
    const turnId = "turn-background-agent";
    const parentToolCallId = "call_parent_agent";
    const childToolCallId = "tool_subagent_agent-1_call_child_bash";
    const mirrored = {
      agentId: "agent-1",
      agentType: "general-purpose",
      background: true,
      childSessionId: "session-child-1",
      childToolCallId: "call_child_bash",
      description: "Run delayed Bash",
      parentToolCallId,
      source: "subagent",
    };
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: "launch background agent" },
      { turnId },
    );
    log.push(
      SessionEventType.ToolCallScheduled,
      {
        toolCallId: parentToolCallId,
        toolName: "Agent",
        input: {
          description: "Run delayed Bash",
          prompt: "Run delayed Bash",
          run_in_background: true,
        },
        schedule: {
          parallelGroups: [[parentToolCallId]],
          executionOrder: [parentToolCallId],
        },
      },
      { turnId },
    );
    log.push(
      SessionEventType.ToolCallStarted,
      { toolCallId: parentToolCallId, toolName: "Agent", startedAt: new Date() },
      { turnId },
    );
    log.push(
      SessionEventType.ToolCallResult,
      {
        toolCallId: parentToolCallId,
        result: { success: true, content: "background agent launched" },
        duration: 5,
      },
      { turnId },
    );
    log.push(
      SessionEventType.ToolCallScheduled,
      {
        ...mirrored,
        toolCallId: childToolCallId,
        toolName: "Bash",
        input: { command: "sleep 60 && date" },
        schedule: {
          parallelGroups: [[childToolCallId]],
          executionOrder: [childToolCallId],
        },
      },
      { turnId },
    );
    log.push(
      SessionEventType.ToolCallStarted,
      { ...mirrored, toolCallId: childToolCallId, toolName: "Bash", startedAt: new Date() },
      { turnId },
    );
    log.push(
      SessionEventType.TurnComplete,
      {
        response: "launched",
        tokenCount: 1,
        toolCallCount: 1,
        duration: 10,
        resultType: "success",
      },
      { turnId },
    );

    const beforeChildTerminal = runAll(log.events).projection.getSnapshot();
    expect(beforeChildTerminal.control.phase).toBe("completedSuccess");
    expect(
      beforeChildTerminal.rows.window
        .filter((row) => row.kind === "toolCall")
        .map((row) => row.toolCallId),
    ).toEqual([parentToolCallId]);

    log.push(
      SessionEventType.ToolCallResult,
      {
        ...mirrored,
        toolCallId: childToolCallId,
        result: { success: true, content: "Fri Jul 17 12:40:36 CST 2026" },
        duration: 60_000,
      },
      { turnId },
    );
    log.push(
      SessionEventType.ToolCallError,
      {
        ...mirrored,
        toolCallId: "tool_subagent_agent-1_call_child_error",
        error: { type: "fault.runtime.toolFailed", message: "late child failure" },
      },
      { turnId },
    );
    assertProfileConvergence(log.events);

    const terminalSnapshot = runAll(log.events).projection.getSnapshot();
    expect(terminalSnapshot.control.phase).toBe("completedSuccess");
    expect(
      terminalSnapshot.rows.window
        .filter((row) => row.kind === "toolCall")
        .map((row) => row.toolCallId),
    ).toEqual([parentToolCallId]);
  });

  it("BG18：父轮结束后的 child tool 事件不应清掉原 background Agent 控制身份", () => {
    const parentTurnId = "turn-background-parent-anchor";
    const followUpTurnId = "turn-background-parent-anchor-follow-up";
    const parentToolCallId = "toolu_e2e_background_parent_anchor_agent";
    const agentId = "agent-parent-anchor";
    const childSessionId = "session-child-parent-anchor";
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: "launch background agent" },
      { turnId: parentTurnId },
    );
    log.push(
      SessionEventType.SubagentSpawned,
      {
        agentId,
        agentType: "general-purpose",
        background: true,
        childSessionId,
        description: "E2E background child tool parent anchor",
        parentToolCallId,
        status: "running",
      },
      { turnId: parentTurnId },
    );
    log.push(SessionEventType.TurnComplete, {}, { turnId: parentTurnId });
    log.push(
      SessionEventType.TurnStarted,
      { turnNumber: 2, input: "finish a main follow-up first" },
      { turnId: followUpTurnId },
    );
    log.push(SessionEventType.TurnComplete, {}, { turnId: followUpTurnId });
    log.push(
      SessionEventType.ToolCallStarted,
      {
        agentId,
        childSessionId,
        parentToolCallId,
        source: "subagent",
        toolCallId: "toolu_e2e_background_parent_anchor_child_bash",
        toolName: "Bash",
      },
      { turnId: parentTurnId },
    );

    const snapshot = runAll(log.events).projection.getSnapshot();
    expect(snapshot.subagents.running).toEqual([
      expect.objectContaining({
        agentId,
        childSessionId,
        title: "E2E background child tool parent anchor",
      }),
    ]);
  });

  it("tool 输入流到一半被 stop（cancelled 收口，inputStreaming 不悬挂）", () => {
    const turnId = "turn-1";
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "hi" }, { turnId });
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "tool_input_start", delta: "", done: false, toolCallId: "tc-1", toolName: "bash" },
      { turnId },
    );
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "tool_input_delta", delta: '{"command":"rm', done: false, toolCallId: "tc-1" },
      { turnId },
    );
    log.push(
      SessionEventType.TurnComplete,
      { response: "", tokenCount: 0, toolCallCount: 0, duration: 50, resultType: "cancelled" },
      { turnId },
    );
    assertProfileConvergence(log.events);

    // 收口语义本体：中断后 tool row 必须离开 inputStreaming（cancelled + 完整 inputText）。
    const { projection } = runAll(log.events);
    expect(
      projection.getSnapshot().rows.window.find((row) => row.kind === "toolCall"),
    ).toMatchObject({ status: "cancelled", inputText: '{"command":"rm' });
  });

  it("success turn 兜底收口缺少 terminal event 的 foreground tool", () => {
    const turnId = "turn-1";
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "search" }, { turnId });
    log.push(
      SessionEventType.ModelStreaming,
      {
        kind: "tool_input_start",
        delta: "",
        done: false,
        toolCallId: "tc-missing",
        toolName: "GrepMissingFromRegistry",
      },
      { turnId },
    );
    log.push(
      SessionEventType.ModelStreaming,
      {
        kind: "tool_input_delta",
        delta: '{"pattern":"needle"}',
        done: false,
        toolCallId: "tc-missing",
      },
      { turnId },
    );
    log.push(
      SessionEventType.PermissionRequested,
      {
        requestId: "req-missing",
        toolCallId: "tc-missing",
        toolName: "GrepMissingFromRegistry",
        riskLevel: "low",
        reason: "Search",
        input: { pattern: "needle" },
      },
      { turnId },
    );
    log.push(
      SessionEventType.TurnComplete,
      { response: "done", tokenCount: 1, toolCallCount: 1, duration: 50, resultType: "success" },
      { turnId },
    );
    assertProfileConvergence(log.events);

    const { projection } = runAll(log.events);
    expect(
      projection.getSnapshot().rows.window.find((row) => row.kind === "toolCall"),
    ).toMatchObject({
      status: "error",
      inputText: '{"pattern":"needle"}',
      error: { code: "fault.runtime.toolLifecycleIncomplete" },
    });
    expect(projection.getSnapshot().pendingInteractions).toEqual([]);
  });

  it("reasoning 流式 + 中断", () => {
    const turnId = "turn-1";
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "think" }, { turnId });
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "reasoning_start", delta: "", done: false },
      { turnId },
    );
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "reasoning_delta", delta: "hmm...", done: false },
      { turnId },
    );
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_start", delta: "", done: false },
      { turnId },
    );
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_delta", delta: "part", done: false },
      { turnId },
    );
    log.push(
      SessionEventType.TurnComplete,
      { response: "", tokenCount: 0, toolCallCount: 0, duration: 10, resultType: "cancelled" },
      { turnId },
    );
    assertProfileConvergence(log.events);
  });

  it("compact 生命周期（marker + usage 回落）", () => {
    const log = new EventLog();
    basicTurnEvents(log);
    log.push(SessionEventType.CompactStarted, {
      operationId: "op-1",
      messageId: "msg-1",
      status: "started",
      trigger: "manual",
      display: "separator",
      sourceCommandId: "command-compact",
    });
    log.push(SessionEventType.CompactCompleted, {
      operationId: "op-1",
      messageId: "msg-1",
      status: "completed",
      trigger: "manual",
      display: "separator",
      preCompactTokenCount: 150,
      postCompactTokenCount: 50,
    });
    assertProfileConvergence(log.events);
  });

  it("goal set → verify pass → fork → modelChange 全链路", () => {
    const log = new EventLog();
    basicTurnEvents(log);
    log.push(SessionEventType.TargetChanged, {
      action: "set",
      source: "command",
      target: {
        sessionID: "session-1",
        targetID: "target-1",
        objective: "修绿",
        summaryTitle: null,
        status: "active",
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        time: { created: 0, updated: 0 },
      },
      previousTarget: null,
    });
    log.push(SessionEventType.TargetCompletionVerification, {
      targetId: "target-1",
      status: "started",
      verificationId: "verify-1",
      goalIteration: 1,
    });
    log.push(SessionEventType.TargetCompletionVerification, {
      targetId: "target-1",
      status: "completed",
      verificationId: "verify-1",
      goalIteration: 1,
      verification: { passed: true, reason: "ok" },
    });
    log.push(SessionEventType.SessionForked, {
      originalSessionId: "session-1",
      forkedSessionId: "session-child",
    });
    log.push(SessionEventType.ModelSelected, {
      modelSelection: { providerId: "anthropic", modelId: "claude-4" },
    });
    log.push(SessionEventType.ModelSelected, {
      modelSelection: { providerId: "openai", modelId: "gpt-6" },
    });
    assertProfileConvergence(log.events);
  });
});

// ── G 组：compact marker ──

describe("compact marker（10 §4.4.7 / §6.4）", () => {
  it("G：manual compact running→success —— 同一 marker row 状态迁移 + usage 回落", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    log.push(SessionEventType.CompactStarted, {
      operationId: "op-1",
      messageId: "msg-marker",
      status: "started",
      trigger: "manual",
      display: "separator",
      sourceCommandId: "command-compact",
    });
    const { projection, deltasPerEvent } = runAll(log.events);
    const runningMarker = projection
      .getSnapshot()
      .rows.window.find((row) => row.kind === "timelineMarker");
    expect(runningMarker).toMatchObject({
      sourceCommandId: "command-compact",
      marker: { type: "compact", origin: "manual", status: "running" },
    });
    expect(deltasPerEvent[1]![0]!.op).toBe("row.appended");

    projection.applyEvent(
      new EventLog().push(SessionEventType.CompactCompleted, {
        operationId: "op-1",
        messageId: "msg-marker",
        status: "completed",
        trigger: "manual",
        display: "separator",
        sourceCommandId: "command-compact",
        preCompactTokenCount: 100_000,
        postCompactTokenCount: 30_000,
        truePostCompactTokenCount: 20_000,
        summaryMessageId: "msg-summary",
      }),
    );
    const snapshot = projection.getSnapshot();
    expect(() => conversationSnapshotSchema.parse(snapshot)).not.toThrow();
    const markers = snapshot.rows.window.filter((row) => row.kind === "timelineMarker");
    // 全生命周期占同一行：终态是 upsert 不是新行。
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      rowId: runningMarker?.rowId,
      sourceCommandId: "command-compact",
      marker: {
        type: "compact",
        origin: "manual",
        status: "success",
        tokensBefore: 100_000,
        tokensAfter: 20_000,
        summaryRef: "msg-summary",
      },
    });
    // compact 成功 → context 水位立即回落（§6.4）。
    expect(snapshot.usage.contextWindow?.usedTokens).toBe(20_000);
  });

  it("G12：auto compact 被 stop —— marker=cancelled，usage 不动", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(SessionEventType.CompactStarted, {
      operationId: "op-1",
      messageId: "msg-1",
      status: "started",
      trigger: "auto",
      display: "separator",
    });
    log.push(SessionEventType.CompactFailed, {
      operationId: "op-1",
      messageId: "msg-1",
      status: "interrupted",
      trigger: "auto",
      display: "separator",
    });
    const { projection } = runAll(log.events);
    const snapshot = projection.getSnapshot();
    expect(snapshot.rows.window.find((row) => row.kind === "timelineMarker")).toMatchObject({
      marker: { type: "compact", origin: "auto", status: "cancelled" },
    });
    expect(snapshot.usage.contextWindow).toBeNull();
  });

  it("F09：compact 失败 —— marker=failed（retry 入口），会话状态不受污染", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(SessionEventType.CompactStarted, {
      operationId: "op-1",
      messageId: "msg-1",
      status: "started",
      trigger: "manual",
      display: "separator",
    });
    log.push(SessionEventType.CompactFailed, {
      operationId: "op-1",
      messageId: "msg-1",
      status: "failed",
      trigger: "manual",
      display: "separator",
      reason: "api_error",
    });
    const { projection } = runAll(log.events);
    const snapshot = projection.getSnapshot();
    expect(snapshot.rows.window.find((row) => row.kind === "timelineMarker")).toMatchObject({
      marker: { type: "compact", status: "failed" },
    });
    expect(snapshot.control.lastError).toBeNull();
  });
});

// ── goal 状态机（10 §4.2.8）──

describe("goal 状态机", () => {
  const goalTarget = (status: string, objective = "把测试全修绿") => ({
    sessionID: "session-1",
    targetID: "target-1",
    objective,
    summaryTitle: null,
    status,
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    time: { created: 0, updated: 0 },
  });

  it("goal set → stateOnly（不产 row）+ GoalState.active；verify pass → verified + 摘要锚点", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(SessionEventType.TargetChanged, {
      action: "set",
      source: "command",
      target: goalTarget("active"),
      previousTarget: null,
    });
    log.push(SessionEventType.TargetCompletionVerification, {
      targetId: "target-1",
      status: "started",
      verificationId: "verify-1",
      foregroundExecutionId: "foreground-1",
      goalIteration: 1,
    });
    const { projection } = runAll(log.events);
    const verifying = projection.getSnapshot();
    expect(verifying.goal).toMatchObject({
      objective: "把测试全修绿",
      status: "verifying",
      iteration: 1,
    });
    expect(verifying.control).toMatchObject({
      phase: "running",
      canStop: true,
      stopState: "stoppable",
      stopTargetKind: "goalVerifier",
      sessionEnded: false,
    });
    expect(verifying.control.activeWorks).toEqual([
      expect.objectContaining({
        kind: "goalVerifier",
        foregroundExecutionId: "foreground-1",
      }),
    ]);
    expect(verifying.inputRouting).toEqual({
      mode: "enqueue",
      reasonCode: "goalVerifierAcceptsFutureInput",
    });
    const verifyMarker = verifying.rows.window.find(
      (row) => row.kind === "timelineMarker" && row.marker.type === "goalVerify",
    );
    expect(verifyMarker).toMatchObject({
      marker: { type: "goalVerify", iteration: 1, outcome: "running" },
    });
    // S10（16-plan，2026-07-08 裁决）：goalSet 是 stateOnly——不进 rows.window
    //（旧实现产「渲染 null」的隐形行，污染 turn 分组），目标由 goal 面板承载。
    expect(
      verifying.rows.window.find(
        (row) => row.kind === "timelineMarker" && row.marker.type === "goalSet",
      ),
    ).toBeUndefined();

    projection.applyEvent(
      new EventLog().push(SessionEventType.TargetCompletionVerification, {
        targetId: "target-1",
        status: "completed",
        verificationId: "verify-1",
        goalIteration: 1,
        verification: { passed: true, reason: "全部通过" },
      }),
    );
    const done = projection.getSnapshot();
    expect(() => conversationSnapshotSchema.parse(done)).not.toThrow();
    expect(done.goal).toMatchObject({ status: "verified", iteration: 1 });
    expect(done.control).toMatchObject({
      phase: "completedSuccess",
      canStop: false,
      stopState: "idle",
      stopTargetKind: "unknown",
      sessionEnded: true,
    });
    expect(done.control.activeWorks).toEqual([]);
    expect(done.goal?.verifications).toEqual([
      expect.objectContaining({
        iteration: 1,
        outcome: "pass",
        anchorRowId: verifyMarker?.rowId,
      }),
    ]);
    // marker 就地终态化（同 rowId）。
    expect(
      done.rows.window.find(
        (row) => row.kind === "timelineMarker" && row.marker.type === "goalVerify",
      ),
    ).toMatchObject({
      rowId: verifyMarker?.rowId,
      marker: { outcome: "pass", detail: "全部通过" },
    });
  });

  it("goal verifier 被 Stop 时暂停已有 future queue", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, {
      mode: "default",
      contextWindow: 1000,
    });
    log.push(SessionEventType.TargetChanged, {
      action: "set",
      source: "command",
      target: goalTarget("active"),
      previousTarget: null,
    });
    log.push(SessionEventType.TargetCompletionVerification, {
      targetId: "target-1",
      status: "started",
      verificationId: "verify-stop",
      foregroundExecutionId: "foreground-stop",
      goalIteration: 1,
    });
    log.push(SessionEventType.TurnSteerQueued, {
      pendingInputId: "queue-after-verifier",
      inputId: "command-after-verifier",
      input: "verifier 后继续的问题",
      inputPreview: "verifier 后继续的问题",
      inputSize: 13,
      targetTurnId: "turn-goal",
      queueLength: 1,
      delivery: "queue",
    });
    log.push(SessionEventType.TargetCompletionVerification, {
      targetId: "target-1",
      status: "cancelled",
      verificationId: "verify-stop",
      foregroundExecutionId: "foreground-stop",
      goalIteration: 1,
    });

    const { projection } = runAll(log.events);
    const snapshot = projection.getSnapshot();
    expect(snapshot.goal?.status).toBe("paused");
    expect(snapshot.queue).toMatchObject({
      autoDrain: false,
      pauseReason: "stopped",
      items: [expect.objectContaining({ queueItemId: "queue-after-verifier" })],
    });
    expect(snapshot.inputRouting).toEqual({
      mode: "choice",
      reasonCode: "heldQueueInputRequiresChoice",
    });
  });

  it("M07j：sendQueuedNow 抢占 goal verifier 时不暂停 future queue", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, {
      mode: "default",
      contextWindow: 1000,
    });
    log.push(SessionEventType.TargetChanged, {
      action: "set",
      source: "command",
      target: goalTarget("active"),
      previousTarget: null,
    });
    log.push(SessionEventType.TargetCompletionVerification, {
      targetId: "target-1",
      status: "started",
      verificationId: "verify-send-now",
      foregroundExecutionId: "foreground-send-now",
      goalIteration: 1,
    });
    log.push(SessionEventType.TurnSteerQueued, {
      pendingInputId: "queue-send-now",
      inputId: "command-send-now",
      input: "立即发送的问题",
      inputPreview: "立即发送的问题",
      inputSize: 21,
      targetTurnId: "turn-goal",
      queueLength: 1,
      delivery: "queue",
    });
    log.push(SessionEventType.TargetCompletionVerification, {
      targetId: "target-1",
      status: "cancelled",
      verificationId: "verify-send-now",
      foregroundExecutionId: "foreground-send-now",
      preserveQueueAutoDrainOnCancel: true,
      goalIteration: 1,
    });

    const { projection } = runAll(log.events);
    const snapshot = projection.getSnapshot();
    expect(snapshot.goal?.status).toBe("paused");
    expect(snapshot.queue).toMatchObject({
      autoDrain: true,
      items: [expect.objectContaining({ queueItemId: "queue-send-now" })],
    });
    expect(snapshot.queue.pauseReason).toBeUndefined();
    expect(snapshot.inputRouting.mode).toBe("startNow");
  });

  it("verify notSatisfied —— 有效结论与过程失败分离（goalVerificationOutcomeSeparation）", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(SessionEventType.TargetChanged, {
      action: "set",
      source: "command",
      target: goalTarget("active"),
    });
    log.push(SessionEventType.TargetCompletionVerification, {
      targetId: "target-1",
      status: "started",
      verificationId: "verify-1",
      goalIteration: 1,
    });
    log.push(SessionEventType.TargetCompletionVerification, {
      targetId: "target-1",
      status: "completed",
      verificationId: "verify-1",
      goalIteration: 1,
      verification: { passed: false, reason: "还有 2 个用例红" },
    });
    const { projection } = runAll(log.events);
    expect(projection.getSnapshot().goal).toMatchObject({ status: "notSatisfied" });
    expect(projection.getSnapshot().goal?.verifications[0]).toMatchObject({
      outcome: "notSatisfied",
    });
  });

  it("H13-H16：投影 target 计时/标题、verifier action 与逐轮 Todo 状态", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(SessionEventType.TargetChanged, {
      action: "set",
      source: "command",
      target: {
        ...goalTarget("active"),
        summaryTitle: "第一轮：恢复摘要",
        timeUsedSeconds: 7,
        activeRunStartedAtMs: 1_700_000_001_000,
      },
    });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "first" }, { turnId: "turn-1" });
    log.push(
      SessionEventType.ToolCallScheduled,
      {
        toolCallId: "todo-1",
        toolName: "TodoWrite",
        input: {
          todos: [{ content: "恢复计时", status: "completed", priority: "high" }],
        },
        schedule: { parallelGroups: [["todo-1"]], executionOrder: ["todo-1"] },
      },
      { turnId: "turn-1" },
    );
    log.push(
      SessionEventType.TurnComplete,
      { response: "done", tokenCount: 1, toolCallCount: 1, duration: 1, resultType: "success" },
      { turnId: "turn-1" },
    );
    log.push(SessionEventType.TargetCompletionVerification, {
      targetId: "target-1",
      status: "started",
      verificationId: "verify-1",
      goalIteration: 1,
    });
    log.push(SessionEventType.TargetCompletionVerification, {
      targetId: "target-1",
      status: "completed",
      verificationId: "verify-1",
      goalIteration: 1,
      verification: {
        passed: false,
        reason: "还缺暂停状态",
        nextAction: "第二轮：补暂停和完成态",
      },
    });
    log.push(SessionEventType.TargetChanged, {
      action: "run_started",
      source: "runtime",
      target: {
        ...goalTarget("active"),
        summaryTitle: "第一轮：恢复摘要",
        timeUsedSeconds: 11,
        activeRunStartedAtMs: 1_700_000_009_000,
      },
    });
    log.push(
      SessionEventType.TurnStarted,
      { turnNumber: 2, input: "second" },
      { turnId: "turn-2" },
    );
    log.push(
      SessionEventType.ToolCallScheduled,
      {
        toolCallId: "todo-2",
        toolName: "todo_write",
        input: {
          todos: [
            { content: "恢复暂停按钮", status: "in_progress", priority: "high" },
            { content: "恢复完成图标", status: "pending", priority: "medium" },
          ],
        },
        schedule: { parallelGroups: [["todo-2"]], executionOrder: ["todo-2"] },
      },
      { turnId: "turn-2" },
    );

    const { projection } = runAll(log.events);
    const snapshot = projection.getSnapshot();
    expect(snapshot.goal).toMatchObject({
      targetId: "target-1",
      summaryTitle: "第一轮：恢复摘要",
      timeUsedSeconds: 11,
      activeRunStartedAtMs: 1_700_000_009_000,
      status: "active",
      iteration: 1,
      verifications: [
        expect.objectContaining({
          iteration: 1,
          outcome: "notSatisfied",
          reason: "还缺暂停状态",
          nextAction: "第二轮：补暂停和完成态",
        }),
      ],
      iterations: [
        expect.objectContaining({
          iteration: 1,
          items: [expect.objectContaining({ content: "恢复计时", status: "completed" })],
        }),
        expect.objectContaining({
          iteration: 2,
          items: [
            expect.objectContaining({ content: "恢复暂停按钮", status: "inProgress" }),
            expect.objectContaining({ content: "恢复完成图标", status: "pending" }),
          ],
        }),
      ],
    });
    expect(snapshot.plan?.items).toHaveLength(2);
    expect(snapshot.availability.pauseGoal).toEqual({ allowed: true });
    expect(() => conversationSnapshotSchema.parse(snapshot)).not.toThrow();
  });

  it("stopPausesActiveGoalTarget：stop（cancelled turn）把 active goal 压成 paused，resumeGoal 放行", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(SessionEventType.TargetChanged, {
      action: "set",
      source: "command",
      target: goalTarget("active"),
    });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "go" }, { turnId: "turn-1" });
    log.push(
      SessionEventType.TurnComplete,
      { response: "", tokenCount: 0, toolCallCount: 0, duration: 100, resultType: "cancelled" },
      { turnId: "turn-1" },
    );
    const { projection } = runAll(log.events);
    const snapshot = projection.getSnapshot();
    expect(snapshot.goal).toMatchObject({ status: "paused" });
    expect(snapshot.availability.resumeGoal).toEqual({ allowed: true });
  });

  it("verify 被 stop（cancelled）—— marker=failed(detail=cancelled)，goal 回 paused，摘要不追加", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(SessionEventType.TargetChanged, {
      action: "set",
      source: "command",
      target: goalTarget("active"),
    });
    log.push(SessionEventType.TargetCompletionVerification, {
      targetId: "target-1",
      status: "started",
      verificationId: "verify-1",
      goalIteration: 1,
    });
    log.push(SessionEventType.TargetCompletionVerification, {
      targetId: "target-1",
      status: "cancelled",
      verificationId: "verify-1",
      goalIteration: 1,
    });
    const { projection } = runAll(log.events);
    const snapshot = projection.getSnapshot();
    expect(snapshot.goal).toMatchObject({ status: "paused" });
    expect(snapshot.goal?.verifications).toHaveLength(0);
    expect(
      snapshot.rows.window.find(
        (row) => row.kind === "timelineMarker" && row.marker.type === "goalVerify",
      ),
    ).toMatchObject({ marker: { outcome: "failed", detail: "cancelled" } });
    expect(snapshot.availability.resumeGoal).toEqual({ allowed: true });
  });

  it("goal cleared → GoalState=null；重复 status_updated 值未变不下发（conflation）", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(SessionEventType.TargetChanged, {
      action: "set",
      source: "command",
      target: goalTarget("active"),
    });
    const { projection } = runAll(log.events);

    const noop = new EventLog().push(SessionEventType.TargetChanged, {
      action: "status_updated",
      source: "runtime",
      target: goalTarget("active"),
    });
    expect(projection.applyEvent(noop)).toEqual([]);

    projection.applyEvent(
      new EventLog().push(SessionEventType.TargetChanged, {
        action: "cleared",
        source: "command",
        target: null,
      }),
    );
    expect(projection.getSnapshot().goal).toBeNull();
    expect(projection.getSnapshot().availability.resumeGoal).toEqual({
      allowed: false,
      reasonCode: "noGoalToResume",
    });
  });
});

// ── fork marker 与 modelChange marker ──

describe("fork / modelChange marker", () => {
  it("fork：parent 时间线不显示 forkCreated（S7）；child 首部 forkNotice", () => {
    const parentLog = new EventLog("session-1");
    basicTurnEvents(parentLog);
    parentLog.push(SessionEventType.SessionForked, {
      originalSessionId: "session-1",
      forkedSessionId: "session-child",
      targetMessageId: "msg-3",
    });
    const { projection: parent } = runAll(parentLog.events);
    const parentSnapshot = parent.getSnapshot();
    expect(() => conversationSnapshotSchema.parse(parentSnapshot)).not.toThrow();
    // S7（16-plan，2026-07-08 裁决）：fork 关系只在 sessions 树体现，父时间线零入侵
    //（旧实现的 forkCreated 是「渲染 null」的隐形行 + nextRowId-1 近似锚点）。
    expect(
      parentSnapshot.rows.window.find(
        (row) => row.kind === "timelineMarker" && row.marker.type === "forkCreated",
      ),
    ).toBeUndefined();

    const childProjection = new ProductProjection("session-child", "epoch-1");
    const childLog = new EventLog("session-child");
    childLog.push(SessionEventType.SessionForked, {
      originalSessionId: "session-1",
      forkedSessionId: "session-child",
    });
    for (const event of childLog.events) childProjection.applyEvent(event);
    expect(childProjection.getSnapshot().rows.window[0]).toMatchObject({
      kind: "timelineMarker",
      marker: { type: "forkNotice", parentSessionId: "session-1" },
    });
  });

  it("modelChange（R-17 时机）：marker 只在下一 turn 开始且与上一轮选型不同时产生", () => {
    // 场景 1（草稿态 bug 复现，2026-07-07）：turn 前任意切换选择器 → 不产 marker，
    // 首轮以最终选型启动也不产（「第一次用什么模型」不构成「变化」）。
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(SessionEventType.ModelSelected, {
      modelSelection: {
        providerId: "anthropic",
        modelId: "claude-4",
        options: { reasoningLevel: "thinking" },
      },
    });
    log.push(SessionEventType.ModelSelected, {
      previousModelSelection: {
        providerId: "anthropic",
        modelId: "claude-4",
        options: { reasoningLevel: "thinking" },
      },
      modelSelection: { providerId: "openai", modelId: "gpt-6" },
    });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "hi" }, { turnId: "turn-1" });
    const { projection } = runAll(log.events);
    expect(projection.getSnapshot().config).toMatchObject({
      provider: "openai",
      model: "gpt-6",
    });
    expect(
      projection
        .getSnapshot()
        .rows.window.filter(
          (row) => row.kind === "timelineMarker" && row.marker.type === "modelChange",
        ),
    ).toHaveLength(0);

    // 重复选同一配置：conflation，无 delta。
    const repeat = new EventLog().push(SessionEventType.ModelSelected, {
      modelSelection: { providerId: "openai", modelId: "gpt-6" },
    });
    expect(projection.applyEvent(repeat)).toEqual([]);

    // 场景 2：turn-1 用 gpt-6，期间切换 A→B→A（净变化为零）→ turn-2 不产 marker。
    projection.applyEvent(
      new EventLog().push(SessionEventType.ModelSelected, {
        modelSelection: { providerId: "anthropic", modelId: "claude-4" },
      }),
    );
    projection.applyEvent(
      new EventLog().push(SessionEventType.ModelSelected, {
        modelSelection: { providerId: "openai", modelId: "gpt-6" },
      }),
    );
    projection.applyEvent(
      new EventLog().push(
        SessionEventType.TurnStarted,
        { turnNumber: 2, input: "again" },
        { turnId: "turn-2" },
      ),
    );
    expect(
      projection
        .getSnapshot()
        .rows.window.filter(
          (row) => row.kind === "timelineMarker" && row.marker.type === "modelChange",
        ),
    ).toHaveLength(0);

    // 场景 3：切到不同选型后 turn-3 启动 → marker 落在 turnHeader 之前，
    // from = 上一轮实际选型（gpt-6），to = 本轮选型（claude-4）。
    projection.applyEvent(
      new EventLog().push(SessionEventType.ModelSelected, {
        modelSelection: { providerId: "anthropic", modelId: "claude-4" },
      }),
    );
    projection.applyEvent(
      new EventLog().push(
        SessionEventType.TurnStarted,
        { turnNumber: 3, input: "switch" },
        { turnId: "turn-3" },
      ),
    );
    const rows = projection.getSnapshot().rows.window;
    const markerIndex = rows.findIndex(
      (row) => row.kind === "timelineMarker" && row.marker.type === "modelChange",
    );
    expect(rows[markerIndex]).toMatchObject({
      marker: {
        type: "modelChange",
        fromProvider: "openai",
        fromModel: "gpt-6",
        toProvider: "anthropic",
        toModel: "claude-4",
        toThought: "",
      },
    });
    // marker 紧邻 turn-3 的 turnHeader 之前。
    expect(rows[markerIndex + 1]).toMatchObject({
      kind: "turnHeader",
      turnId: "turn-3",
    });
  });

  it("显式 source-less 模型边界经原子投影只在首个 turn 生成一次 marker", () => {
    const log = new EventLog("child-session");
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    log.push(SessionEventType.ModelSelected, {
      previousModelSelection: null,
      modelSelection: {
        providerId: "child-provider",
        modelId: "child-model",
        options: { reasoningLevel: "high" },
      },
    });
    log.push(SessionEventType.ModelSelected, {
      previousModelSelection: {
        providerId: "child-provider",
        modelId: "child-model",
        options: { reasoningLevel: "high" },
      },
      modelSelection: {
        providerId: "child-provider",
        modelId: "child-model-final",
        options: { reasoningLevel: "max" },
      },
    });
    log.push(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: "first child prompt" },
      { turnId: "child-turn-1" },
    );
    log.push(
      SessionEventType.TurnComplete,
      {
        response: "done",
        tokenCount: 1,
        toolCallCount: 0,
        duration: 1,
        resultType: "success",
      },
      { turnId: "child-turn-1" },
    );
    log.push(
      SessionEventType.TurnStarted,
      { turnNumber: 2, input: "second child prompt" },
      { turnId: "child-turn-2" },
    );

    const projection = new ProductProjection("child-session", "epoch-1");
    for (const event of log.events) {
      expect(projection.applyEventAtomically(event, () => true)).not.toBeNull();
    }
    const rows = projection.getSnapshot().rows.window;
    const markers = rows.filter(
      (row) => row.kind === "timelineMarker" && row.marker.type === "modelChange",
    );

    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      turnId: "child-turn-1",
      marker: {
        type: "modelChange",
        toProvider: "child-provider",
        toModel: "child-model-final",
        toThought: "max",
      },
    });
    expect(markers[0]?.kind === "timelineMarker" ? markers[0].marker : {}).not.toHaveProperty(
      "fromProvider",
    );
    const markerIndex = rows.indexOf(markers[0]!);
    expect(rows[markerIndex + 1]).toMatchObject({
      kind: "turnHeader",
      turnId: "child-turn-1",
    });
    expect(() => conversationSnapshotSchema.parse(projection.getSnapshot())).not.toThrow();
  });

  it("H17：切模型后 /goal 控制输入不创建工作生命周期，只有 continuation 为 running", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(SessionEventType.ModelSelected, {
      modelSelection: { providerId: "zhipu", modelId: "glm-5.2-highspeed" },
    });
    log.push(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: "上一轮", messageId: "user-previous" },
      { turnId: "turn-previous" },
    );
    log.push(
      SessionEventType.TurnComplete,
      { response: "done", tokenCount: 1, toolCallCount: 0, duration: 1000, resultType: "success" },
      { turnId: "turn-previous" },
    );
    log.push(SessionEventType.ModelSelected, {
      modelSelection: {
        providerId: "deepseek",
        modelId: "deepseek-v4-flash",
        options: { reasoningLevel: "max" },
      },
    });
    log.push(
      SessionEventType.TurnStarted,
      {
        turnNumber: 2,
        input: "/Goal 开发一个招投标管理系统",
        messageId: "user-goal",
        executionKind: "controlOnly",
        intent: {
          sourceCommandId: "command-goal",
          queueItemId: "queue-goal",
          clientId: "desktop",
          kind: "sendGoalCommand",
          text: "开发一个招投标管理系统",
          admissionSeq: 1,
          admittedAt: 1,
          requestedDelivery: "startNow",
          admittedDelivery: "startNow",
        },
      },
      { turnId: "turn-goal-query" },
    );

    const projection = new ProductProjection("session-1", "epoch-1");
    for (const event of log.events) projection.applyEvent(event);
    expect(projection.getSnapshot().control).toMatchObject({
      phase: "completedSuccess",
      canStop: false,
      activeWorks: [],
    });

    log.push(
      SessionEventType.TurnComplete,
      { response: "", tokenCount: 0, toolCallCount: 0, duration: 0, resultType: "success" },
      { turnId: "turn-goal-query" },
    );
    projection.applyEvent(log.events.at(-1)!);
    const goalHeader = projection
      .getSnapshot()
      .rows.window.find((row) => row.kind === "turnHeader" && row.turnId === "user-goal");
    expect(goalHeader).toMatchObject({
      kind: "turnHeader",
      executionKind: "controlOnly",
      state: "completedSuccess",
    });
    expect(goalHeader).not.toHaveProperty("activeMs");
    expect(projection.getSnapshot().control).toMatchObject({
      phase: "completedSuccess",
      canStop: false,
      activeWorks: [],
    });

    log.push(
      SessionEventType.TurnStarted,
      {
        turnNumber: 3,
        input: "继续执行目标",
        messageId: "goal-continuation-1",
        inputSource: "goal-continuation",
        inputVisibility: "model-only",
      },
      { turnId: "turn-goal-continuation" },
    );
    projection.applyEvent(log.events.at(-1)!);
    const snapshot = projection.getSnapshot();
    expect(snapshot.control).toMatchObject({
      phase: "running",
      canStop: true,
      activeWorks: [{ kind: "goalContinuation" }],
    });
    expect(
      snapshot.rows.window.find(
        (row) => row.kind === "turnHeader" && row.turnId === "goal-continuation-1",
      ),
    ).toMatchObject({ executionKind: "agent", state: "running" });
    expect(
      snapshot.rows.window.filter(
        (row) => row.kind === "timelineMarker" && row.marker.type === "modelChange",
      ),
    ).toHaveLength(1);
  });

  it("modelChange：仅思考深度变化不产 marker", () => {
    const log = new EventLog();
    log.push(SessionEventType.ModelSelected, {
      modelSelection: { providerId: "default-deepseek", modelId: "deepseek-v4-flash" },
    });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "first" }, { turnId: "turn-1" });
    const { projection } = runAll(log.events);

    projection.applyEvent(
      new EventLog().push(SessionEventType.ModelSelected, {
        modelSelection: {
          providerId: "default-deepseek",
          modelId: "deepseek-v4-flash",
          options: { reasoningLevel: "max" },
        },
      }),
    );
    projection.applyEvent(
      new EventLog().push(
        SessionEventType.TurnStarted,
        { turnNumber: 2, input: "same model, deeper thought" },
        { turnId: "turn-2" },
      ),
    );

    expect(projection.getSnapshot().config).toMatchObject({
      provider: "default-deepseek",
      model: "deepseek-v4-flash",
      thought: "max",
    });
    expect(
      projection
        .getSnapshot()
        .rows.window.filter(
          (row) => row.kind === "timelineMarker" && row.marker.type === "modelChange",
        ),
    ).toHaveLength(0);
  });

  // ── M4：rowId → messageId 侧表（forkAssistant/editUserQuery 桥接翻译，13 §E 组前置）──
  it("E：assistant 行记录 assistantMessageId，getMessageIdForRow 可翻译", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "hi" }, { turnId: "turn-1" });
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_start", delta: "", done: false, assistantMessageId: "msg-assist-1" },
      { turnId: "turn-1" },
    );
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_delta", delta: "hello", done: false, assistantMessageId: "msg-assist-1" },
      { turnId: "turn-1" },
    );
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_end", delta: "", done: false },
      { turnId: "turn-1" },
    );
    const { projection } = runAll(log.events);
    const assistantRow = projection
      .getSnapshot()
      .rows.window.find((row) => row.kind === "assistantText");
    expect(assistantRow).toBeDefined();
    expect(projection.getMessageIdForRow(assistantRow!.rowId)).toBe("msg-assist-1");
    // 非 assistant 行 / 未知 rowId → null（桥接层据此 reject，不静默兜底 fork 错点）。
    expect(projection.getMessageIdForRow(9999)).toBeNull();
    const turnHeaderRow = projection
      .getSnapshot()
      .rows.window.find((row) => row.kind === "turnHeader");
    expect(projection.getMessageIdForRow(turnHeaderRow!.rowId)).toBeNull();
  });

  it("E：无 assistantMessageId 的流（老 provider）→ 行存在但翻译为 null", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "hi" }, { turnId: "turn-1" });
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_start", delta: "", done: false },
      { turnId: "turn-1" },
    );
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_delta", delta: "hello", done: false },
      { turnId: "turn-1" },
    );
    const { projection } = runAll(log.events);
    const assistantRow = projection
      .getSnapshot()
      .rows.window.find((row) => row.kind === "assistantText");
    expect(assistantRow).toBeDefined();
    expect(projection.getMessageIdForRow(assistantRow!.rowId)).toBeNull();
  });

  it("P0：user messageId 缺失时不得用同 turn assistant anchor 冒充 canEdit target", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    log.push(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: "缺少持久 user id" },
      { turnId: "turn-1" },
    );
    log.push(
      SessionEventType.ModelStreaming,
      {
        kind: "text_start",
        delta: "",
        done: false,
        assistantMessageId: "assistant-only-anchor",
      },
      { turnId: "turn-1" },
    );
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_delta", delta: "回答", done: false },
      { turnId: "turn-1" },
    );
    log.push(
      SessionEventType.TurnComplete,
      { response: "回答", tokenCount: 1, toolCallCount: 0, duration: 1, resultType: "success" },
      { turnId: "turn-1" },
    );

    const { projection } = runAll(log.events);
    const userRow = projection.getSnapshot().rows.window.find((row) => row.kind === "userInput");
    expect(userRow).toBeDefined();
    expect(projection.getMessageIdForRow(userRow!.rowId)).toBeNull();
    // turn rewind 仍能找到 assistant anchor，但 exact user target 不存在。
    expect(projection.getTurnRewindAnchor(userRow!.rowId)).toBe("assistant-only-anchor");
    expect(userRow!.actions?.canEdit).not.toBe(true);
    expect(projection.isLatestEditableUserRow(userRow!.rowId)).toBe(false);
  });

  it("P1：legacy 身份 fallback 必须由 normalizer 留下可观测诊断", () => {
    const log = new EventLog();
    log.push(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: "legacy query" },
      { turnId: "turn-legacy" },
    );

    const { projection } = runAll(log.events);

    expect(projection.getNormalizationDiagnostics()).toEqual([
      {
        code: "normalizer.user.missingTranscriptMessageId",
        eventId: "event-1",
      },
    ]);
  });

  it("P1/P2：live 与 cold 合成事件的 command target/actions 逐实体等价", () => {
    const project = (turnId: string) => {
      const log = new EventLog();
      log.push(
        SessionEventType.TurnStarted,
        { turnNumber: 1, input: "same query", messageId: "message-user-1" },
        { turnId },
      );
      log.push(
        SessionEventType.ModelStreaming,
        {
          kind: "text_start",
          delta: "",
          done: false,
          assistantMessageId: "message-assistant-1",
          partId: "part-1",
        },
        { turnId },
      );
      log.push(
        SessionEventType.ModelStreaming,
        { kind: "text_delta", delta: "same answer", done: false, partId: "part-1" },
        { turnId },
      );
      log.push(
        SessionEventType.ModelStreaming,
        { kind: "text_end", delta: "", done: false, partId: "part-1" },
        { turnId },
      );
      log.push(
        SessionEventType.TurnComplete,
        {
          response: "same answer",
          tokenCount: 1,
          toolCallCount: 0,
          duration: 1,
          resultType: "success",
        },
        { turnId },
      );
      return runAll(log.events).projection;
    };
    const live = project("runtime-turn-1");
    const cold = project("hydrate-turn-1");
    const semanticRows = (projection: ProductProjection) =>
      projection
        .getSnapshot()
        .rows.window.filter((row) => row.kind === "userInput" || row.kind === "assistantText")
        .map((row) => ({
          kind: row.kind,
          text: row.text,
          productTurnId: row.turnId,
          actions: row.actions,
          entityId: projection.getEntityIdForRow(row.rowId),
          target: projection.getMessageIdForRow(row.rowId),
        }));

    expect(semanticRows(cold)).toEqual(semanticRows(live));
    expect(semanticRows(live).map((row) => row.productTurnId)).toEqual([
      "message-user-1",
      "message-user-1",
    ]);
    expect(live.getNormalizationDiagnostics()).toEqual([]);
    expect(cold.getNormalizationDiagnostics()).toEqual([]);
  });

  it("P2：entity resolver 只允许当前 canEdit 的真实用户实体", () => {
    const log = new EventLog();
    for (const turnNumber of [1, 2]) {
      const turnId = `turn-${turnNumber}`;
      log.push(
        SessionEventType.TurnStarted,
        {
          turnNumber,
          input: `query ${turnNumber}`,
          messageId: `message-user-${turnNumber}`,
        },
        { turnId },
      );
      log.push(
        SessionEventType.TurnComplete,
        {
          response: "",
          tokenCount: 0,
          toolCallCount: 0,
          duration: 1,
          resultType: "success",
        },
        { turnId },
      );
    }

    const { projection } = runAll(log.events);
    const userRows = projection.getSnapshot().rows.window.filter((row) => row.kind === "userInput");

    expect(userRows.map((row) => row.actions?.canEdit === true)).toEqual([false, true]);
    expect(projection.resolveEditTargetByEntityId("message-user-1")).toBeNull();
    expect(projection.resolveEditTargetByEntityId("message-user-2")).toMatchObject({
      entityId: "message-user-2",
      productTurnId: "message-user-2",
      transcriptMessageId: "message-user-2",
    });
  });

  it("Task3：row.actions 与 target resolver 同源并声明 edit disposition", () => {
    const log = new EventLog();
    log.push(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: "query", messageId: "message-user-1" },
      { turnId: "turn-1" },
    );
    log.push(
      SessionEventType.ModelStreaming,
      {
        kind: "text_start",
        delta: "",
        done: false,
        assistantMessageId: "message-assistant-1",
      },
      { turnId: "turn-1" },
    );
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_end", delta: "", done: false },
      { turnId: "turn-1" },
    );
    log.push(
      SessionEventType.TurnComplete,
      {
        response: "",
        tokenCount: 0,
        toolCallCount: 0,
        duration: 1,
        resultType: "success",
      },
      { turnId: "turn-1" },
    );
    const { projection } = runAll(log.events);
    const userRow = projection.getSnapshot().rows.window.find((row) => row.kind === "userInput")!;
    const assistantRow = projection
      .getSnapshot()
      .rows.window.find((row) => row.kind === "assistantText")!;
    const target = { rowId: userRow.rowId, entityId: "message-user-1" };

    expect(userRow.actions).toMatchObject({
      canEdit: true,
      editDisposition: "rewind",
    });
    expect(assistantRow.actions).toMatchObject({
      canFork: true,
      canRetry: true,
    });
    expect(projection.resolveRowActionTarget(target, "editUserQuery")).toMatchObject({
      ok: true,
      action: "editUserQuery",
      editTarget: { transcriptMessageId: "message-user-1" },
    });
    expect(
      projection.resolveRowActionTarget(
        { rowId: userRow.rowId, entityId: "reused-for-another-entity" },
        "editUserQuery",
      ),
    ).toEqual({ ok: false, status: "stale", reasonCode: "proto.staleTarget" });
    expect(projection.resolveRowActionTarget(target, "retryTurn")).toEqual({
      ok: false,
      status: "rejected",
      reasonCode: "guard.actionUnavailable",
    });

    projection.applyEvent(
      new EventLog().push(SessionEventType.CompactStarted, {
        operationId: "compact-1",
        messageId: "compact-message",
        status: "started",
        trigger: "manual",
        display: "separator",
      }),
    );
    const lockedRow = projection
      .getSnapshot()
      .rows.window.find((row) => row.rowId === userRow.rowId)!;
    const lockedAssistantRow = projection
      .getSnapshot()
      .rows.window.find((row) => row.rowId === assistantRow.rowId)!;
    expect(lockedRow.actions?.canEdit).toBeUndefined();
    // compact 锁在 availability.fork，不写进行级 canFork（02-projection「会话锁与行级资格」）。
    expect(lockedAssistantRow.actions?.canFork).toBe(true);
    expect(projection.getSnapshot().availability.fork).toEqual({
      allowed: false,
      reasonCode: "compactOperationLock",
    });
    expect(
      projection.resolveRowActionTarget(
        { rowId: assistantRow.rowId, entityId: assistantRow.entityId! },
        "forkAssistant",
      ),
    ).toEqual({ ok: false, status: "rejected", reasonCode: "guard.actionUnavailable" });
    expect(lockedAssistantRow.actions?.canRetry).toBeUndefined();
    expect(projection.getSnapshot().availability.sendQueuedNow).toEqual({
      allowed: false,
      reasonCode: "compactOperationLock",
    });

    projection.applyEvent(
      new EventLog().push(SessionEventType.CompactCompleted, {
        operationId: "compact-1",
        messageId: "compact-message",
        status: "completed",
        trigger: "manual",
        display: "separator",
        tailStartMessageId: "message-user-1",
      }),
    );
    const compactedRow = projection
      .getSnapshot()
      .rows.window.find((row) => row.rowId === userRow.rowId)!;
    expect(compactedRow.actions).toMatchObject({
      canEdit: true,
      editDisposition: "rewind",
    });
    expect(projection.resolveRowActionTarget(target, "editUserQuery")).toMatchObject({
      ok: true,
      action: "editUserQuery",
      editTarget: { coveredByStableCompact: true },
    });
  });

  it("root review：primary/goal continuation/verifier running 时 retry 与 file rewind 同源禁用", () => {
    const completedProjection = () => {
      const log = new EventLog();
      log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
      log.push(
        SessionEventType.TurnStarted,
        { turnNumber: 1, input: "改文件", messageId: "message-user-base" },
        { turnId: "turn-base" },
      );
      log.push(
        SessionEventType.ModelStreaming,
        {
          kind: "text_start",
          delta: "",
          done: false,
          assistantMessageId: "message-assistant-base",
        },
        { turnId: "turn-base" },
      );
      log.push(
        SessionEventType.ModelStreaming,
        { kind: "text_delta", delta: "done", done: false },
        { turnId: "turn-base" },
      );
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
            additions: 2,
            deletions: 1,
            items: [{ path: "/work/a.ts", additions: 2, deletions: 1, writeCount: 1 }],
          },
        },
        { turnId: "turn-base" },
      );
      log.push(
        SessionEventType.TurnComplete,
        { response: "done", tokenCount: 2, toolCallCount: 0, duration: 1, resultType: "success" },
        { turnId: "turn-base" },
      );
      return runAll(log.events).projection;
    };
    const contexts = [
      {
        kind: "primaryTurn",
        event: () =>
          new EventLog().push(
            SessionEventType.TurnStarted,
            { turnNumber: 2, input: "next", messageId: "message-user-next" },
            { turnId: "turn-next" },
          ),
      },
      {
        kind: "goalContinuation",
        event: () =>
          new EventLog().push(
            SessionEventType.TurnStarted,
            {
              turnNumber: 2,
              input: "continue",
              inputSource: "goal-continuation",
              inputVisibility: "model-only",
            },
            { turnId: "turn-goal-continuation" },
          ),
      },
      {
        kind: "goalVerifier",
        event: () =>
          new EventLog().push(SessionEventType.TargetCompletionVerification, {
            targetId: "target-1",
            status: "started",
            verificationId: "verify-1",
            goalIteration: 1,
          }),
      },
    ] as const;

    for (const context of contexts) {
      const projection = completedProjection();
      const base = projection.getSnapshot();
      const header = base.rows.window.find((row) => row.kind === "turnHeader")!;
      const assistant = base.rows.window.find((row) => row.kind === "assistantText")!;
      const headerTarget = { rowId: header.rowId, entityId: header.entityId! };
      const assistantTarget = { rowId: assistant.rowId, entityId: assistant.entityId! };

      projection.applyEvent(context.event());
      const running = projection.getSnapshot();
      const lockedHeader = running.rows.window.find((row) => row.rowId === header.rowId)!;
      const lockedAssistant = running.rows.window.find((row) => row.rowId === assistant.rowId)!;
      expect(running.control.activeWorks.some((work) => work.kind === context.kind)).toBe(true);
      expect(lockedHeader.actions?.canRewindFiles, context.kind).toBe(true);
      expect(running.availability.rewindFiles, context.kind).toEqual({
        allowed: false,
        reasonCode: "fileRewindUnavailable",
      });
      expect(lockedAssistant.actions?.canRetry, context.kind).toBeUndefined();
      expect(lockedAssistant.actions?.canFork, context.kind).toBe(true);
      expect(projection.resolveRowActionTarget(headerTarget, "applyFileRewind")).toMatchObject({
        ok: false,
        reasonCode: "guard.actionUnavailable",
      });
      expect(projection.resolveRowActionTarget(assistantTarget, "retryTurn")).toMatchObject({
        ok: false,
        reasonCode: "guard.actionUnavailable",
      });
      expect(projection.resolveRowActionTarget(assistantTarget, "forkAssistant")).toMatchObject({
        ok: true,
      });
    }
  });

  // ── composer 编辑态冻结：锁进入投影，同 id 重入 queued 不解锁，释放事件解锁 ──
  it("TurnSteerEditLockChanged：锁投影到 queue item，重入 queued 保留锁，释放后移除", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "跑" }, { turnId: "t1" });
    const queued = {
      pendingInputId: "q1",
      input: "第一条",
      inputPreview: "第一条",
      inputSize: 9,
      queueLength: 1,
      targetTurnId: "t1",
    };
    log.push(SessionEventType.TurnSteerQueued, queued, { turnId: "t1" });
    const lock = { editorId: "editor-a", clientId: "desktop", inputOrigin: "desktop" };
    log.push(
      SessionEventType.TurnSteerEditLockChanged,
      { pendingInputId: "q1", targetTurnId: "t1", editLock: lock },
      { turnId: "t1" },
    );
    const locked = runAll(log.events).projection.getSnapshot();
    expect(locked.queue.items[0]?.editLock).toEqual(lock);
    expect(locked.inputRouting.mode).toBe("enqueue");
    log.push(SessionEventType.TurnSteerQueued, { ...queued, input: "改" }, { turnId: "t1" });
    expect(runAll(log.events).projection.getSnapshot().queue.items[0]?.editLock).toEqual(lock);
    log.push(
      SessionEventType.TurnSteerEditLockChanged,
      { pendingInputId: "q1", targetTurnId: "t1" },
      { turnId: "t1" },
    );
    const released = runAll(log.events).projection.getSnapshot();
    expect(released.queue.items[0]).not.toHaveProperty("editLock");
    expect(released.queue.items[0]?.text).toBe("改");
  });

  // ── M4：queue 单项编辑（同 id 重入 TurnSteerQueued → 原地更新保位）──
  it("A/B：editQueueItem —— 同 queueItemId 重入更新文本且保位", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "跑" }, { turnId: "t1" });
    // 入队两条
    log.push(
      SessionEventType.TurnSteerQueued,
      {
        pendingInputId: "q1",
        input: "第一条",
        inputPreview: "第一条",
        inputSize: 9,
        automationId: "automation-queued",
        queueLength: 1,
        targetTurnId: "t1",
        intent: {
          botGroupSource: {
            provider: "feishu",
            botId: "bot",
            chatId: "group",
            senderId: "member",
            senderName: "Member",
            messageId: "message",
          },
          sourceCommandId: "command-q1",
          queueItemId: "q1",
          clientId: "mobile-client",
          kind: "sendText",
          admissionSeq: 1,
          admittedAt: 10,
          requestedDelivery: "guide",
          admittedDelivery: "queue",
          fallbackReasonCode: "guide.attachmentsUnsupported",
          attachmentRefs: [
            { ref: "artifact://q1", fileName: "q1.txt", mime: "text/plain", bytes: 2 },
          ],
        },
      },
      { turnId: "t1" },
    );
    log.push(
      SessionEventType.TurnSteerQueued,
      {
        pendingInputId: "q2",
        input: "第二条",
        inputPreview: "第二条",
        inputSize: 9,
        queueLength: 2,
        targetTurnId: "t1",
      },
      { turnId: "t1" },
    );
    // 编辑第一条（同 id 重入）
    log.push(
      SessionEventType.TurnSteerQueued,
      {
        pendingInputId: "q1",
        input: "第一条改",
        inputPreview: "第一条改",
        inputSize: 12,
        queueLength: 2,
        targetTurnId: "t1",
      },
      { turnId: "t1" },
    );
    const { projection } = runAll(log.events);
    const items = projection.getSnapshot().queue.items;
    // 仍 2 条，q1 在原位（index 0）且文本已更新。
    expect(items.map((i) => i.queueItemId)).toEqual(["q1", "q2"]);
    expect(items[0]).toMatchObject({
      text: "第一条改",
      automationId: "automation-queued",
      botGroupSource: { senderId: "member", chatId: "group" },
      sourceCommandId: "command-q1",
      clientId: "mobile-client",
      attachments: [{ ref: "artifact://q1" }],
      delivery: {
        requested: "guide",
        admitted: "queue",
        fallbackReasonCode: "guide.attachmentsUnsupported",
      },
      order: { admissionSeq: 1, queuePosition: 0 },
      steer: { state: "fellBack", reasonCode: "guide.attachmentsUnsupported" },
    });
    expect(items[1]!.text).toBe("第二条");
  });

  // ── M4：queue 重排（TurnSteerReordered → 按新序重排 queue rows）──
  it("A/B：reorderQueueItem —— 按 orderedPendingInputIds 重排 queue", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "跑" }, { turnId: "t1" });
    for (const [id, text, len] of [
      ["q1", "一", 3],
      ["q2", "二", 3],
      ["q3", "三", 3],
    ] as const) {
      log.push(
        SessionEventType.TurnSteerQueued,
        {
          pendingInputId: id,
          input: text,
          inputPreview: text,
          inputSize: len,
          queueLength: 3,
          targetTurnId: "t1",
        },
        { turnId: "t1" },
      );
    }
    // 把 q3 移到 q1 之前：新序 q3, q1, q2。
    log.push(
      SessionEventType.TurnSteerReordered,
      { orderedPendingInputIds: ["q3", "q1", "q2"], targetTurnId: "t1" },
      { turnId: "t1" },
    );
    const { projection } = runAll(log.events);
    expect(projection.getSnapshot().queue.items.map((i) => i.queueItemId)).toEqual([
      "q3",
      "q1",
      "q2",
    ]);
    expect(projection.getSnapshot().queue.items.map((i) => i.order.queuePosition)).toEqual([
      0, 1, 2,
    ]);
  });

  it("sendQueuedNow dispatch：reserved/promoting 只更新目标项且保留完整 intent", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    log.push(
      SessionEventType.TurnSteerQueued,
      {
        pendingInputId: "q1",
        input: "带附件输入",
        inputPreview: "带附件输入",
        inputSize: 18,
        queueLength: 1,
        targetTurnId: "t1",
        intent: {
          sourceCommandId: "source-q1",
          queueItemId: "q1",
          clientId: "mobile-client",
          kind: "sendText",
          admissionSeq: 1,
          admittedAt: 10,
          requestedDelivery: "queue",
          admittedDelivery: "queue",
          attachmentRefs: [
            { ref: "artifact://q1", fileName: "q1.txt", mime: "text/plain", bytes: 2 },
          ],
        },
      },
      { turnId: "t1" },
    );
    log.push(SessionEventType.TurnSteerDispatchChanged, {
      pendingInputId: "q1",
      reservationId: "send-now-1",
      state: "reserved",
      targetTurnId: "t1",
    });
    log.push(SessionEventType.TurnSteerDispatchChanged, {
      pendingInputId: "q1",
      reservationId: "send-now-1",
      state: "promoting",
      targetTurnId: "t1",
    });

    const { projection } = runAll(log.events);
    expect(projection.getSnapshot().queue.items[0]).toMatchObject({
      sourceCommandId: "source-q1",
      clientId: "mobile-client",
      attachments: [{ ref: "artifact://q1" }],
      dispatch: { state: "promoting", reservationId: "send-now-1" },
    });
  });

  it("sendQueuedNow commit：SessionInputPromoted 是 queue 移除的 durable 提交信号", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    log.push(
      SessionEventType.TurnSteerQueued,
      {
        pendingInputId: "q1",
        input: "已持久化输入",
        inputPreview: "已持久化输入",
        inputSize: 21,
        queueLength: 1,
        targetTurnId: "t1",
        intent: {
          sourceCommandId: "source-q1",
          queueItemId: "q1",
          clientId: "desktop-client",
          kind: "sendText",
          admissionSeq: 1,
          admittedAt: 10,
          requestedDelivery: "queue",
          admittedDelivery: "queue",
          attachmentRefs: [],
        },
      },
      { turnId: "t1" },
    );
    log.push(SessionEventType.TurnSteerDispatchChanged, {
      pendingInputId: "q1",
      reservationId: "send-now-1",
      state: "promoting",
      targetTurnId: "t1",
    });
    // startPromptTurn 已把 user message + session_input promotion 同事务提交。
    // 即使后续 TurnSteerDiscarded(promoted) 丢失，投影也不能留下幽灵 queue item。
    log.push(SessionEventType.SessionInputPromoted, {
      pendingInputId: "q1",
      sourceCommandId: "source-q1",
      messageId: "message-q1",
    });

    const { projection } = runAll(log.events);
    expect(projection.getSnapshot().queue.items).toEqual([]);
  });

  // ── M4：setAutoDrain（QueueAutoDrainChanged → queue.autoDrain + held 派生）──
  it("A/B：setAutoDrain(false) → queue.autoDrain=false，held 时 completed+queue>0 走 choice", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "跑" }, { turnId: "t1" });
    log.push(
      SessionEventType.TurnSteerQueued,
      {
        pendingInputId: "q1",
        input: "排队项",
        inputPreview: "排队项",
        inputSize: 9,
        queueLength: 1,
        targetTurnId: "t1",
      },
      { turnId: "t1" },
    );
    // 关闭 autoDrain（保留队列）
    log.push(SessionEventType.QueueAutoDrainChanged, { autoDrain: false });
    // turn 结束 → completed + queue>0 + autoDrain=false → 输入路由为 choice
    log.push(
      SessionEventType.TurnComplete,
      { response: "", tokenCount: 0, toolCallCount: 0, duration: 0, resultType: "success" },
      { turnId: "t1" },
    );
    const { projection } = runAll(log.events);
    const snapshot = projection.getSnapshot();
    expect(snapshot.queue.autoDrain).toBe(false);
    expect(snapshot.queue.pauseReason).toBe("manual");
    expect(snapshot.inputRouting.mode).toBe("choice");
    expect(snapshot.inputRouting.reasonCode).toBe("heldQueueInputRequiresChoice");
  });

  it("B：Stop 保留队列时记录 stopped 原因；恢复后清除暂停原因", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "跑" }, { turnId: "t1" });
    log.push(
      SessionEventType.TurnSteerQueued,
      {
        pendingInputId: "q1",
        input: "排队项",
        inputPreview: "排队项",
        inputSize: 9,
        queueLength: 1,
        targetTurnId: "t1",
      },
      { turnId: "t1" },
    );
    log.push(
      SessionEventType.TurnComplete,
      { response: "", tokenCount: 0, toolCallCount: 0, duration: 0, resultType: "cancelled" },
      { turnId: "t1" },
    );
    log.push(SessionEventType.QueueAutoDrainChanged, { autoDrain: true });
    const projection = new ProductProjection("s1", "epoch-1");
    for (const event of log.events.slice(0, -1)) projection.applyEvent(event);
    expect(projection.getSnapshot().queue).toMatchObject({
      autoDrain: false,
      pauseReason: "stopped",
    });
    projection.applyEvent(log.events.at(-1)!);
    expect(projection.getSnapshot().queue.autoDrain).toBe(true);
    expect(projection.getSnapshot().queue.pauseReason).toBeUndefined();
  });

  it("M07a：sendQueuedNow 内部抢占不把 future queue 投影为 stopped", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "跑" }, { turnId: "t1" });
    log.push(
      SessionEventType.TurnSteerQueued,
      {
        pendingInputId: "q1",
        input: "立即发送",
        inputPreview: "立即发送",
        inputSize: 12,
        queueLength: 1,
        targetTurnId: "t1",
      },
      { turnId: "t1" },
    );
    log.push(
      SessionEventType.TurnComplete,
      {
        response: "",
        tokenCount: 0,
        toolCallCount: 0,
        duration: 0,
        resultType: "cancelled",
        preserveQueueAutoDrainOnCancel: true,
      },
      { turnId: "t1" },
    );

    const { projection } = runAll(log.events);
    const snapshot = projection.getSnapshot();
    expect(snapshot.control.phase).toBe("completedInterrupted");
    expect(snapshot.queue).toMatchObject({
      autoDrain: true,
      items: [expect.objectContaining({ queueItemId: "q1" })],
    });
    expect(snapshot.queue.pauseReason).toBeUndefined();
    expect(snapshot.inputRouting.mode).toBe("startNow");
  });

  it("A/B：setAutoDrain 幂等 —— 同值不产 delta", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    // 初始 autoDrain=true，再置 true 应无变化。
    log.push(SessionEventType.QueueAutoDrainChanged, { autoDrain: true });
    const { projection } = runAll(log.events);
    expect(projection.getSnapshot().queue.autoDrain).toBe(true);
  });

  // ── M4：setFollowupMode（FollowupModeChanged → running 时 enqueue vs guide）──
  it("A/B：setFollowupMode(guide) → running 时输入路由为 guide", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    log.push(SessionEventType.FollowupModeChanged, { mode: "guide" });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "跑" }, { turnId: "t1" });
    const { projection } = runAll(log.events);
    const snapshot = projection.getSnapshot();
    expect(snapshot.config.followupMode).toBe("guide");
    expect(snapshot.inputRouting.mode).toBe("guide");
  });

  it("A/B：followupMode 默认 queue —— running 时输入入队", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "跑" }, { turnId: "t1" });
    const { projection } = runAll(log.events);
    const snapshot = projection.getSnapshot();
    expect(snapshot.config.followupMode).toBe("queue");
    expect(snapshot.inputRouting.mode).toBe("enqueue");
  });

  // ── M5：switchCollaborationMode（SessionModeChanged → config.mode）──
  it("A/B：SessionModeChanged —— config.mode 更新且 revision 前进；同值不动", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "build", contextWindow: 200_000 });
    log.push(SessionEventType.SessionModeChanged, {
      mode: "plan",
      previousMode: "build",
      source: "command",
    });
    const { projection } = runAll(log.events);
    const snapshot = projection.getSnapshot();
    expect(snapshot.config.mode).toBe("plan");
    const revisionAfterSwitch = snapshot.revision;

    // 同值再切：无 delta，revision 不前进。
    log.push(SessionEventType.SessionModeChanged, {
      mode: "plan",
      previousMode: "plan",
      source: "command",
    });
    const { projection: projection2 } = runAll(log.events);
    expect(projection2.getSnapshot().config.mode).toBe("plan");
    expect(projection2.getSnapshot().revision).toBe(revisionAfterSwitch);
  });

  it("A/B：config.mode 初值 = build（draft 期无 SessionModeChanged 时的回落）", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "build", contextWindow: 200_000 });
    const { projection } = runAll(log.events);
    expect(projection.getSnapshot().config.mode).toBe("build");
  });

  // ── M4：renameSession / 自动标题（SessionTitleUpdated → meta.title）──
  it("A/B：SessionTitleUpdated —— generated 更新，custom 覆盖且 custom 后不被 generated 回退", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    // 初始 default
    expect(runAll(log.events).projection.getSnapshot().meta.titleSource).toBe("default");
    // 自动生成标题
    log.push(SessionEventType.SessionTitleUpdated, {
      previousTitle: "",
      source: "generated",
      title: "自动标题",
    });
    // 用户重命名（custom）
    log.push(SessionEventType.SessionTitleUpdated, {
      previousTitle: "自动标题",
      source: "custom",
      title: "我的会话",
    });
    // custom 后再来一次 generated —— 应被忽略（custom 粘性）
    log.push(SessionEventType.SessionTitleUpdated, {
      previousTitle: "我的会话",
      source: "generated",
      title: "又一个自动标题",
    });
    const meta = runAll(log.events).projection.getSnapshot().meta;
    expect(meta.title).toBe("我的会话");
    expect(meta.titleSource).toBe("custom");
  });

  it("A/B：SessionTitleUpdated —— first_input 归一为 generated", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    log.push(SessionEventType.SessionTitleUpdated, {
      previousTitle: "",
      source: "first_input",
      title: "首条输入标题",
    });
    const meta = runAll(log.events).projection.getSnapshot().meta;
    expect(meta.title).toBe("首条输入标题");
    expect(meta.titleSource).toBe("generated");
  });

  // ── M4：switchModelConfig（ModelSelected → config 更新 + 中途切换 modelChange marker）──
  it("A/B：ModelSelected 首次 → config 更新，无 marker（首次选型不算切换）", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    log.push(SessionEventType.ModelSelected, {
      modelSelection: { providerId: "e2e-deepseek", modelId: "deepseek-v4-flash" },
      supportedThoughtLevels: ["max", "high", "nothink"],
    });
    const { projection } = runAll(log.events);
    const snapshot = projection.getSnapshot();
    expect(snapshot.config.provider).toBe("e2e-deepseek");
    expect(snapshot.config.model).toBe("deepseek-v4-flash");
    expect(snapshot.config.thoughtLevels).toEqual(["max", "high", "nothink"]);
    // 首次选型不产 modelChange marker。
    expect(
      snapshot.rows.window.some(
        (row) => row.kind === "timelineMarker" && row.marker.type === "modelChange",
      ),
    ).toBe(false);
  });

  it("ModelSelected 分离稀疏 Session Selection 与 effective reasoning 展示事实", () => {
    const log = new EventLog();
    log.push(SessionEventType.ModelSelected, {
      modelSelection: { providerId: "provider-a", modelId: "model-a" },
      effectiveReasoningLevel: "high",
      supportedThoughtLevels: ["low", "high"],
    });

    const snapshot = runAll(log.events).projection.getSnapshot();
    expect(snapshot.config.modelSelection).toEqual({
      providerId: "provider-a",
      modelId: "model-a",
    });
    expect(snapshot.config.thought).toBe("high");
  });

  it("A/B：ModelSelected 中途切换 → config 更新；marker 归 turn 开始（R-17 时机）", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    log.push(SessionEventType.ModelSelected, {
      modelSelection: { providerId: "e2e-deepseek", modelId: "deepseek-v4-flash" },
      supportedThoughtLevels: ["max", "high", "nothink"],
    });
    log.push(SessionEventType.ModelSelected, {
      modelSelection: {
        providerId: "e2e-deepseek",
        modelId: "deepseek-v4-pro",
        options: { reasoningLevel: "max" },
      },
      supportedThoughtLevels: ["max", "nothink"],
    });
    const { projection } = runAll(log.events);
    const snapshot = projection.getSnapshot();
    expect(snapshot.config.model).toBe("deepseek-v4-pro");
    expect(snapshot.config.thought).toBe("max");
    expect(snapshot.config.thoughtLevels).toEqual(["max", "nothink"]);
    // R-17 时机修复（2026-07-07）：切换动作本身不落 marker——尚未有 turn 使用过
    // 任何模型（草稿态截图 bug：首条消息上方挂 [modelChange]）。
    expect(
      snapshot.rows.window.some(
        (row) => row.kind === "timelineMarker" && row.marker.type === "modelChange",
      ),
    ).toBe(false);
  });

  it("I56：registry fallback 投影稳定事件与起止模型，显式切换不伪造来源", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    log.push(SessionEventType.ModelSelected, {
      modelSelection: { providerId: "provider-a", modelId: "model-a" },
    });
    const fallbackEvent = log.push(SessionEventType.ModelSelected, {
      modelSelection: {
        providerId: "provider-b",
        modelId: "model-b",
        options: { reasoningLevel: "deep" },
      },
      previousModelSelection: { providerId: "provider-a", modelId: "model-a" },
      origin: "registryFallback",
    });

    const { projection } = runAll(log.events);
    expect(projection.getSnapshot().modelTransition).toEqual({
      eventId: fallbackEvent.id,
      origin: "registryFallback",
      from: { provider: "provider-a", model: "model-a" },
      to: { provider: "provider-b", model: "model-b" },
    });

    projection.applyEvent(
      log.push(SessionEventType.ModelSelected, {
        modelSelection: { providerId: "provider-c", modelId: "model-c" },
        previousModelSelection: {
          providerId: "provider-b",
          modelId: "model-b",
          options: { reasoningLevel: "deep" },
        },
      }),
    );
    expect(projection.getSnapshot().modelTransition?.eventId).toBe(fallbackEvent.id);
  });

  it("A/B：历史会话切换模型后立即刷新 context window 分母并保留已用量", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    log.push(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: "history" },
      { turnId: "turn-1" },
    );
    log.push(
      SessionEventType.ModelComplete,
      {
        content: "done",
        stopReason: "end_turn",
        querySource: "main_turn",
        contextWindow: 200_000,
        usage: { inputTokens: 120, outputTokens: 30 },
      },
      { turnId: "turn-1" },
    );
    const { projection } = runAll(log.events);
    expect(projection.getSnapshot().usage.contextWindow).toMatchObject({
      usedTokens: 150,
      maxTokens: 200_000,
    });

    projection.applyEvent(
      log.push(SessionEventType.ModelSelected, {
        modelSelection: {
          providerId: "deepseek",
          modelId: "deepseek-v4-flash",
          options: { reasoningLevel: "max" },
        },
        supportedThoughtLevels: ["max", "high", "nothink"],
      }),
    );
    // 旧持久化事件没有 contextWindow，重放时保持既有分母，不能清零。
    expect(projection.getSnapshot().usage.contextWindow).toMatchObject({
      usedTokens: 150,
      maxTokens: 200_000,
    });

    projection.applyEvent(
      log.push(SessionEventType.ModelSelected, {
        modelSelection: {
          providerId: "deepseek",
          modelId: "deepseek-v4-flash",
          options: { reasoningLevel: "max" },
        },
        contextWindow: 1_000_000,
        supportedThoughtLevels: ["max", "high", "nothink"],
      }),
    );

    // 修复目标：模型切换事件本身就是 runtime 新能力的权威提交点；不等下一轮发送完成。
    expect(projection.getSnapshot().usage.contextWindow).toMatchObject({
      usedTokens: 150,
      maxTokens: 1_000_000,
    });

    projection.applyEvent(
      log.push(
        SessionEventType.ModelComplete,
        {
          content: "next",
          stopReason: "end_turn",
          querySource: "main_turn",
          usage: { inputTokens: 160, outputTokens: 40 },
        },
        { turnId: "turn-2" },
      ),
    );
    // 后续旧 adapter 未携带 contextWindow 时，也必须回退到刚切换后的新窗口。
    expect(projection.getSnapshot().usage.contextWindow).toMatchObject({
      usedTokens: 200,
      maxTokens: 1_000_000,
    });
  });

  it("A/B：清除 context window 后持续隐藏分母并在容量恢复时保留最新已用量", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    log.push(
      SessionEventType.ModelComplete,
      {
        content: "before clear",
        stopReason: "end_turn",
        querySource: "main_turn",
        contextWindow: 200_000,
        usage: { inputTokens: 120, outputTokens: 30 },
      },
      { turnId: "turn-1" },
    );
    const { projection } = runAll(log.events);

    projection.applyEvent(
      log.push(SessionEventType.ModelSelected, {
        modelSelection: { providerId: "custom", modelId: "unknown-context-model" },
        contextWindow: null,
      }),
    );
    expect(projection.getSnapshot().usage.contextWindow).toBeNull();

    projection.applyEvent(
      log.push(
        SessionEventType.ModelComplete,
        {
          content: "while unknown",
          stopReason: "end_turn",
          querySource: "main_turn",
          usage: { inputTokens: 160, outputTokens: 40 },
        },
        { turnId: "turn-2" },
      ),
    );
    expect(projection.getSnapshot().usage.contextWindow).toBeNull();
    expect(projection.getSnapshot().usage.cumulative).toMatchObject({
      inputTokens: 280,
      outputTokens: 70,
    });

    projection.applyEvent(
      log.push(SessionEventType.ModelSelected, {
        modelSelection: { providerId: "custom", modelId: "unknown-context-model" },
        contextWindow: 1_000_000,
      }),
    );
    expect(projection.getSnapshot().usage.contextWindow).toMatchObject({
      usedTokens: 200,
      maxTokens: 1_000_000,
    });
  });

  it("A/B：显式清除窗口后 hydration seed 只恢复用量而不覆盖容量", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    log.push(SessionEventType.ModelSelected, {
      modelSelection: { providerId: "custom", modelId: "unknown-context-model" },
      contextWindow: null,
    });
    const { projection } = runAll(log.events);

    projection.seedUsage({
      contextWindow: {
        usedTokens: 999,
        maxTokens: 200_000,
        autoCompactThresholdTokens: null,
      },
      cumulative: {
        inputTokens: 700,
        outputTokens: 50,
        cacheReadTokens: 20,
        cacheWriteTokens: 10,
      },
    });
    expect(projection.getSnapshot().usage.contextWindow).toBeNull();
    expect(projection.getSnapshot().usage.cumulative).toEqual({
      inputTokens: 700,
      outputTokens: 50,
      cacheReadTokens: 20,
      cacheWriteTokens: 10,
    });

    projection.applyEvent(
      log.push(SessionEventType.ModelSelected, {
        modelSelection: { providerId: "custom", modelId: "unknown-context-model" },
        contextWindow: 1_000_000,
      }),
    );
    expect(projection.getSnapshot().usage.contextWindow).toMatchObject({
      usedTokens: 999,
      maxTokens: 1_000_000,
    });
  });

  it("Todo123: 未知容量种子保留用量，后续容量恢复不归零", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default" });
    const { projection } = runAll(log.events);
    projection.seedUsage({
      contextWindow: { usedTokens: 29908, maxTokens: null, autoCompactThresholdTokens: null },
    });
    expect(projection.getSnapshot().usage.contextWindow).toBeNull();
    projection.applyEvent(
      log.push(SessionEventType.ModelSelected, {
        modelSelection: { providerId: "glm", modelId: "GLM-5.3-Flash" },
        contextWindow: 1_000_000,
      }),
    );
    expect(projection.getSnapshot().usage.contextWindow).toMatchObject({
      usedTokens: 29908,
      maxTokens: 1_000_000,
    });
  });

  it("Todo123: 未知容量期间真实用量优先，迟到恢复种子不能覆盖", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default" });
    log.push(SessionEventType.ModelSelected, {
      modelSelection: { providerId: "glm", modelId: "GLM-5.3-Flash" },
      contextWindow: null,
    });
    log.push(SessionEventType.ModelComplete, {
      content: "",
      stopReason: "end_turn",
      querySource: "main_turn",
      usage: { inputTokens: 700, outputTokens: 30 },
    });
    const { projection } = runAll(log.events);
    projection.seedUsage({
      contextWindow: { usedTokens: 29908, maxTokens: null, autoCompactThresholdTokens: null },
    });
    projection.applyEvent(
      log.push(SessionEventType.ModelSelected, {
        modelSelection: { providerId: "glm", modelId: "GLM-5.3-Flash" },
        contextWindow: 1_000_000,
      }),
    );
    expect(projection.getSnapshot().usage.contextWindow).toMatchObject({
      usedTokens: 730,
      maxTokens: 1_000_000,
    });
  });

  // ── M4：cancelBackgroundWork（BackgroundTask* → backgroundWorks 投影）──
  it("A/B：BackgroundTaskStarted → backgroundWorks 出现 running 项，Completed(cancelled) → cancelled", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    log.push(SessionEventType.BackgroundTaskStarted, {
      taskId: "bg-1",
      toolName: "Bash",
      command: "sleep 100",
      description: "长任务",
      status: "running",
    });
    let snapshot = runAll(log.events).projection.getSnapshot();
    expect(snapshot.backgroundWorks).toHaveLength(1);
    expect(snapshot.backgroundWorks[0]!.workId).toBe("bg-1");
    expect(snapshot.backgroundWorks[0]!.kind).toBe("bash");
    expect(snapshot.backgroundWorks[0]!.title).toBe("长任务");
    expect(snapshot.backgroundWorks[0]!.status).toBe("running");

    // 取消 → cancelled
    log.push(SessionEventType.BackgroundTaskCompleted, {
      taskId: "bg-1",
      toolName: "Bash",
      status: "cancelled",
    });
    snapshot = runAll(log.events).projection.getSnapshot();
    expect(snapshot.backgroundWorks).toHaveLength(1);
    expect(snapshot.backgroundWorks[0]!.status).toBe("cancelled");
  });

  it("A/B：真实 Agent 后台事件使用 runtime taskKind，且旧 Agent 事件兼容为 subagent", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    log.push(SessionEventType.BackgroundTaskStarted, {
      taskId: "bg-2",
      toolName: "Agent",
      taskKind: "subagent",
      childSessionId: "sess_child_bg_2",
      description: "子代理",
      status: "running",
      cancellable: true,
    });
    let snapshot = runAll(log.events).projection.getSnapshot();
    expect(snapshot.backgroundWorks[0]).toMatchObject({
      kind: "subagent",
      childSessionId: "sess_child_bg_2",
      cancellable: true,
      status: "running",
      title: "子代理",
    });

    log.push(SessionEventType.BackgroundTaskCompleted, {
      taskId: "bg-2",
      toolName: "Agent",
      taskKind: "subagent",
      status: "completed",
      cancellable: false,
    });
    snapshot = runAll(log.events).projection.getSnapshot();
    expect(snapshot.backgroundWorks[0]).toMatchObject({
      kind: "subagent",
      childSessionId: "sess_child_bg_2",
      cancellable: false,
      status: "resultPending",
    });

    const lateIdentity = new EventLog();
    lateIdentity.push(SessionEventType.SessionCreated, {
      mode: "default",
      contextWindow: 200_000,
    });
    lateIdentity.push(SessionEventType.BackgroundTaskStarted, {
      taskId: "late-child-id",
      toolName: "Agent",
      taskKind: "subagent",
      description: "晚到身份",
      status: "running",
      cancellable: true,
    });
    lateIdentity.push(SessionEventType.BackgroundTaskUpdated, {
      taskId: "late-child-id",
      toolName: "Agent",
      taskKind: "subagent",
      childSessionId: "sess_child_late",
      description: "晚到身份",
      status: "running",
      cancellable: true,
    });
    expect(runAll(lateIdentity.events).projection.getSnapshot().backgroundWorks[0]).toMatchObject({
      childSessionId: "sess_child_late",
      status: "running",
    });

    const legacy = new EventLog();
    legacy.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    legacy.push(SessionEventType.BackgroundTaskStarted, {
      taskId: "legacy-agent",
      toolName: "Agent",
      description: "旧子代理",
      status: "running",
    });
    legacy.push(SessionEventType.BackgroundTaskUpdated, {
      taskId: "legacy-agent",
      status: "running",
    });
    legacy.push(SessionEventType.BackgroundTaskCompleted, {
      taskId: "legacy-agent",
      status: "completed",
    });
    expect(runAll(legacy.events).projection.getSnapshot().backgroundWorks[0]).toMatchObject({
      kind: "subagent",
      status: "resultPending",
      title: "旧子代理",
    });

    const explicit = new EventLog();
    explicit.push(SessionEventType.SessionCreated, {
      mode: "default",
      contextWindow: 200_000,
    });
    explicit.push(SessionEventType.BackgroundTaskStarted, {
      taskId: "explicit-bash",
      // taskKind 是新事实；即使旧 toolName 数据矛盾也不得反向覆盖。
      taskKind: "bash",
      toolName: "Agent",
      description: "显式进程",
      status: "running",
    });
    expect(runAll(explicit.events).projection.getSnapshot().backgroundWorks[0]!.kind).toBe("bash");
  });

  // ── M4：RewindTriggered → row.removed（editUserQuery/retryTurn 的 live 截断）──
  it("D/G：RewindTriggered(targetMessageId) 从目标 turn 首行整段移除", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    // turn1
    log.push(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: "第一问", messageId: "msg-u1" },
      { turnId: "t1" },
    );
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_start", delta: "", done: false, assistantMessageId: "msg-a1" },
      { turnId: "t1" },
    );
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_delta", delta: "第一答", done: false, assistantMessageId: "msg-a1" },
      { turnId: "t1" },
    );
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_end", delta: "", done: false },
      { turnId: "t1" },
    );
    log.push(
      SessionEventType.TurnComplete,
      { response: "", tokenCount: 0, toolCallCount: 0, duration: 0, resultType: "success" },
      { turnId: "t1" },
    );
    // turn2
    log.push(
      SessionEventType.TurnStarted,
      { turnNumber: 2, input: "第二问", messageId: "msg-u2" },
      { turnId: "t2" },
    );
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_start", delta: "", done: false, assistantMessageId: "msg-a2" },
      { turnId: "t2" },
    );
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_delta", delta: "第二答", done: false, assistantMessageId: "msg-a2" },
      { turnId: "t2" },
    );
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_end", delta: "", done: false },
      { turnId: "t2" },
    );
    log.push(
      SessionEventType.TurnComplete,
      { response: "", tokenCount: 0, toolCallCount: 0, duration: 0, resultType: "success" },
      { turnId: "t2" },
    );
    // rewind 到 turn2 的 assistant 消息 → 整个 turn2 被移除。
    // createdMessageId = applied 语义（unavailable/workspace 回滚不带，投影必须忽略）。
    log.push(SessionEventType.RewindTriggered, {
      targetMessageId: "msg-a2",
      scope: "conversation",
      createdMessageId: "msg-rewind-notice",
    });

    const { projection } = runAll(log.events);
    const texts = projection
      .getSnapshot()
      .rows.window.filter((r) => r.kind === "userInput" || r.kind === "assistantText")
      .map((r) => (r.kind === "userInput" || r.kind === "assistantText" ? r.text : ""));
    // turn1 保留，turn2 整段被移除。
    expect(texts).toEqual(["第一问", "第一答"]);
    // 被移除的用户实体不可再解析为编辑目标。
    expect(projection.resolveEditTargetByEntityId("msg-u2")).toBeNull();
    expect(projection.resolveEditTargetByEntityId("msg-u1")).toMatchObject({
      entityId: "msg-u1",
      transcriptMessageId: "msg-u1",
    });
  });

  it("PV4-10 回归：首轮 edit rewind 后分页首行切换到新 active branch", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    log.push(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: "你好", messageId: "msg-u1" },
      { turnId: "t1" },
    );
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_start", delta: "", done: false, assistantMessageId: "msg-a1" },
      { turnId: "t1" },
    );
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_delta", delta: "旧回答", done: false, assistantMessageId: "msg-a1" },
      { turnId: "t1" },
    );
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_end", delta: "", done: false },
      { turnId: "t1" },
    );
    log.push(
      SessionEventType.TurnComplete,
      { response: "", tokenCount: 0, toolCallCount: 0, duration: 0, resultType: "success" },
      { turnId: "t1" },
    );
    const original = runAll(log.events).projection.getSnapshot();
    const originalMaxRowId = Math.max(...original.rows.window.map((row) => row.rowId));

    log.push(SessionEventType.RewindTriggered, {
      targetMessageId: "msg-u1",
      scope: "conversation",
      branchCutAfterMessageId: "msg-a1",
      branchGeneration: 1,
    });
    const rewound = runAll(log.events).projection.getSnapshot();
    expect(rewound.rows).toEqual({ window: [], totalCount: 0, firstRowId: null });

    log.push(
      SessionEventType.TurnStarted,
      { turnNumber: 2, input: "你是谁", messageId: "msg-u2" },
      { turnId: "t2" },
    );
    const rerun = runAll(log.events).projection.getSnapshot();
    const newFirstRow = rerun.rows.window[0]!;
    expect(newFirstRow.rowId).toBeGreaterThan(originalMaxRowId);
    expect(rerun.rows.firstRowId).toBe(newFirstRow.rowId);
    expect(rerun.rows.totalCount).toBe(rerun.rows.window.length);
  });

  it("D：getTurnRewindAnchor(user 行 rowId) → 同 turn 的 assistant messageId", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "问" }, { turnId: "t1" });
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_start", delta: "", done: false, assistantMessageId: "msg-a1" },
      { turnId: "t1" },
    );
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_delta", delta: "答", done: false, assistantMessageId: "msg-a1" },
      { turnId: "t1" },
    );
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_end", delta: "", done: false },
      { turnId: "t1" },
    );
    const { projection } = runAll(log.events);
    const userRow = projection.getSnapshot().rows.window.find((r) => r.kind === "userInput");
    expect(userRow).toBeDefined();
    // user 行自身无 messageId，但同 turn 的 assistant messageId 作 rewind 锚点。
    expect(projection.getMessageIdForRow(userRow!.rowId)).toBeNull();
    expect(projection.getTurnRewindAnchor(userRow!.rowId)).toBe("msg-a1");
  });

  it("D/G：RewindTriggered 目标 messageId 无法反查（user 行无 messageId）→ 不误删", () => {
    const log = new EventLog();
    basicTurnEvents(log);
    const before = runAll(log.events).projection.getSnapshot().rows.window.length;
    log.push(SessionEventType.RewindTriggered, {
      targetMessageId: "unknown-msg",
      scope: "conversation",
      createdMessageId: "msg-rewind-notice",
    });
    const after = runAll(log.events).projection.getSnapshot().rows.window.length;
    expect(after).toBe(before);
  });

  it("D/E09 回归：unavailable rewind（无 createdMessageId）与 workspace 回滚不得截断 live 行", () => {
    // Bugfix 回归（2026-07-06 case catalog 战役）：finishUnavailable 也发 RewindTriggered，
    // 投影曾不加区分地截断 live 行——store/模型上下文却保留旧分支（假截断），
    // fork child / 刷新 hydration 随后把旧分支复活（E09 失败形态）。
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "问" }, { turnId: "t1" });
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_start", delta: "", done: false, assistantMessageId: "msg-a1" },
      { turnId: "t1" },
    );
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_delta", delta: "答", done: false, assistantMessageId: "msg-a1" },
      { turnId: "t1" },
    );
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_end", delta: "", done: false },
      { turnId: "t1" },
    );
    log.push(
      SessionEventType.TurnComplete,
      { response: "", tokenCount: 0, toolCallCount: 0, duration: 0, resultType: "success" },
      { turnId: "t1" },
    );
    const beforeRows = runAll(log.events).projection.getSnapshot().rows.window.length;
    expect(beforeRows).toBeGreaterThan(0);
    // unavailable conversation rewind（无 createdMessageId）
    log.push(SessionEventType.RewindTriggered, {
      targetMessageId: "msg-a1",
      scope: "conversation",
      strategy: "unavailable",
      reason: "target_message_is_not_user_prompt",
    });
    // workspace 文件回滚（带 createdMessageId 但 scope=workspace）
    log.push(SessionEventType.RewindTriggered, {
      targetMessageId: "msg-a1",
      scope: "workspace",
      createdMessageId: "msg-ws-notice",
    });
    const after = runAll(log.events).projection.getSnapshot().rows.window.length;
    expect(after).toBe(beforeRows);
  });

  it("O10：ModelComplete.fileChanges 更新 turn header 摘要", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "改文件" }, { turnId: "t1" });
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
          additions: 2,
          deletions: 1,
          items: [{ path: "/work/src/demo.ts", additions: 2, deletions: 1, writeCount: 2 }],
        },
      },
      { turnId: "t1" },
    );
    log.push(
      SessionEventType.TurnComplete,
      { response: "done", tokenCount: 2, toolCallCount: 0, duration: 1, resultType: "success" },
      { turnId: "t1" },
    );

    const { projection } = runAll(log.events);
    const header = projection.getSnapshot().rows.window.find((row) => row.kind === "turnHeader");
    expect(header).toMatchObject({
      kind: "turnHeader",
      fileChanges: {
        additions: 2,
        deletions: 1,
        files: 1,
        state: "active",
      },
      actions: { canRewindFiles: true },
    });
    const target = { rowId: header!.rowId, entityId: header!.entityId! };
    expect(projection.resolveRowActionTarget(target, "applyFileRewind")).toMatchObject({
      ok: true,
    });

    projection.applyEvent(
      new EventLog().push(SessionEventType.CompactStarted, {
        operationId: "compact-files",
        messageId: "compact-files-message",
        status: "started",
        trigger: "manual",
        display: "separator",
      }),
    );
    const lockedHeader = projection
      .getSnapshot()
      .rows.window.find((row) => row.rowId === header!.rowId)!;
    expect(lockedHeader.actions?.canRewindFiles).toBe(true);
    expect(projection.getSnapshot().availability.rewindFiles).toEqual({
      allowed: false,
      reasonCode: "compactOperationLock",
    });
    expect(projection.resolveRowActionTarget(target, "applyFileRewind")).toEqual({
      ok: false,
      status: "rejected",
      reasonCode: "guard.actionUnavailable",
    });
  });

  it("O10：subagent ModelComplete 只更新 child turn 文件摘要，不覆盖 usage", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    log.push(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: "子会话改文件" },
      { turnId: "t1" },
    );
    log.push(
      SessionEventType.ModelComplete,
      {
        content: "done",
        stopReason: "stop",
        querySource: "subagent",
        contextWindow: 999_999,
        usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5 },
        fileChanges: {
          files: 1,
          additions: 1,
          deletions: 0,
          items: [{ path: "/work/src/child.ts", additions: 1, deletions: 0, writeCount: 1 }],
        },
      },
      { turnId: "t1" },
    );
    log.push(
      SessionEventType.TurnComplete,
      { response: "done", tokenCount: 150, toolCallCount: 1, duration: 1, resultType: "success" },
      { turnId: "t1" },
    );

    const { projection } = runAll(log.events);
    const snapshot = projection.getSnapshot();
    const header = snapshot.rows.window.find((row) => row.kind === "turnHeader");
    expect(header).toMatchObject({
      kind: "turnHeader",
      fileChanges: {
        additions: 1,
        deletions: 0,
        files: 1,
        state: "active",
      },
      actions: { canRewindFiles: true },
    });
    expect(snapshot.usage.cumulative).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it("O10：普通 TurnStarted 的 user messageId 进入同轮文件摘要锚点", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    log.push(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: "改文件", messageId: "msg-user-1" },
      { turnId: "t1" },
    );

    const { projection } = runAll(log.events);
    const header = projection.getSnapshot().rows.window.find((row) => row.kind === "turnHeader");
    expect(header).toBeDefined();
    expect(projection.getMessageIdsForTurnRow(header!.rowId)).toContain("msg-user-1");
  });

  it("O12：workspace 文件撤销只标记 fileChanges.reverted，不移除聊天行", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "改文件" }, { turnId: "t1" });
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_start", delta: "", done: false, assistantMessageId: "msg-a1" },
      { turnId: "t1" },
    );
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_delta", delta: "已改", done: false, assistantMessageId: "msg-a1" },
      { turnId: "t1" },
    );
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_end", delta: "", done: false },
      { turnId: "t1" },
    );
    log.push(
      SessionEventType.ModelComplete,
      {
        content: "已改",
        stopReason: "stop",
        querySource: "main_turn",
        contextWindow: 200_000,
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        fileChanges: {
          files: 1,
          additions: 2,
          deletions: 1,
          items: [{ path: "/work/src/demo.ts", additions: 2, deletions: 1, writeCount: 1 }],
        },
      },
      { turnId: "t1" },
    );
    log.push(
      SessionEventType.TurnComplete,
      { response: "已改", tokenCount: 1, toolCallCount: 1, duration: 10, resultType: "success" },
      { turnId: "t1" },
    );
    const before = runAll(log.events).projection.getSnapshot().rows.window;
    log.push(SessionEventType.RewindTriggered, {
      targetMessageId: "msg-a1",
      scope: "workspace",
      reason: "file_summary_rewind",
    });

    const { projection } = runAll(log.events);
    const rows = projection.getSnapshot().rows.window;
    expect(rows).toHaveLength(before.length);
    const header = rows.find((row) => row.kind === "turnHeader");
    expect(header).toMatchObject({
      kind: "turnHeader",
      fileChanges: {
        additions: 2,
        deletions: 1,
        files: 1,
        state: "reverted",
      },
    });
    expect(rows.some((row) => row.kind === "assistantText" && row.text === "已改")).toBe(true);
  });
});

// ── M5④ 附件渲染：TurnStarted.attachments → userInput row.attachments ──
describe("userInput 附件投影（M5④）", () => {
  it("TurnStarted 携带附件元信息 → row.attachments 保真映射且 schema 合法", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, {
      mode: "default",
      contextWindow: 200_000,
    });
    log.push(
      SessionEventType.TurnStarted,
      {
        turnNumber: 1,
        input: "看看这张图",
        inputId: "command-start-now",
        intent: {
          sourceCommandId: "command-start-now",
          queueItemId: "queue_command-start-now",
          clientId: "desktop-client",
          kind: "sendText",
          admissionSeq: 3,
          admittedAt: 100,
          requestedDelivery: "startNow",
          admittedDelivery: "startNow",
        },
        attachments: [
          {
            fileName: "screenshot.png",
            mime: "image/png",
            bytes: 12345,
            ref: "/tmp/screenshot.png",
          },
          // 无稳定引用（data URL 内联）：ref 缺省 → 投影生成行内占位。
          { fileName: "notes.md", mime: "text/markdown", bytes: 42 },
        ],
      },
      { turnId: "turn-1" },
    );
    const { projection } = runAll(log.events);
    const snapshot = projection.getSnapshot();
    expect(() => conversationSnapshotSchema.parse(snapshot)).not.toThrow();

    const userInput = snapshot.rows.window.find((row) => row.kind === "userInput");
    expect(userInput).toBeDefined();
    expect(userInput).toMatchObject({
      sourceCommandId: "command-start-now",
      clientId: "desktop-client",
    });
    const attachments = userInput?.kind === "userInput" ? userInput.attachments : undefined;
    expect(attachments).toHaveLength(2);
    expect(attachments?.[0]).toEqual({
      ref: "/tmp/screenshot.png",
      fileName: "screenshot.png",
      mime: "image/png",
      bytes: 12345,
    });
    expect(attachments?.[1]).toMatchObject({
      fileName: "notes.md",
      mime: "text/markdown",
      bytes: 42,
    });
    expect(attachments?.[1]?.ref).toMatch(/^turn-attachment\//);
  });

  it("无附件的 TurnStarted：row 不带 attachments 键（缺省语义）", () => {
    const log = new EventLog();
    basicTurnEvents(log);
    const { projection } = runAll(log.events);
    const userInput = projection.getSnapshot().rows.window.find((row) => row.kind === "userInput");
    expect(userInput?.kind === "userInput" ? "attachments" in userInput : null).toBe(false);
  });
});

// R-19（10 §4.2.3）：config 种子——投影初值 = runtime 真值，种子不产 delta / 不 bump
// revision，事件触碰过的字段不接受种子覆盖（"最终值以日志为准"）。
// Bug 背景（2026-07-07 v4 桌面首测）：初始 config 写死空 provider/model + mode=build，
// 导致新会话模型选择器显示空、持久化 mode=yolo 时 UI 停在 build 且点 yolo 静默 no-op。
describe("config 种子（R-19）", () => {
  const SEED = {
    provider: "prov-a",
    model: "model-1",
    thought: "high",
    thoughtLevels: ["high", "max", "nothink"],
    mode: "yolo",
  };

  it("种子填充空初值：config 就位、revision/seq 不动、schema 合法", () => {
    const projection = new ProductProjection("session-1", "epoch-1");
    projection.seedConfig(SEED);
    const snapshot = projection.getSnapshot();
    expect(snapshot.config).toMatchObject({
      provider: "prov-a",
      model: "model-1",
      thought: "high",
      thoughtLevels: ["high", "max", "nothink"],
      mode: "yolo",
    });
    expect(snapshot.revision).toBe(0);
    expect(snapshot.seq).toBe(0);
    expect(() => conversationSnapshotSchema.parse(snapshot)).not.toThrow();
  });

  it("种子后事件覆盖：ModelSelected / SessionModeChanged 的日志值优先", () => {
    const projection = new ProductProjection("session-1", "epoch-1");
    projection.seedConfig(SEED);
    const log = new EventLog();
    log.push(SessionEventType.ModelSelected, {
      modelSelection: {
        providerId: "prov-b",
        modelId: "model-2",
        options: { reasoningLevel: "low" },
      },
      supportedThoughtLevels: ["low", "high"],
    });
    log.push(SessionEventType.SessionModeChanged, {
      mode: "plan",
      previousMode: "yolo",
      source: "command",
    });
    for (const event of log.events) projection.applyEvent(event);
    expect(projection.getSnapshot().config).toMatchObject({
      provider: "prov-b",
      model: "model-2",
      thought: "low",
      thoughtLevels: ["low", "high"],
      mode: "plan",
    });
    projection.seedConfig({ ...SEED, thoughtLevels: ["disabled"] });
    expect(projection.getSnapshot().config.thoughtLevels).toEqual(["low", "high"]);
  });

  it("事件后种子不覆盖：冷恢复重放序在前时日志值保持权威", () => {
    const projection = new ProductProjection("session-1", "epoch-1");
    const log = new EventLog();
    log.push(SessionEventType.ModelSelected, {
      modelSelection: { providerId: "prov-b", modelId: "model-2" },
    });
    log.push(SessionEventType.SessionModeChanged, {
      mode: "plan",
      previousMode: "build",
      source: "tool",
    });
    for (const event of log.events) projection.applyEvent(event);
    projection.seedConfig(SEED);
    expect(projection.getSnapshot().config).toMatchObject({
      provider: "prov-b",
      model: "model-2",
      thoughtLevels: ["high", "max", "nothink"],
      mode: "plan",
    });
  });

  it("分区独立：只有 mode 被事件触碰时，模型区仍接受种子（反之亦然）", () => {
    const projection = new ProductProjection("session-1", "epoch-1");
    const log = new EventLog();
    log.push(SessionEventType.SessionModeChanged, {
      mode: "plan",
      previousMode: "build",
      source: "command",
    });
    for (const event of log.events) projection.applyEvent(event);
    projection.seedConfig(SEED);
    const config = projection.getSnapshot().config;
    // mode 由日志裁决，模型区来自种子（历史会话恢复：resume 已把上次选型写回 runtime）。
    expect(config.mode).toBe("plan");
    expect(config).toMatchObject({
      provider: "prov-a",
      model: "model-1",
      thought: "high",
      thoughtLevels: ["high", "max", "nothink"],
    });
  });

  it("相同种子幂等，明确留空的恢复结果清除旧模型", () => {
    const projection = new ProductProjection("session-1", "epoch-1");
    projection.seedConfig(SEED);
    const first = projection.getSnapshot();
    projection.seedConfig(SEED);
    expect(projection.getSnapshot()).toBe(first);
    // 恢复结果明确留空，不能继续显示历史消息留下的模型。
    projection.seedConfig({ provider: "", model: "", mode: "" });
    expect(projection.getSnapshot().config).toMatchObject({
      provider: "",
      model: "",
    });
  });

  it("分享上下文导入种子只写只读来源元数据，不生成可见对话行", () => {
    const projection = new ProductProjection("session-1", "epoch-1");
    const before = projection.getSnapshot();

    projection.seedSharedContextImport({ title: "筛选近一年收益前10%的偏股混合基金" });

    const snapshot = projection.getSnapshot();
    expect(snapshot.sharedContextImport).toEqual({
      title: "筛选近一年收益前10%的偏股混合基金",
    });
    expect(snapshot.rows.window).toEqual([]);
    expect(snapshot.revision).toBe(before.revision);
    expect(snapshot.seq).toBe(before.seq);
    expect(() => conversationSnapshotSchema.parse(snapshot)).not.toThrow();
  });
});

// ── 16-timeline-authority-plan P2：productTurn 切分 / goalVerify 身份与落位 ──

describe("P2 productTurn 切分（S1/S3/S5）", () => {
  const drainScenario = (delivery: "queue" | "guide") => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    log.push(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: "问题一" },
      { turnId: "turn-1" },
    );
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_start", delta: "", done: false },
      { turnId: "turn-1" },
    );
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_delta", delta: "回答一", done: false },
      { turnId: "turn-1" },
    );
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_end", delta: "", done: false },
      { turnId: "turn-1" },
    );
    log.push(
      SessionEventType.TurnSteerQueued,
      {
        pendingInputId: "p-q2",
        input: "问题二",
        inputPreview: "问题二",
        inputSize: 9,
        delivery,
        targetTurnId: "turn-1",
        queueLength: 1,
      },
      { turnId: "turn-1" },
    );
    log.push(
      SessionEventType.TurnSteerDrained,
      {
        pendingInputIds: ["p-q2"],
        injectedMessageIds: ["msg-q2"],
        drainedInputs: [
          {
            pendingInputId: "p-q2",
            messageId: "msg-q2",
            text: "问题二",
            delivery,
            intent: {
              sourceCommandId: "command-q2",
              queueItemId: "p-q2",
              clientId: "desktop-continuous",
              kind: delivery === "guide" ? "sendGoalCommand" : "sendText",
              text: "问题二",
              admissionSeq: 2,
              admittedAt: 1_700_000_006_000,
              requestedDelivery: "auto",
              admittedDelivery: delivery,
              fallbackReasonCode: "runtime.turnBusy",
              attachmentRefs: [
                {
                  ref: "artifact://q2",
                  fileName: "q2.txt",
                  mime: "text/plain",
                  bytes: 3,
                },
              ],
              provenance: {
                sourceCommandId: "command-q2-original",
                queueItemId: "p-q2-original",
                clientId: "desktop-continuous",
              },
            },
          },
        ],
        targetTurnId: "turn-1",
      },
      { turnId: "turn-1" },
    );
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_start", delta: "", done: false },
      { turnId: "turn-1" },
    );
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_delta", delta: "回答二", done: false },
      { turnId: "turn-1" },
    );
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_end", delta: "", done: false },
      { turnId: "turn-1" },
    );
    log.push(
      SessionEventType.TurnComplete,
      { response: "", tokenCount: 0, toolCallCount: 0, duration: 9000, resultType: "success" },
      { turnId: "turn-1" },
    );
    return runAll(log.events);
  };

  it("QD-node：queue drain 切新 productTurn，两段回复都可见、工时按边界拆分（Case A 根修）", () => {
    const { projection } = drainScenario("queue");
    const snapshot = projection.getSnapshot();
    expect(() => conversationSnapshotSchema.parse(snapshot)).not.toThrow();
    const rows = snapshot.rows.window;

    // 两个 turnHeader：首轮 legacy runtime id 与 promoted user messageId（稳定 productTurn）。
    const headers = rows.filter((row) => row.kind === "turnHeader");
    expect(headers.map((row) => row.turnId)).toEqual(["turn-1", "msg-q2"]);
    // 第一段 header 在 drain 边界收口：activeMs = drain(7s) - start(2s)。
    expect(headers[0]).toMatchObject({ state: "completedSuccess", activeMs: 5000 });
    // 第二段 header 在 TurnComplete 收口：activeMs = complete(11s) - drain(7s)，
    // 不再是整段 runtime duration（9000）。
    expect(headers[1]).toMatchObject({ state: "completedSuccess", activeMs: 4000 });

    // 两段 assistant 正文都在，各归自己的 productTurn——A1 不再被折进上一轮 history。
    const assistantRows = rows.filter((row) => row.kind === "assistantText");
    expect(
      assistantRows.map((row) => [row.turnId, row.kind === "assistantText" ? row.text : ""]),
    ).toEqual([
      ["turn-1", "回答一"],
      ["msg-q2", "回答二"],
    ]);

    // drained user 行归新 productTurn，并原子登记 message/entity/edit target。
    const drainedUser = rows.find((row) => row.kind === "userInput" && row.text === "问题二");
    expect(drainedUser?.turnId).toBe("msg-q2");
    expect(projection.getMessageIdForRow(drainedUser!.rowId)).toBe("msg-q2");
    expect(projection.getEntityIdForRow(drainedUser!.rowId)).toBe("msg-q2");
    expect(drainedUser?.actions).toMatchObject({ canEdit: true, editDisposition: "rewind" });
    expect(
      projection.resolveRowActionTarget(
        { rowId: drainedUser!.rowId, entityId: drainedUser!.entityId },
        "editUserQuery",
      ),
    ).toMatchObject({
      ok: true,
      editTarget: {
        entityId: "msg-q2",
        productTurnId: "msg-q2",
        transcriptMessageId: "msg-q2",
        intent: {
          kind: "sendText",
          text: "问题二",
          sourceCommandId: "command-q2",
          queueItemId: "p-q2",
          clientId: "desktop-continuous",
          admissionSeq: 2,
          admittedAt: 1_700_000_006_000,
          requestedDelivery: "auto",
          admittedDelivery: "queue",
          fallbackReasonCode: "runtime.turnBusy",
          attachments: [
            {
              ref: "artifact://q2",
              fileName: "q2.txt",
              mime: "text/plain",
              bytes: 3,
            },
          ],
          provenance: {
            sourceCommandId: "command-q2-original",
            queueItemId: "p-q2-original",
            clientId: "desktop-continuous",
          },
        },
      },
    });
    const coldLog = new EventLog();
    coldLog.push(
      SessionEventType.TurnStarted,
      { turnNumber: 2, input: "问题二", messageId: "msg-q2" },
      { turnId: "hydrate-turn-2" },
    );
    const coldUser = runAll(coldLog.events)
      .projection.getSnapshot()
      .rows.window.find((row) => row.kind === "userInput");
    // 同一 promoted user transcript 在 live drain 与 cold TurnStarted 中使用同一 productTurnId。
    expect(coldUser?.turnId).toBe(drainedUser?.turnId);
    expect(snapshot.queue.items).toEqual([]);
  });

  it("P06：guide steer 内联不切轮，但 accepted guide 开启独立可恢复工时段", () => {
    const { projection } = drainScenario("guide");
    const snapshot = projection.getSnapshot();
    const rows = snapshot.rows.window;
    const headers = rows.filter((row) => row.kind === "turnHeader");
    expect(headers.map((row) => row.turnId)).toEqual(["turn-1"]);
    expect(headers[0]).toMatchObject({
      state: "completedSuccess",
      activeMs: 9000,
      workSegments: [
        {
          segmentId: "turn-1:initial",
          startedAt: 1_700_000_002_000,
          endedAt: 1_700_000_007_000,
          activeMs: 5000,
        },
        {
          segmentId: "msg-q2",
          triggerEntityId: "msg-q2",
          startedAt: 1_700_000_007_000,
          endedAt: 1_700_000_011_000,
          activeMs: 4000,
        },
      ],
    });
    const steerUser = rows.find((row) => row.kind === "userInput" && row.text === "问题二");
    expect(steerUser?.turnId).toBe("turn-1");
    expect(steerUser?.actions).toMatchObject({ canEdit: true, editDisposition: "rewind" });
    expect(
      projection.resolveRowActionTarget(
        { rowId: steerUser!.rowId, entityId: steerUser!.entityId },
        "editUserQuery",
      ),
    ).toMatchObject({
      ok: true,
      editTarget: {
        entityId: "msg-q2",
        productTurnId: "turn-1",
        transcriptMessageId: "msg-q2",
        intent: {
          kind: "sendGoalCommand",
          text: "问题二",
          sourceCommandId: "command-q2",
          queueItemId: "p-q2",
          admittedDelivery: "guide",
        },
      },
    });
    // 内联位置：在 A1 之后、A2 之前。
    const order = rows
      .filter((row) => row.kind === "assistantText" || row.kind === "userInput")
      .map((row) => (row.kind === "assistantText" || row.kind === "userInput" ? row.text : ""));
    expect(order).toEqual(["问题一", "回答一", "问题二", "回答二"]);
  });

  it.each([
    ["一个 drained 事件带两条 guide", true, false],
    ["每条 guide 各一个 drained 事件（冷恢复形态）", false, false],
    ["每条 guide 各一个 drained 事件且逐事件原子发布（live 形态）", false, true],
  ])("M06f：%s时，相邻 guide 共用第一条开启的工作段", (_label, together, atomic) => {
    const log = new EventLog();
    const at = (seconds: number) => ({
      turnId: "turn-1",
      timestampMs: 1_700_000_000_000 + seconds * 1000,
    });
    const text = (delta: string, seconds: number) => {
      log.push(
        SessionEventType.ModelStreaming,
        { kind: "text_start", delta: "", done: false },
        at(seconds),
      );
      log.push(
        SessionEventType.ModelStreaming,
        { kind: "text_delta", delta, done: false },
        at(seconds),
      );
      log.push(
        SessionEventType.ModelStreaming,
        { kind: "text_end", delta: "", done: false },
        at(seconds),
      );
    };
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 }, at(1));
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "问题一" }, at(2));
    text("回答一", 3);
    const guides = ["g1", "g2"].map((id) => ({
      pendingInputId: `p-${id}`,
      messageId: `msg-${id}`,
      text: `引导-${id}`,
      delivery: "guide" as const,
    }));
    const drain = (items: typeof guides) =>
      log.push(
        SessionEventType.TurnSteerDrained,
        {
          pendingInputIds: items.map((item) => item.pendingInputId),
          injectedMessageIds: items.map((item) => item.messageId),
          drainedInputs: items,
          targetTurnId: "turn-1",
        },
        at(7),
      );
    if (together) drain(guides);
    else for (const guide of guides) drain([guide]);
    text("回答二", 9);
    log.push(
      SessionEventType.TurnComplete,
      { response: "", tokenCount: 0, toolCallCount: 0, duration: 9000, resultType: "success" },
      at(11),
    );

    const projection = new ProductProjection("session-1", "epoch-1");
    for (const event of log.events) {
      if (atomic) projection.applyEventAtomically(event, () => true);
      else projection.applyEvent(event);
    }
    const rows = projection.getSnapshot().rows.window;
    expect(rows.find((row) => row.kind === "turnHeader")).toMatchObject({
      workSegments: [
        {
          segmentId: "turn-1:initial",
          startedAt: 1_700_000_002_000,
          endedAt: 1_700_000_007_000,
          activeMs: 5000,
        },
        {
          segmentId: "msg-g1",
          triggerEntityId: "msg-g1",
          startedAt: 1_700_000_007_000,
          endedAt: 1_700_000_011_000,
          activeMs: 4000,
        },
      ],
    });
    expect(
      rows
        .filter((row) => row.kind === "userInput" || row.kind === "assistantText")
        .map((row) => (row.kind === "userInput" || row.kind === "assistantText" ? row.text : "")),
    ).toEqual(["问题一", "回答一", "引导-g1", "引导-g2", "回答二"]);
  });

  it("M06f：两次取出之间有一个没有可见行的模型 step 时，后一条 guide 开新工作段", () => {
    const log = new EventLog();
    const at = (seconds: number) => ({
      turnId: "turn-1",
      timestampMs: 1_700_000_000_000 + seconds * 1000,
    });
    const guide = (id: string, seconds: number) =>
      log.push(
        SessionEventType.TurnSteerDrained,
        {
          pendingInputIds: [`p-${id}`],
          injectedMessageIds: [`msg-${id}`],
          drainedInputs: [
            {
              pendingInputId: `p-${id}`,
              messageId: `msg-${id}`,
              text: `引导-${id}`,
              delivery: "guide" as const,
            },
          ],
          targetTurnId: "turn-1",
        },
        at(seconds),
      );
    const stream = (kind: string, delta: string, seconds: number) =>
      log.push(SessionEventType.ModelStreaming, { kind, delta, done: false }, at(seconds));
    const text = (delta: string, seconds: number) => {
      stream("text_start", "", seconds);
      stream("text_delta", delta, seconds);
      stream("text_end", "", seconds);
    };
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 }, at(1));
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "问题一" }, at(2));
    text("回答一", 3);
    guide("g1", 5);
    // 这一步只有隐藏内容：没有任何可见行，但它是两次取出之间的模型 step。
    stream("start", "", 6);
    log.push(
      SessionEventType.ModelComplete,
      {
        content: "",
        stopReason: "end_turn",
        querySource: "main_turn",
        toolCallCount: 0,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      },
      at(6),
    );
    guide("g2", 7);
    text("回答二", 9);
    log.push(
      SessionEventType.TurnComplete,
      { response: "", tokenCount: 0, toolCallCount: 0, duration: 9000, resultType: "success" },
      at(11),
    );

    const rows = runAll(log.events).projection.getSnapshot().rows.window;
    expect(rows.find((row) => row.kind === "turnHeader")).toMatchObject({
      workSegments: [
        { segmentId: "turn-1:initial", startedAt: 1_700_000_002_000, endedAt: 1_700_000_005_000 },
        {
          segmentId: "msg-g1",
          triggerEntityId: "msg-g1",
          startedAt: 1_700_000_005_000,
          endedAt: 1_700_000_007_000,
        },
        {
          segmentId: "msg-g2",
          triggerEntityId: "msg-g2",
          startedAt: 1_700_000_007_000,
          endedAt: 1_700_000_011_000,
        },
      ],
    });
  });

  it("兼容：旧 runtime 事件（无 drainedInputs/delivery）回退 queue 查表，按 followupMode 兜底切轮", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    log.push(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: "问题一" },
      { turnId: "turn-1" },
    );
    log.push(
      SessionEventType.TurnSteerQueued,
      {
        pendingInputId: "p-legacy",
        input: "老事件文本",
        inputPreview: "老事件文本",
        inputSize: 15,
        targetTurnId: "turn-1",
        queueLength: 1,
      },
      { turnId: "turn-1" },
    );
    log.push(
      SessionEventType.TurnSteerDrained,
      {
        pendingInputIds: ["p-legacy"],
        injectedMessageIds: ["msg-legacy"],
        targetTurnId: "turn-1",
      },
      { turnId: "turn-1" },
    );
    const { projection } = runAll(log.events);
    const rows = projection.getSnapshot().rows.window;
    const drained = rows.find((row) => row.kind === "userInput" && row.text === "老事件文本");
    // followupMode 默认 queue → 切轮；旧事件虽无 drainedInputs，injectedMessageIds
    // 仍是 promotion 后的持久 user 身份，因此 product turn 也稳定使用该 messageId。
    expect(drained?.turnId).toBe("msg-legacy");
    expect(projection.getMessageIdForRow(drained!.rowId)).toBe("msg-legacy");
  });

  it("PV4-10 防御：drain 缺持久 messageId 时不暴露无法执行的 edit action", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    log.push(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: "问题一" },
      { turnId: "turn-1" },
    );
    log.push(
      SessionEventType.TurnSteerQueued,
      {
        pendingInputId: "p-no-message",
        input: "缺少持久身份",
        inputPreview: "缺少持久身份",
        inputSize: 18,
        targetTurnId: "turn-1",
        queueLength: 1,
      },
      { turnId: "turn-1" },
    );
    log.push(
      SessionEventType.TurnSteerDrained,
      { pendingInputIds: ["p-no-message"], targetTurnId: "turn-1" },
      { turnId: "turn-1" },
    );
    const { projection } = runAll(log.events);
    const drained = projection
      .getSnapshot()
      .rows.window.find((row) => row.kind === "userInput" && row.text === "缺少持久身份");
    expect(drained?.actions?.canEdit).not.toBe(true);
    expect(
      projection.resolveRowActionTarget(
        { rowId: drained!.rowId, entityId: drained!.entityId },
        "editUserQuery",
      ),
    ).toEqual({
      ok: false,
      status: "rejected",
      reasonCode: "guard.actionUnavailable",
    });
  });
});

describe("P2 goalVerify 身份与落位（GV-identity / GV-terminal-only / GV-late-anchor）", () => {
  it("同 targetId+iteration 的重试（新 verificationId）复用同一 marker，不长第二个", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(SessionEventType.TargetCompletionVerification, {
      targetId: "target-1",
      status: "started",
      verificationId: "attempt-1",
      goalIteration: 1,
    });
    log.push(SessionEventType.TargetCompletionVerification, {
      targetId: "target-1",
      status: "started",
      verificationId: "attempt-2",
      goalIteration: 1,
    });
    log.push(SessionEventType.TargetCompletionVerification, {
      targetId: "target-1",
      status: "completed",
      verificationId: "attempt-2",
      goalIteration: 1,
      verification: { passed: true, reason: "ok" },
    });
    const { projection } = runAll(log.events);
    const markers = projection
      .getSnapshot()
      .rows.window.filter(
        (row) => row.kind === "timelineMarker" && row.marker.type === "goalVerify",
      );
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ marker: { iteration: 1, outcome: "pass" } });
  });

  it("GV-terminal-only：终态先到（无 started、无 goal 状态）也能创建 boundary", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(SessionEventType.TargetCompletionVerification, {
      targetId: "target-1",
      status: "completed",
      verificationId: "only-terminal",
      goalIteration: 3,
      verification: { passed: false, reason: "还差测试" },
    });
    const { projection } = runAll(log.events);
    const marker = projection
      .getSnapshot()
      .rows.window.find((row) => row.kind === "timelineMarker" && row.marker.type === "goalVerify");
    expect(marker).toMatchObject({
      marker: { iteration: 3, outcome: "notSatisfied", detail: "还差测试" },
    });
  });

  it("GV-late-anchor：verify 迟到到下一轮之后，按 anchorTurnId 锚回被验证的轮", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "Q1" }, { turnId: "turn-1" });
    log.push(
      SessionEventType.TurnComplete,
      { response: "", tokenCount: 0, toolCallCount: 0, duration: 100, resultType: "success" },
      { turnId: "turn-1" },
    );
    log.push(SessionEventType.TurnStarted, { turnNumber: 2, input: "Q2" }, { turnId: "turn-2" });
    // 迟到的 verify：事件本身归属 turn-2 期间，但 payload 锚定 turn-1。
    log.push(SessionEventType.TargetCompletionVerification, {
      targetId: "target-1",
      status: "started",
      verificationId: "late-1",
      goalIteration: 1,
      anchorTurnId: "turn-1",
    });
    const { projection } = runAll(log.events);
    const marker = projection
      .getSnapshot()
      .rows.window.find((row) => row.kind === "timelineMarker" && row.marker.type === "goalVerify");
    // UI 按 turnId 分组：锚回 turn-1 而不是落进 turn-2 或 "turn-unknown"。
    expect(marker?.turnId).toBe("turn-1");
  });
});

describe("Desktop Hook invocation projection", () => {
  it("keeps the shared Hook event enum aligned with Coding contracts", () => {
    expect(new Set(hookInvocationRowSchema.shape.hookEventName.options)).toEqual(
      new Set(Object.values(HookEventName)),
    );
  });

  const descriptor = {
    clientVisible: true as const,
    sourceKind: "user" as const,
    sourcePath: "/Users/example/.zcode/cli/config.json",
    executionType: "process" as const,
    executionMode: "foreground" as const,
    commandDisplay: "node hooks/check.mjs",
    timeoutMs: 5_000,
  };

  it("HK08/HK10 projects safe Hook summaries into the authoritative real turn", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1_000 });
    log.push(
      SessionEventType.HookRunStarted,
      {
        descriptor,
        hookEventName: "SessionStart",
        hookIndex: 0,
        hookCount: 1,
        hookInvocationId: "startup-hook",
        hookRunId: "startup-run",
        startedAt: 1_700_000_002_000,
      },
      { turnId: "runtime-turn-before-product-mapping" },
    );
    log.push(
      SessionEventType.HookRunCompleted,
      {
        descriptor,
        durationMs: 10,
        hookEventName: "SessionStart",
        hookIndex: 0,
        hookCount: 1,
        hookInvocationId: "startup-hook",
        hookRunId: "startup-run",
        outcome: "success",
        startedAt: 1_700_000_002_000,
      },
      { turnId: "runtime-turn-before-product-mapping" },
    );
    const beforeTurn = runAll(log.events).projection.getSnapshot();
    expect(beforeTurn.rows.window.some((row) => row.kind === "hookInvocation")).toBe(false);

    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "run" }, { turnId: "turn-1" });
    log.push(
      SessionEventType.HookRunStarted,
      {
        descriptor,
        hookEventName: "PreToolUse",
        hookIndex: 0,
        hookCount: 1,
        hookInvocationId: "tool-hook",
        hookRunId: "tool-run",
        startedAt: 1_700_000_003_000,
        toolCallId: "tool-1",
        toolName: "Write",
      },
      { turnId: "turn-1" },
    );
    log.push(
      SessionEventType.HookRunCompleted,
      {
        descriptor,
        durationMs: 20,
        hookEventName: "PreToolUse",
        hookIndex: 0,
        hookCount: 1,
        hookInvocationId: "tool-hook",
        hookRunId: "tool-run",
        outcome: "success",
        startedAt: 1_700_000_003_000,
        toolCallId: "tool-1",
        toolName: "Write",
      },
      { turnId: "turn-1" },
    );

    const { projection } = runAll(log.events);
    const hookRows = projection
      .getSnapshot()
      .rows.window.filter((row) => row.kind === "hookInvocation");
    expect(hookRows.map((row) => row.turnId)).toEqual(["turn-1", "turn-1"]);
    expect(hookRows[0]).toMatchObject({
      hookEventName: "SessionStart",
      executions: [
        expect.objectContaining({
          didExecute: true,
          displayName: "node · check.mjs",
          sourceKind: "user",
        }),
      ],
    });
    expect(hookRows[1]).toMatchObject({
      hookEventName: "PreToolUse",
      anchorToolCallId: "tool-1",
      executions: [
        expect.objectContaining({
          didExecute: true,
          displayName: "node · check.mjs",
          sourceKind: "user",
          toolName: "Write",
        }),
      ],
    });
    expect(JSON.stringify(hookRows)).not.toMatch(/commandDisplay|sourcePath/u);
    expect(projection.getSnapshot().rows.window.map((row) => row.turnId)).not.toContain(
      "session-hooks:session-1",
    );
  });

  it("HK09 distinguishes admission-only blocked from a Hook that executed and blocked", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default" });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "run" }, { turnId: "turn-1" });
    log.push(
      SessionEventType.HookRunBlocked,
      {
        descriptor,
        hookEventName: "PreToolUse",
        hookIndex: 0,
        hookCount: 2,
        hookInvocationId: "mixed-hook",
        hookRunId: "admission-blocked",
        outcome: "blocked",
        startedAt: 1_700_000_003_000,
      },
      { turnId: "turn-1" },
    );
    log.push(
      SessionEventType.HookRunStarted,
      {
        descriptor,
        hookEventName: "PreToolUse",
        hookIndex: 1,
        hookCount: 2,
        hookInvocationId: "mixed-hook",
        hookRunId: "executed-block",
        startedAt: 1_700_000_003_010,
      },
      { turnId: "turn-1" },
    );
    log.push(
      SessionEventType.HookRunBlocked,
      {
        descriptor,
        durationMs: 8,
        hookEventName: "PreToolUse",
        hookIndex: 1,
        hookCount: 2,
        hookInvocationId: "mixed-hook",
        hookRunId: "executed-block",
        blockReason: "blocked by workspace policy",
        outcome: "blocked",
        startedAt: 1_700_000_003_010,
      },
      { turnId: "turn-1" },
    );

    const row = runAll(log.events)
      .projection.getSnapshot()
      .rows.window.find((candidate) => candidate.kind === "hookInvocation");
    expect(row).toMatchObject({
      state: "completed",
      executions: [
        expect.objectContaining({ hookRunId: "admission-blocked", didExecute: false }),
        expect.objectContaining({
          hookRunId: "executed-block",
          didExecute: true,
          outcome: "blocked",
          blockReason: "blocked by workspace policy",
        }),
      ],
    });
  });

  it("HK-UP-02 projects an executed UserPromptSubmit block into the chat error", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1_000 });
    log.push(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: "blocked prompt" },
      { turnId: "turn-1" },
    );
    log.push(
      SessionEventType.HookRunStarted,
      {
        descriptor,
        hookEventName: "UserPromptSubmit",
        hookIndex: 0,
        hookCount: 1,
        hookInvocationId: "prompt-hook",
        hookRunId: "prompt-run",
        startedAt: 1_700_000_003_000,
      },
      { turnId: "turn-1" },
    );
    log.push(
      SessionEventType.HookRunBlocked,
      {
        descriptor,
        durationMs: 12,
        hookEventName: "UserPromptSubmit",
        hookIndex: 0,
        hookCount: 1,
        hookInvocationId: "prompt-hook",
        hookRunId: "prompt-run",
        blockReason: "hooks_prompt_block",
        errorMessage:
          "python3: can't open file '/workspace/a.py': [Errno 2] No such file or directory",
        stderrPreview:
          "python3: can't open file '/workspace/a.py': [Errno 2] No such file or directory",
        outcome: "blocked",
        startedAt: 1_700_000_003_000,
      },
      { turnId: "turn-1" },
    );
    log.push(
      SessionEventType.TurnComplete,
      {
        response: "HOOK_PROMPT_BLOCK_REASON",
        tokenCount: 0,
        toolCallCount: 0,
        duration: 12,
        resultType: "success",
      },
      { turnId: "turn-1" },
    );

    const { projection } = runAll(log.events);
    const snapshot = projection.getSnapshot();
    expect(snapshot.control.phase).toBe("completedSuccess");
    expect(snapshot.control.lastError).toMatchObject({
      code: "fault.runtime.hookBlocked",
      message:
        "hooks_prompt_block: python3: can't open file '/workspace/a.py': [Errno 2] No such file or directory",
      detail:
        "Hook block reason: hooks_prompt_block\nHook error: python3: can't open file '/workspace/a.py': [Errno 2] No such file or directory",
      recoverable: false,
      source: "runtime",
      traceId: "trace-1",
      attribution: { source: "runtime", reason: "hook_blocked" },
    });
  });

  it.each([
    [SessionEventType.HookRunCompleted, "success"],
    [SessionEventType.HookRunFailed, "failed"],
  ] as const)("HK09 keeps terminal-only %s as not executed", (terminalType, outcome) => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default" });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "run" }, { turnId: "turn-1" });
    log.push(
      terminalType,
      {
        descriptor,
        durationMs: 20,
        hookEventName: "PreToolUse",
        hookIndex: 0,
        hookCount: 1,
        hookInvocationId: `terminal-only-${outcome}`,
        hookRunId: `terminal-only-run-${outcome}`,
        outcome,
        startedAt: 1_700_000_003_000,
      },
      { turnId: "turn-1", timestampMs: 1_700_000_003_020 },
    );

    const row = runAll(log.events)
      .projection.getSnapshot()
      .rows.window.find((candidate) => candidate.kind === "hookInvocation");
    expect(row).toMatchObject({
      executions: [expect.objectContaining({ didExecute: false, outcome })],
    });
  });

  it("HK13 updates a late async terminal in place without reopening the completed turn", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default" });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "run" }, { turnId: "turn-1" });
    log.push(
      SessionEventType.HookRunStarted,
      {
        descriptor: { ...descriptor, executionMode: "background" },
        hookEventName: "UserPromptSubmit",
        hookIndex: 0,
        hookCount: 1,
        hookInvocationId: "async-hook",
        hookRunId: "async-run",
        startedAt: 1_700_000_003_000,
      },
      { turnId: "turn-1", timestampMs: 1_700_000_003_000 },
    );
    log.push(
      SessionEventType.TurnComplete,
      { response: "done", tokenCount: 1, toolCallCount: 0, duration: 10, resultType: "success" },
      { turnId: "turn-1", timestampMs: 1_700_000_003_010 },
    );
    log.push(
      SessionEventType.HookRunCompleted,
      {
        descriptor: { ...descriptor, executionMode: "background" },
        durationMs: 50,
        hookEventName: "UserPromptSubmit",
        hookIndex: 0,
        hookCount: 1,
        hookInvocationId: "async-hook",
        hookRunId: "async-run",
        outcome: "success",
        startedAt: 1_700_000_003_000,
      },
      { turnId: "turn-1", timestampMs: 1_700_000_003_050 },
    );

    const { deltasPerEvent, projection } = runAll(log.events);
    expect(deltasPerEvent[4]).toContainEqual(
      expect.objectContaining({
        op: "row.upserted",
        row: expect.objectContaining({ hookInvocationId: "async-hook", state: "completed" }),
      }),
    );
    expect(projection.getSnapshot().control.phase).toBe("completedSuccess");
    expect(
      projection
        .getSnapshot()
        .rows.window.filter(
          (row) => row.kind === "hookInvocation" && row.hookInvocationId === "async-hook",
        ),
    ).toHaveLength(1);
  });

  it("HK13 closes an attached started-only execution on a real runtime resume", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default" });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "run" }, { turnId: "turn-1" });
    log.push(
      SessionEventType.HookRunStarted,
      {
        descriptor,
        hookEventName: "PreToolUse",
        hookIndex: 0,
        hookCount: 1,
        hookInvocationId: "started-only-hook",
        hookRunId: "started-only-run",
        startedAt: 1_700_000_002_000,
      },
      { turnId: "turn-1", timestampMs: 1_700_000_002_000 },
    );
    log.push(SessionEventType.SessionResumed, {}, { timestampMs: 1_700_000_003_000 });

    const row = runAll(log.events)
      .projection.getSnapshot()
      .rows.window.find((candidate) => candidate.kind === "hookInvocation");
    expect(row).toMatchObject({
      state: "failed",
      executions: [
        {
          didExecute: true,
          state: "failed",
          outcome: "cancelled",
          durationMs: 1_000,
        },
      ],
    });
  });

  it("HK17 does not flush a pending SessionStart summary onto a model-only compact turn", () => {
    // Bug 根因：Runtime 的 runSessionStartHooks 先于 /compact 输入解析执行，首条输入即
    // /compact 时 SessionStart Hook 真实执行且携带 compact 的 runtime turnId；投影层
    // flush 只看「下一条 TurnStarted」，把摘要挂到了 model-only 维护 turn 上。
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    log.push(
      SessionEventType.HookRunStarted,
      {
        descriptor,
        hookEventName: "SessionStart",
        hookIndex: 0,
        hookCount: 1,
        hookInvocationId: "startup-hook",
        hookRunId: "startup-run",
        startedAt: 1_700_000_002_000,
      },
      { turnId: "turn-1", timestampMs: 1_700_000_002_000 },
    );
    log.push(
      SessionEventType.HookRunCompleted,
      {
        descriptor,
        durationMs: 10,
        hookEventName: "SessionStart",
        hookIndex: 0,
        hookCount: 1,
        hookInvocationId: "startup-hook",
        hookRunId: "startup-run",
        outcome: "success",
        startedAt: 1_700_000_002_000,
      },
      { turnId: "turn-1", timestampMs: 1_700_000_002_010 },
    );
    // compact 维护 turn：inputVisibility=model-only，无 user bubble。
    log.push(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: "/compact", inputVisibility: "model-only" },
      { turnId: "turn-1", timestampMs: 1_700_000_003_000 },
    );
    log.push(
      SessionEventType.CompactStarted,
      {
        operationId: "op-1",
        messageId: "msg-compact",
        status: "started",
        trigger: "manual",
        display: "separator",
      },
      { turnId: "turn-1", timestampMs: 1_700_000_003_050 },
    );
    log.push(
      SessionEventType.CompactCompleted,
      {
        operationId: "op-1",
        messageId: "msg-compact",
        status: "completed",
        trigger: "manual",
        display: "separator",
      },
      { turnId: "turn-1", timestampMs: 1_700_000_004_000 },
    );
    log.push(
      SessionEventType.TurnComplete,
      {
        response: "compacted",
        tokenCount: 1,
        toolCallCount: 0,
        duration: 1_000,
        resultType: "success",
      },
      { turnId: "turn-1", timestampMs: 1_700_000_004_050 },
    );

    const afterCompact = runAll(log.events).projection.getSnapshot();
    // compact 维护 turn 不承载 SessionStart 摘要：不得出现挂在 turn-1 的 hook row。
    expect(afterCompact.rows.window.filter((row) => row.kind === "hookInvocation")).toHaveLength(0);

    // 下一条真实 user-visible turn 才是合法收口目标。
    log.push(
      SessionEventType.TurnStarted,
      { turnNumber: 2, input: "next real prompt" },
      { turnId: "turn-2", timestampMs: 1_700_000_005_000 },
    );
    const afterRealTurn = runAll(log.events).projection.getSnapshot();
    const hookRows = afterRealTurn.rows.window.filter((row) => row.kind === "hookInvocation");
    expect(hookRows).toHaveLength(1);
    expect(hookRows[0]).toMatchObject({
      hookEventName: "SessionStart",
      turnId: "turn-2",
      executions: [expect.objectContaining({ didExecute: true })],
    });
  });

  it("HK17 keeps a SessionStart summary pending when a compact turn is the last turn", () => {
    // 只有 /compact 且无后续输入：摘要保持 pending，不挂 compact marker，也不制造
    // 可见时间线内容（session-hooks:* synthetic turn 禁止）。
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    log.push(
      SessionEventType.HookRunStarted,
      {
        descriptor,
        hookEventName: "SessionStart",
        hookIndex: 0,
        hookCount: 1,
        hookInvocationId: "startup-hook",
        hookRunId: "startup-run",
        startedAt: 1_700_000_002_000,
      },
      { turnId: "turn-1", timestampMs: 1_700_000_002_000 },
    );
    log.push(
      SessionEventType.HookRunCompleted,
      {
        descriptor,
        durationMs: 10,
        hookEventName: "SessionStart",
        hookIndex: 0,
        hookCount: 1,
        hookInvocationId: "startup-hook",
        hookRunId: "startup-run",
        outcome: "success",
        startedAt: 1_700_000_002_000,
      },
      { turnId: "turn-1", timestampMs: 1_700_000_002_010 },
    );
    log.push(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: "/compact", inputVisibility: "model-only" },
      { turnId: "turn-1", timestampMs: 1_700_000_003_000 },
    );
    log.push(
      SessionEventType.TurnComplete,
      {
        response: "compacted",
        tokenCount: 1,
        toolCallCount: 0,
        duration: 1_000,
        resultType: "success",
      },
      { turnId: "turn-1", timestampMs: 1_700_000_004_000 },
    );

    const snapshot = runAll(log.events).projection.getSnapshot();
    expect(snapshot.rows.window.filter((row) => row.kind === "hookInvocation")).toHaveLength(0);
    expect(snapshot.rows.window.map((row) => row.turnId)).not.toContain("session-hooks:session-1");
  });

  it("HK17 keeps tool Hooks of a model-only real agent turn attached to that turn", () => {
    // 回归背景（2026-08-28 review）：model-only ≠ 维护 turn。background_task 通知轮
    // （runtime-command-queue）、subagent_message 轮、goal continuation 轮都是
    // inputVisibility="model-only" 但会真实跑工具的 agent 轮。HK17 首版把直挂 gate
    // 无差别地按 currentTurnStartedModelOnly 拦截，导致这些轮的 PreToolUse/PostToolUse
    // 被 pending 吞掉、错误 flush 到下一个不相关用户轮。维护 turn 排除只属于
    // SessionStart；工具 Hook 必须按 event.turnId 直挂原轮，与 cold merge 对齐。
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default" });
    log.push(
      SessionEventType.TurnStarted,
      {
        turnNumber: 1,
        input: "background task completed, continue",
        inputVisibility: "model-only",
      },
      { turnId: "turn-bg", timestampMs: 1_700_000_001_000 },
    );
    log.push(
      SessionEventType.HookRunStarted,
      {
        descriptor,
        hookEventName: "PreToolUse",
        hookIndex: 0,
        hookCount: 1,
        hookInvocationId: "bg-tool-hook",
        hookRunId: "bg-tool-run",
        startedAt: 1_700_000_002_000,
        toolCallId: "tool-bg",
        toolName: "Write",
      },
      { turnId: "turn-bg", timestampMs: 1_700_000_002_000 },
    );
    log.push(
      SessionEventType.HookRunCompleted,
      {
        descriptor,
        durationMs: 15,
        hookEventName: "PreToolUse",
        hookIndex: 0,
        hookCount: 1,
        hookInvocationId: "bg-tool-hook",
        hookRunId: "bg-tool-run",
        outcome: "success",
        startedAt: 1_700_000_002_000,
        toolCallId: "tool-bg",
        toolName: "Write",
      },
      { turnId: "turn-bg", timestampMs: 1_700_000_002_015 },
    );
    log.push(
      SessionEventType.TurnStarted,
      { turnNumber: 2, input: "unrelated user question" },
      { turnId: "turn-user", timestampMs: 1_700_000_003_000 },
    );

    const hookRows = runAll(log.events)
      .projection.getSnapshot()
      .rows.window.filter((row) => row.kind === "hookInvocation");
    expect(hookRows).toHaveLength(1);
    // 工具 Hook 留在 model-only 真实 agent 轮，不被 pending 迁移到用户轮。
    expect(hookRows[0]).toMatchObject({
      hookEventName: "PreToolUse",
      turnId: "turn-bg",
      anchorToolCallId: "tool-bg",
      executions: [expect.objectContaining({ didExecute: true })],
    });
  });

  it.each([
    {
      caseName: "TurnError",
      terminal: (log: EventLog, turnId: string, at: number) =>
        log.push(
          SessionEventType.TurnError,
          { error: { type: "ProviderError", message: "rate limited" }, turnPhase: "model" },
          { turnId, timestampMs: at },
        ),
    },
    {
      caseName: "TurnComplete(cancelled)",
      terminal: (log: EventLog, turnId: string, at: number) =>
        log.push(
          SessionEventType.TurnComplete,
          {
            response: "",
            tokenCount: 0,
            toolCallCount: 0,
            duration: 100,
            resultType: "cancelled",
          },
          { turnId, timestampMs: at },
        ),
    },
  ])(
    "HK17 keeps a pending SessionStart summary off an abnormally terminated model-only turn ($caseName)",
    ({ terminal }) => {
      // SG-01：currentTurnId / currentTurnStartedModelOnly 是 reducer 内部侧表，
      // 异常终态是最容易遗漏的生命周期边界。TurnError 非 controlOnly 路径不清侧表、
      // TurnComplete(cancelled) 清侧表，两条收口路径必须等价：pending SessionStart
      // 不泄漏到异常 turn、不直挂死 turn、只归位下一条真实用户 turn。
      const sessionStartLifecycle = (log: EventLog, invocationId: string, at: number) => {
        log.push(
          SessionEventType.HookRunStarted,
          {
            descriptor,
            hookEventName: "SessionStart",
            hookIndex: 0,
            hookCount: 1,
            hookInvocationId: invocationId,
            hookRunId: `${invocationId}-run`,
            startedAt: at,
          },
          { turnId: "turn-mt", timestampMs: at },
        );
        log.push(
          SessionEventType.HookRunCompleted,
          {
            descriptor,
            durationMs: 5,
            hookEventName: "SessionStart",
            hookIndex: 0,
            hookCount: 1,
            hookInvocationId: invocationId,
            hookRunId: `${invocationId}-run`,
            outcome: "success",
            startedAt: at,
          },
          { turnId: "turn-mt", timestampMs: at + 5 },
        );
      };

      const log = new EventLog();
      log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
      // model-only goal continuation 轮（executionKind 缺省为 agent，异常走非 controlOnly）。
      log.push(
        SessionEventType.TurnStarted,
        { turnNumber: 1, input: "continue goal", inputVisibility: "model-only" },
        { turnId: "turn-mt", timestampMs: 1_700_000_001_000 },
      );
      sessionStartLifecycle(log, "startup-hook", 1_700_000_002_000);
      terminal(log, "turn-mt", 1_700_000_003_000);

      // 异常收口瞬间：pending 保留，不挂异常 turn，也不泄漏成可见 row。
      const afterTerminal = runAll(log.events).projection.getSnapshot();
      expect(afterTerminal.rows.window.filter((row) => row.kind === "hookInvocation")).toHaveLength(
        0,
      );
      expect(afterTerminal.rows.window.map((row) => row.turnId)).not.toContain(
        "session-hooks:session-1",
      );

      // 终态后紧接的下一个 SessionStart（resume epoch）同样必须 pending，
      // 不得直挂已终止的死 turn。
      sessionStartLifecycle(log, "resume-hook", 1_700_000_004_000);
      const afterResumeHook = runAll(log.events).projection.getSnapshot();
      expect(
        afterResumeHook.rows.window.filter((row) => row.kind === "hookInvocation"),
      ).toHaveLength(0);

      // 下一条真实用户 turn 收口两条 pending 摘要，且只出现在该轮。
      log.push(
        SessionEventType.TurnStarted,
        { turnNumber: 2, input: "real question" },
        { turnId: "turn-real", timestampMs: 1_700_000_005_000 },
      );
      const finalRows = runAll(log.events)
        .projection.getSnapshot()
        .rows.window.filter((row) => row.kind === "hookInvocation");
      expect(finalRows.map((row) => [row.hookInvocationId, row.turnId])).toEqual([
        ["startup-hook", "turn-real"],
        ["resume-hook", "turn-real"],
      ]);
    },
  );

  it.each([
    [SessionEventType.HookRunCompleted, { durationMs: 20, outcome: "success" }],
    [SessionEventType.HookRunFailed, { durationMs: 20, outcome: "failed" }],
  ] as const)(
    "HK14 ignores late %s after its Hook branch was rewound",
    (terminalType, terminal) => {
      const log = new EventLog();
      log.push(SessionEventType.SessionCreated, { mode: "default" });
      log.push(
        SessionEventType.TurnStarted,
        { turnNumber: 1, input: "run", messageId: "user-1" },
        { turnId: "turn-1" },
      );
      log.push(
        SessionEventType.ModelStreaming,
        { kind: "text_start", delta: "", done: false, assistantMessageId: "assistant-1" },
        { turnId: "turn-1" },
      );
      log.push(
        SessionEventType.HookRunStarted,
        {
          descriptor,
          hookEventName: "PreToolUse",
          hookIndex: 0,
          hookCount: 1,
          hookInvocationId: "rewound-hook",
          hookRunId: "rewound-run",
          startedAt: 1_700_000_003_000,
        },
        { turnId: "turn-1", timestampMs: 1_700_000_003_000 },
      );
      log.push(SessionEventType.RewindTriggered, {
        targetMessageId: "assistant-1",
        scope: "conversation",
        createdMessageId: "rewind-notice",
      });
      log.push(
        terminalType,
        {
          descriptor,
          hookEventName: "PreToolUse",
          hookIndex: 0,
          hookCount: 1,
          hookInvocationId: "rewound-hook",
          hookRunId: "rewound-run",
          startedAt: 1_700_000_003_000,
          ...terminal,
        },
        { turnId: "turn-1", timestampMs: 1_700_000_003_020 },
      );

      const { deltasPerEvent, projection } = runAll(log.events);
      expect(deltasPerEvent[4]).toContainEqual({
        op: "row.removed",
        fromRowId: expect.any(Number),
      });
      expect(
        projection
          .getSnapshot()
          .rows.window.some(
            (row) => row.kind === "hookInvocation" && row.hookInvocationId === "rewound-hook",
          ),
      ).toBe(false);
      expect(deltasPerEvent[5]).not.toContainEqual(
        expect.objectContaining({
          op: "row.appended",
          row: expect.objectContaining({ hookInvocationId: "rewound-hook" }),
        }),
      );
    },
  );

  it("projects workspace Hook review only as Settings-centered pending interaction", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default" });
    const request = {
      kind: "workspaceHookReview",
      reviewFlowId: "flow-1",
      generation: 1,
      interactionId: "interaction-1",
      sessionId: "session-1",
      taskId: "session-1",
      runId: "run-1",
      workspaceIdentity: "local:/workspace",
      workspaceLabel: "workspace",
      bundleDigest: "a".repeat(64),
      createdAt: 1_700_000_001_000,
      deadlineAt: 1_700_000_601_000,
      sourceFiles: [
        {
          path: "/workspace/.zcode/config.json",
          displayPath: ".zcode/config.json",
          editable: true,
        },
      ],
      summary: { eventCount: 1, hookCount: 1, pendingCount: 1 },
      items: [
        {
          reviewItemId: "item-0",
          event: "SessionStart",
          matcher: "startup",
          type: "command",
          displayName: "SessionStart · startup",
          displayCommand: "echo project",
          sourcePath: ".zcode/config.json",
          resolvedTimeoutMs: 60_000,
          resolvedMaxOutputBytes: 32_768,
          executionMode: "foreground",
          configuredEnabled: true,
          editable: true,
          trustState: "pending_trust",
        },
      ],
      warningCode: "workspace_hooks_execute_code",
    } as const;
    log.push(SessionEventType.WorkspaceHookReviewRequested, { request });

    const { projection } = runAll(log.events);
    expect(projection.getSnapshot().pendingInteractions).toEqual([
      {
        interactionId: "interaction-1",
        kind: "workspaceHookReview",
        anchorRowId: null,
        createdAt: request.createdAt,
        payload: request,
      },
    ]);

    log.push(SessionEventType.WorkspaceHookReviewSettled, {
      interactionId: "interaction-1",
      state: "resolved",
    });
    projection.applyEvent(log.events.at(-1)!);
    expect(projection.getSnapshot().pendingInteractions).toEqual([]);
  });

  it("superseded review generation removes only the stale interaction", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default" });
    const base = {
      kind: "workspaceHookReview",
      reviewFlowId: "flow-1",
      sessionId: "session-1",
      taskId: "session-1",
      runId: "run-1",
      workspaceIdentity: "local:/workspace",
      workspaceLabel: "workspace",
      createdAt: 1_700_000_001_000,
      deadlineAt: 1_700_000_601_000,
      sourceFiles: [],
      summary: { eventCount: 0, hookCount: 0, pendingCount: 0 },
      items: [],
      warningCode: "workspace_hooks_execute_code",
    } as const;
    log.push(SessionEventType.WorkspaceHookReviewRequested, {
      request: {
        ...base,
        generation: 1,
        interactionId: "interaction-1",
        bundleDigest: "a".repeat(64),
      },
    });
    log.push(SessionEventType.WorkspaceHookReviewSuperseded, {
      interactionId: "interaction-1",
      supersededByInteractionId: "interaction-2",
    });
    log.push(SessionEventType.WorkspaceHookReviewRequested, {
      request: {
        ...base,
        generation: 2,
        interactionId: "interaction-2",
        bundleDigest: "b".repeat(64),
      },
    });

    const { projection } = runAll(log.events);
    expect(projection.getSnapshot().pendingInteractions.map((item) => item.interactionId)).toEqual([
      "interaction-2",
    ]);
  });

  it("treats SessionResumed and the next requested review as a new runtime authority", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default" });
    const base = {
      kind: "workspaceHookReview",
      sessionId: "session-1",
      taskId: "session-1",
      runId: "run-1",
      workspaceIdentity: "local:/workspace",
      workspaceLabel: "workspace",
      createdAt: 1_700_000_001_000,
      deadlineAt: 1_700_000_601_000,
      sourceFiles: [],
      summary: { eventCount: 0, hookCount: 0, pendingCount: 0 },
      items: [],
      warningCode: "workspace_hooks_execute_code",
    } as const;
    log.push(SessionEventType.WorkspaceHookReviewRequested, {
      request: {
        ...base,
        reviewFlowId: "old-runtime-flow",
        generation: 7,
        interactionId: "old-runtime-interaction",
        bundleDigest: "a".repeat(64),
      },
    });
    log.push(SessionEventType.SessionResumed, {});

    const { projection } = runAll(log.events);
    expect(projection.getSnapshot().pendingInteractions).toEqual([]);

    log.push(SessionEventType.WorkspaceHookReviewRequested, {
      request: {
        ...base,
        reviewFlowId: "new-runtime-flow",
        generation: 1,
        interactionId: "new-runtime-interaction",
        bundleDigest: "b".repeat(64),
        createdAt: 1_700_000_002_000,
        deadlineAt: 1_700_000_602_000,
      },
    });
    projection.applyEvent(log.events.at(-1)!);
    expect(projection.getSnapshot().pendingInteractions.map((item) => item.interactionId)).toEqual([
      "new-runtime-interaction",
    ]);
  });

  it("ignores a different review flow until SessionResumed establishes a new runtime epoch", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default" });
    const base = {
      kind: "workspaceHookReview",
      generation: 1,
      sessionId: "session-1",
      taskId: "session-1",
      runId: "run-1",
      workspaceIdentity: "local:/workspace",
      workspaceLabel: "workspace",
      createdAt: 1_700_000_001_000,
      deadlineAt: 1_700_000_601_000,
      sourceFiles: [],
      summary: { eventCount: 0, hookCount: 0, pendingCount: 0 },
      items: [],
      warningCode: "workspace_hooks_execute_code",
    } as const;
    log.push(SessionEventType.WorkspaceHookReviewRequested, {
      request: {
        ...base,
        reviewFlowId: "old-flow",
        interactionId: "old-interaction",
        bundleDigest: "a".repeat(64),
      },
    });
    log.push(SessionEventType.WorkspaceHookReviewRequested, {
      request: {
        ...base,
        reviewFlowId: "new-flow",
        interactionId: "new-interaction",
        bundleDigest: "b".repeat(64),
        createdAt: 1_700_000_002_000,
        deadlineAt: 1_700_000_602_000,
      },
    });

    const { projection } = runAll(log.events);
    expect(projection.getSnapshot().pendingInteractions.map((item) => item.interactionId)).toEqual([
      "old-interaction",
    ]);
  });

  it("ignores equal-generation workspace Hook review requests with a conflicting interaction", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default" });
    const base = {
      kind: "workspaceHookReview",
      reviewFlowId: "flow-1",
      generation: 3,
      sessionId: "session-1",
      taskId: "session-1",
      runId: "run-1",
      workspaceIdentity: "local:/workspace",
      workspaceLabel: "workspace",
      createdAt: 1_700_000_001_000,
      deadlineAt: 1_700_000_601_000,
      sourceFiles: [],
      summary: { eventCount: 0, hookCount: 0, pendingCount: 0 },
      items: [],
      warningCode: "workspace_hooks_execute_code",
    } as const;
    log.push(SessionEventType.WorkspaceHookReviewRequested, {
      request: {
        ...base,
        interactionId: "interaction-authority",
        bundleDigest: "a".repeat(64),
      },
    });
    log.push(SessionEventType.WorkspaceHookReviewRequested, {
      request: {
        ...base,
        interactionId: "interaction-conflict",
        bundleDigest: "b".repeat(64),
      },
    });

    const { projection } = runAll(log.events);
    expect(projection.getSnapshot().pendingInteractions.map((item) => item.interactionId)).toEqual([
      "interaction-authority",
    ]);
  });

  it("does not project hidden internal or legacy lifecycle events", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default" });
    log.push(SessionEventType.HookRunStarted, {
      descriptor: {
        ...descriptor,
        clientVisible: false,
        sourceKind: "internal",
      },
      hookEventName: "SessionStart",
      hookIndex: 0,
      hookCount: 0,
      hookInvocationId: "mailbox-hook",
      hookRunId: "mailbox-run",
      startedAt: 1_700_000_002_000,
    });
    log.push(SessionEventType.HookRunStarted, {
      hookEventName: "SessionStart",
      hookIndex: 0,
      hookRunId: "legacy-run",
    });

    const { projection } = runAll(log.events);
    expect(projection.getSnapshot().rows.window).not.toContainEqual(
      expect.objectContaining({ kind: "hookInvocation" }),
    );
  });
});

describe("软门禁(D2): workspaceHookAdmission snapshot 投影", () => {
  it("WorkspaceHookAdmissionUpdated pendingCount>0 写入 snapshot.workspaceHookAdmission", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default" });
    log.push(SessionEventType.WorkspaceHookAdmissionUpdated, {
      pendingCount: 2,
      bundleDigest: "a".repeat(64),
      workspaceIdentity: "local:/workspace",
    });

    const { projection } = runAll(log.events);
    expect(projection.getSnapshot().workspaceHookAdmission).toEqual({
      pendingCount: 2,
      bundleDigest: "a".repeat(64),
      workspaceIdentity: "local:/workspace",
    });
  });

  it("WorkspaceHookAdmissionUpdated pendingCount===0 → 置 null(提示条消失)", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default" });
    // 先有 pending
    log.push(SessionEventType.WorkspaceHookAdmissionUpdated, {
      pendingCount: 1,
      bundleDigest: "a".repeat(64),
    });
    // settle 后清零
    log.push(SessionEventType.WorkspaceHookAdmissionUpdated, {
      pendingCount: 0,
      bundleDigest: "a".repeat(64),
    });

    const { projection } = runAll(log.events);
    expect(projection.getSnapshot().workspaceHookAdmission).toBeNull();
  });

  it("SessionResumed epoch 清理 → workspaceHookAdmission 置 null(resume 后 activate 重新上报)", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default" });
    log.push(SessionEventType.WorkspaceHookAdmissionUpdated, {
      pendingCount: 3,
      bundleDigest: "a".repeat(64),
      workspaceIdentity: "local:/workspace",
    });
    log.push(SessionEventType.SessionResumed, {});

    const { projection } = runAll(log.events);
    expect(projection.getSnapshot().workspaceHookAdmission).toBeNull();
  });

  it("workspaceIdentity 可选:缺失时 snapshot 字段不含 workspaceIdentity", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default" });
    log.push(SessionEventType.WorkspaceHookAdmissionUpdated, {
      pendingCount: 1,
      bundleDigest: "b".repeat(64),
    });

    const { projection } = runAll(log.events);
    expect(projection.getSnapshot().workspaceHookAdmission).toEqual({
      pendingCount: 1,
      bundleDigest: "b".repeat(64),
    });
    expect(projection.getSnapshot().workspaceHookAdmission).not.toHaveProperty("workspaceIdentity");
  });
});

// ── CreateWorkflow 运行确认（docs/dynamic-workflow/launch.md）──

describe("workflow 运行确认的 ask 预览", () => {
  const causalityGraph = {
    steps: [
      {
        id: "ask#1",
        kind: "ask" as const,
        label: "a",
        line: 2,
        column: 11,
        lane: "actor#1",
      },
    ],
    lanes: [{ id: "actor#1", name: "a" }],
    // 第二层是子代理导向：每阶段一张参与者卡 + 交接边（docs/dynamic-workflow/presentation.md）。
    participants: [
      { id: "unphased:actor#1", phase: "unphased", lane: "actor#1", steps: ["ask#1"] },
    ],
    handoffs: [],
    sink: ["ask#1"],
  };

  function permissionRequestedLog(display?: unknown, toolName = "CreateWorkflow"): EventLog {
    const turnId = "turn-1";
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "run it" }, { turnId });
    log.push(
      SessionEventType.ToolCallScheduled,
      {
        toolCallId: "tc-1",
        toolName,
        input: { script: "return 1;" },
        schedule: { parallelGroups: [["tc-1"]], executionOrder: ["tc-1"] },
      },
      { turnId },
    );
    log.push(
      SessionEventType.PermissionRequested,
      {
        requestId: "req-1",
        toolCallId: "tc-1",
        toolName,
        riskLevel: "low",
        reason: "createWorkflow.runConfirmation: user must confirm running the analyzed script",
        input: { script: "return 1;" },
        // CreateWorkflow 自 2026-09-11（第 7 轮）起声明会话作用域的免确认；Bash 用例只借
        // 这条日志的形状，策略对它无意义（投影不看工具声明，只看事件上的策略）。
        optionsPolicy: "session-always-allow",
        ...(display === undefined ? {} : { display }),
      },
      { turnId },
    );
    return log;
  }

  it("把事件上的 display 投到 pendingInteraction，并按 optionsPolicy 把 always allow 换成会话免确认", () => {
    const log = permissionRequestedLog({
      kind: "create_workflow",
      ok: true,
      errorCount: 0,
      diagnostics: [],
      causalityGraph,
    });

    const snapshot = runAll(log.events).projection.getSnapshot();
    const toolRow = snapshot.rows.window.find((row) => row.kind === "toolCall");
    expect(toolRow).toMatchObject({
      status: "pendingApproval",
      approvalInteractionId: "req-1",
    });
    expect(snapshot.pendingInteractions).toHaveLength(1);
    const payload = snapshot.pendingInteractions[0]?.payload;
    expect(payload).toMatchObject({
      kind: "permission",
      display: { kind: "create_workflow", ok: true, causalityGraph },
    });
    // 产品裁决：项目级 always allow 被 optionsPolicy 裁掉，第 7 轮换成会话作用域的
    // 免确认；第 4 轮在 v4 追加 Refine（拒绝并附修改意见），列表 = Run / Session / Deny / Refine。
    expect(
      payload?.kind === "permission" && payload.options.map((option) => option.optionId),
    ).toEqual(["allowOnce", "allowSession", "deny", "workflowRefine"]);
    const sessionOption =
      payload?.kind === "permission"
        ? payload.options.find((option) => option.optionId === "allowSession")
        : undefined;
    // wire 上的 kind 是闭集：会话选项映为 allowAlways（GUI 按 name 本地化）；optionId 原样，
    // broker 靠它精确命中。response 不带 permissionUpdates（strict schema，见 spec 第 7 轮）。
    expect(sessionOption).toMatchObject({
      kind: "allowAlways",
      label: "Always allow in this session",
      response: { decision: "allow" },
    });
    expect(sessionOption?.response).not.toHaveProperty("permissionUpdates");
    expect(conversationSnapshotSchema.safeParse(snapshot).success).toBe(true);
    const refineOption =
      payload?.kind === "permission"
        ? payload.options.find((option) => option.optionId === "workflowRefine")
        : undefined;
    // 静态 response 是普通 deny：不认识该选项的消费面（bot 直出、无 freeText 应答）
    // 退化为拒绝；反馈升级只发生在 interaction-broker 的 freeText 特判。
    expect(refineOption).toMatchObject({
      kind: "custom",
      label: "Refine",
      response: { decision: "deny" },
    });
  });

  it("Refine 选项只属于 CreateWorkflow：其他工具的权限 ask 不投放", () => {
    const snapshot = runAll(
      permissionRequestedLog(undefined, "Bash").events,
    ).projection.getSnapshot();
    const payload = snapshot.pendingInteractions[0]?.payload;
    expect(payload?.kind).toBe("permission");
    expect(
      payload?.kind === "permission" && payload.options.map((option) => option.optionId),
    ).toEqual(["allowOnce", "allowSession", "deny"]);
  });

  it("no-always-allow 策略（SaveWorkflow）仍只留 Run / Deny", () => {
    const turnId = "turn-1";
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "save it" }, { turnId });
    log.push(
      SessionEventType.PermissionRequested,
      {
        requestId: "req-1",
        toolCallId: "tc-1",
        toolName: "SaveWorkflow",
        riskLevel: "low",
        reason: "saveWorkflow.confirmation",
        input: { name: "x", script: "return 1;" },
        optionsPolicy: "no-always-allow",
      },
      { turnId },
    );
    const payload = runAll(log.events).projection.getSnapshot().pendingInteractions[0]?.payload;
    expect(
      payload?.kind === "permission" && payload.options.map((option) => option.optionId),
    ).toEqual(["allowOnce", "deny"]);
  });

  it("没有 display 时保持纯文本 ask，pendingApproval 行为不变", () => {
    const snapshot = runAll(permissionRequestedLog().events).projection.getSnapshot();
    const payload = snapshot.pendingInteractions[0]?.payload;
    expect(payload?.kind).toBe("permission");
    expect(payload && "display" in payload).toBe(false);
    expect(snapshot.rows.window.find((row) => row.kind === "toolCall")).toMatchObject({
      status: "pendingApproval",
    });
  });

  it("协议无法承载的 display kind 不进 ask 载荷", () => {
    // file_diff 不在 v4 display 联合里；直接透传会让快照 schema 解析失败。
    const log = permissionRequestedLog({
      kind: "file_diff",
      filePath: "/workspace/a.ts",
      additions: 1,
      deletions: 0,
      structuredPatch: [],
    });
    const snapshot = runAll(log.events).projection.getSnapshot();
    const payload = snapshot.pendingInteractions[0]?.payload;
    expect(payload && "display" in payload).toBe(false);
    expect(conversationSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });
});

// ── dwf 实时运行态：引擎事件 → 会话事件 → workflowRuns 状态键 ──
// 见 docs/dynamic-workflow/presentation.md「The run state the pane draws」「workflowRuns 形状与界」「终态权威 patch」。
describe("ProductProjection workflowRuns（dwf 进度投影）", () => {
  const RUN_ID = "dwfrun-1";

  function progress(
    log: EventLog,
    eventType: string,
    payload: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ): SessionEvent {
    return log.push(SessionEventType.DynamicWorkflowRunProgress, {
      runId: RUN_ID,
      toolCallId: "tc-1",
      // sequence 是 journal sequence（appendEvent 从 0 起单调分配）。
      sequence: (progressSequence[RUN_ID] = (progressSequence[RUN_ID] ?? -1) + 1),
      eventType,
      payload,
      ...extra,
    });
  }
  const progressSequence: Record<string, number> = {};

  function startedLog(caps: Record<string, unknown> = { maxConcurrency: 4 }): EventLog {
    progressSequence[RUN_ID] = -1;
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    progress(log, "run-started", { runId: RUN_ID, caps });
    return log;
  }

  function runsOf(log: EventLog) {
    return runAll(log.events).projection.getSnapshot().workflowRuns;
  }

  it("run-started 建条目：状态 running，用量归零，快照过 strict schema", () => {
    const log = startedLog({ maxConcurrency: 2 });
    const snapshot = runAll(log.events).projection.getSnapshot();
    expect(snapshot.workflowRuns).toMatchObject({
      revision: 1,
      runs: [
        {
          runId: RUN_ID,
          toolCallId: "tc-1",
          status: "running",
          usage: { spentTokens: 0, nodesUsed: 0 },
          actors: [],
          nodes: [],
          lastEventSequence: 0,
        },
      ],
    });
    expect(conversationSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  it("节点相位按 (siteId, ordinal) upsert，不新增条目", () => {
    const log = startedLog();
    progress(log, "node-queued", {
      instance: { siteId: "ask#1", ordinal: 1 },
      kind: "ask",
      actor: { siteId: "actor#1", ordinal: 1 },
      actorSeq: 1,
    });
    progress(log, "node-dispatched", { instance: { siteId: "ask#1", ordinal: 1 } });
    progress(log, "node-repairing", {
      instance: { siteId: "ask#1", ordinal: 1 },
      attempt: 1,
      violations: [],
    });
    progress(log, "node-settled", { instance: { siteId: "ask#1", ordinal: 1 }, outcome: "ok" });

    const runs = runsOf(log);
    expect(runs?.runs[0]?.nodes).toEqual([
      {
        siteId: "ask#1",
        ordinal: 1,
        kind: "ask",
        phase: "settled",
        outcome: "ok",
        actorSiteId: "actor#1",
        actorOrdinal: 1,
      },
    ]);
  });

  it("cached 命中只发 node-settled（无 node-queued），kind 因此缺省而条目仍成立", () => {
    const log = startedLog();
    progress(log, "node-settled", {
      instance: { siteId: "world-read#1", ordinal: 1 },
      outcome: "ok",
      cached: true,
    });
    expect(runsOf(log)?.runs[0]?.nodes).toEqual([
      { siteId: "world-read#1", ordinal: 1, phase: "settled", outcome: "ok", cached: true },
    ]);
  });

  it("actor-created 建 actor，其状态由自己的节点派生（三态：waiting / running / completed，决策 39）", () => {
    const log = startedLog();
    progress(
      log,
      "actor-created",
      { actor: { siteId: "actor#1", ordinal: 1 }, name: "planner" },
      { actorSessionId: "sess_dwf-1-actor.1" },
    );
    expect(runsOf(log)?.runs[0]?.actors).toEqual([
      {
        siteId: "actor#1",
        ordinal: 1,
        name: "planner",
        sessionId: "sess_dwf-1-actor.1",
        // 尚无节点且 run 未终态 → waiting（"还没派到活"），不是 completed。
        status: "waiting",
      },
    ]);

    progress(log, "node-queued", {
      instance: { siteId: "ask#1", ordinal: 1 },
      kind: "ask",
      actor: { siteId: "actor#1", ordinal: 1 },
    });
    // dispatched 只是会话就绪、请求尚未准入（docs/dynamic-workflow/concurrency.md「Protocol state」）：仍是 waiting。
    progress(log, "node-dispatched", { instance: { siteId: "ask#1", ordinal: 1 } });
    expect(runsOf(log)?.runs[0]?.actors[0]?.status).toBe("waiting");
    // 模型请求真的发出去了 → running。
    progress(log, "node-executing", { instance: { siteId: "ask#1", ordinal: 1 } });
    expect(runsOf(log)?.runs[0]?.actors[0]?.status).toBe("running");

    progress(log, "node-settled", { instance: { siteId: "ask#1", ordinal: 1 }, outcome: "ok" });
    expect(runsOf(log)?.runs[0]?.actors[0]?.status).toBe("completed");
  });

  it("用量：spentTokens 直接取 usage-updated 载荷，nodesUsed 按实例首次派发计数", () => {
    // docs/dynamic-workflow/authoring.md：事件自带已花总量（不再是剩余量 + 派生字段），
    // 步数由派发事件计数（不再从上限反算——没有上限了）。同一实例重复派发不重复计数。
    const log = startedLog({ maxConcurrency: 4 });
    progress(log, "usage-updated", { spentTokens: 1_234 });
    progress(log, "node-dispatched", { instance: { siteId: "ask#1", ordinal: 1 } });
    progress(log, "node-dispatched", { instance: { siteId: "ask#1", ordinal: 1 } });
    progress(log, "node-dispatched", { instance: { siteId: "ask#2", ordinal: 1 } });
    expect(runsOf(log)?.runs[0]?.usage).toEqual({
      spentTokens: 1_234,
      nodesUsed: 2,
    });
  });

  /**
   * 终态事件产**一条** `workflowRun.updated`，把这条 run 的结算事实（status / error）一次落地。
   *
   * 这里刻意不再断言「终态 patch 是整键替换、丢光中间态也能收口」：改成键级增量之后，丢失的
   * 中间 op 不再被下一条事件顺带补回来——那份自愈让位给了帧的 seq 连续性判定与 snapshot 重同步
   * （客户端 fromSeq 对不上就整份重取）。终态事实照旧在这一条 op 里，一条也没少。
   */
  it("run-settled 产一条该 run 的键级增量：结算事实一次落地", () => {
    const log = startedLog();
    progress(log, "node-settled", { instance: { siteId: "ask#1", ordinal: 1 }, outcome: "ok" });
    const settled = progress(log, "run-settled", {
      status: "errored",
      error: { code: "ReportCapExceeded", message: "报告条数超过上限" },
    });

    const { projection, deltasPerEvent } = runAll(log.events);
    const terminalDeltas = deltasPerEvent[log.events.indexOf(settled)]!;
    expect(terminalDeltas).toHaveLength(1);
    const updated = terminalDeltas[0]!;
    expect(updated.op).toBe("workflowRun.updated");
    const op = updated as {
      op: "workflowRun.updated";
      runId: string;
      revision: number;
      run?: { status?: string; error?: string };
      nodes?: unknown[];
    };
    expect(op.runId).toBe(RUN_ID);
    expect(op.run).toMatchObject({ status: "errored", error: "报告条数超过上限" });
    // 节点这一步没动，所以这条增量里一条节点都不带——线上的字节与**改动量**成正比。
    expect(op.nodes).toBeUndefined();
    expect(op.revision).toBe(projection.getSnapshot().workflowRuns?.revision);
    const run = projection.getSnapshot().workflowRuns?.runs[0];
    expect(run?.status).toBe("errored");
    expect(run?.nodes).toHaveLength(1);
  });

  it("resume：同 runId 再收 run-started 时清掉上一世的 error（进程内 cancel→resume）", () => {
    // run-started 分支原样展开旧条目：cancel → resume 不经重启时，run 以 running 重现
    // 却还挂着上一世的结算错误——一个正在跑的 run 同时展示失败文案。
    const log = startedLog();
    progress(log, "run-settled", {
      status: "stopped",
      stopReason: "interrupted",
      error: { code: "Interrupted", message: "owning process exited" },
    });
    progress(log, "run-started", { runId: RUN_ID, caps: { maxConcurrency: 4 } });

    const runs = runsOf(log)?.runs ?? [];
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ runId: RUN_ID, status: "running" });
    expect(runs[0]?.error).toBeUndefined();
    expect(runs[0]?.resultPreview).toBeUndefined();
  });

  it("revision 单调，lastEventSequence 随 journal sequence 抬升", () => {
    const log = startedLog();
    progress(log, "node-queued", { instance: { siteId: "ask#1", ordinal: 1 }, kind: "ask" });
    progress(log, "node-dispatched", { instance: { siteId: "ask#1", ordinal: 1 } });
    const { snapshots } = runAll(log.events);
    const revisions = snapshots
      .map((snapshot) => snapshot.workflowRuns?.revision)
      .filter((revision): revision is number => revision !== undefined);
    expect(revisions).toEqual([1, 2, 3]);
    expect(snapshots.at(-1)?.workflowRuns?.runs[0]?.lastEventSequence).toBe(2);
  });

  it("四个数组的界：nodes 超上限置 truncated 且不再增长，被拒实例进计数器", () => {
    const rejected = 5;
    const log = startedLog();
    for (let ordinal = 1; ordinal <= WORKFLOW_RUNS_LIMITS.maxNodes + rejected; ordinal += 1) {
      progress(log, "node-queued", { instance: { siteId: "ask#1", ordinal }, kind: "ask" });
    }
    const run = runsOf(log)?.runs[0];
    expect(run?.nodes).toHaveLength(WORKFLOW_RUNS_LIMITS.maxNodes);
    expect(run?.truncated).toBe(true);
    // `truncated` 只说得出「有东西没进来」；到底少了几步要靠计数器，否则读面上的步数
    // 会比真实步数小，而且小多少没人说得清。
    expect(run?.usage.nodesUnlisted).toBe(rejected);
    expect(run?.usage.nodesUnlistedSettled).toBeUndefined();
    // 读面唯一允许的步数读法 = 表内 + 表外。
    expect(workflowRunStepCounts(run!)).toEqual({
      total: WORKFLOW_RUNS_LIMITS.maxNodes + rejected,
      settled: 0,
    });
    // 已在表内的实例仍可继续更新相位（超界只拒绝**新**实例）。
    progress(log, "node-dispatched", { instance: { siteId: "ask#1", ordinal: 1 } });
    expect(runsOf(log)?.runs[0]?.nodes[0]?.phase).toBe("dispatched");
    // 表外实例的结算同样要数得出来：它一条节点行都没有，只能落在第二个计数器上。
    progress(log, "node-settled", {
      instance: { siteId: "ask#1", ordinal: WORKFLOW_RUNS_LIMITS.maxNodes + 1 },
      outcome: "ok",
    });
    const settledRun = runsOf(log)!.runs[0]!;
    expect(settledRun.usage.nodesUnlistedSettled).toBe(1);
    expect(workflowRunStepCounts(settledRun)).toEqual({
      total: WORKFLOW_RUNS_LIMITS.maxNodes + rejected,
      settled: 1,
    });
  });

  /**
   * 一条引擎事件 → **一条**该 run 的键级增量，且只带动过的那条节点。
   *
   * 这一条是整次改造的验收点：旧编码在这里会重发整张表（此处 16 条节点），线上的字节因此与
   * 状态大小成正比而不是与改动量成正比——O(N) 字节/事件、O(N²)/run，节点上界与宽 fan-out
   * 撞界丢实例都是这笔账的下游。
   */
  it("一条事件只发动过的那条节点，别的 run 一个字节都不带", () => {
    const log = startedLog();
    for (let ordinal = 1; ordinal <= 16; ordinal += 1) {
      progress(log, "node-queued", { instance: { siteId: "ask#1", ordinal }, kind: "ask" });
    }
    // 第二条 run：它这一步没变化，所以不该出现在增量里。
    log.push(SessionEventType.DynamicWorkflowRunProgress, {
      runId: "dwfrun-other",
      sequence: 0,
      eventType: "run-started",
      payload: { runId: "dwfrun-other", caps: { maxConcurrency: 1 } },
    });
    const dispatched = progress(log, "node-dispatched", {
      instance: { siteId: "ask#1", ordinal: 7 },
    });

    const { deltasPerEvent, projection } = runAll(log.events);
    const deltas = deltasPerEvent[log.events.indexOf(dispatched)]!;
    expect(deltas).toHaveLength(1);
    const op = deltas[0] as {
      op: string;
      runId: string;
      nodes?: { siteId: string; ordinal: number; phase: string; kind?: string }[];
      run?: Record<string, unknown>;
      actors?: unknown[];
    };
    expect(op.op).toBe("workflowRun.updated");
    expect(op.runId).toBe(RUN_ID);
    expect(op.nodes).toEqual([{ siteId: "ask#1", ordinal: 7, kind: "ask", phase: "dispatched" }]);
    expect(op.actors).toBeUndefined();
    // header 只带真的动过的键（水位与派发计数），不含 nodes/actors 之外的整表。
    expect(Object.keys(op.run ?? {}).toSorted()).toEqual(["lastEventSequence", "usage"]);
    // 增量应用回去之后，权威状态仍是归约本身的产物（契约：逐字节一致）。
    const authoritative = projection.getSnapshot().workflowRuns!;
    expect(authoritative.runs.map((run) => run.runId)).toEqual([RUN_ID, "dwfrun-other"]);
    expect(authoritative.runs[0]!.nodes).toHaveLength(16);
    expect(authoritative.runs[0]!.nodes[6]).toEqual({
      siteId: "ask#1",
      ordinal: 7,
      kind: "ask",
      phase: "dispatched",
    });
  });

  it("run 被条数界淘汰时发 workflowRun.removed（只有生产者淘汰，而且必须说出来）", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    for (let index = 0; index <= WORKFLOW_RUNS_LIMITS.maxRuns; index += 1) {
      log.push(SessionEventType.DynamicWorkflowRunProgress, {
        runId: `dwfrun-${index}`,
        sequence: 0,
        eventType: "run-started",
        payload: { runId: `dwfrun-${index}`, caps: { maxConcurrency: 1 } },
      });
    }
    const { deltasPerEvent } = runAll(log.events);
    // 第 9 条 run 出生的那一条事件同时淘汰了第 1 条：淘汰先发，出生随后。
    const evicting = deltasPerEvent.at(-1)!;
    expect(evicting.map((delta) => delta.op)).toEqual([
      "workflowRun.removed",
      "workflowRun.updated",
    ]);
    expect((evicting[0] as { runId: string }).runId).toBe("dwfrun-0");
    expect((evicting[1] as { runId: string }).runId).toBe(`dwfrun-${WORKFLOW_RUNS_LIMITS.maxRuns}`);
  });

  it("runs ≤ 8 且按最旧淘汰", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    for (let index = 0; index < WORKFLOW_RUNS_LIMITS.maxRuns + 3; index += 1) {
      log.push(SessionEventType.DynamicWorkflowRunProgress, {
        runId: `dwfrun-${index}`,
        sequence: 0,
        eventType: "run-started",
        payload: { runId: `dwfrun-${index}`, caps: { maxConcurrency: 1 } },
      });
    }
    const runs = runAll(log.events).projection.getSnapshot().workflowRuns?.runs ?? [];
    expect(runs.map((run) => run.runId)).toEqual([
      "dwfrun-3",
      "dwfrun-4",
      "dwfrun-5",
      "dwfrun-6",
      "dwfrun-7",
      "dwfrun-8",
      "dwfrun-9",
      "dwfrun-10",
    ]);
  });

  it("log 与 usage 事件不进图：它们没有 site id，只进事件日志", () => {
    const log = startedLog();
    progress(log, "log", { message: "开始" });
    const run = runsOf(log)?.runs[0];
    expect(run?.nodes).toEqual([]);
    expect(run?.actors).toEqual([]);
    // 但它仍抬升 lastEventSequence——事件日志需要知道有新内容可取。
    expect(run?.lastEventSequence).toBe(1);
  });

  // R-10：两个 profile 的终态必须逐字节一致，所以 workflowRuns 的增量一条都不能被 profile 过滤
  // 掉（`profiles.ts` 只滤 row.delta）。桌面 continuous 与手机 replayable 收到的是同一串 op。
  it("键级增量不受 delivery profile 门控（记录在案的偏离）", () => {
    const log = startedLog();
    const dispatched = progress(log, "node-dispatched", {
      instance: { siteId: "ask#1", ordinal: 1 },
    });
    const { deltasPerEvent } = runAll(log.events);
    const deltas = deltasPerEvent[log.events.indexOf(dispatched)]!;
    expect(deltas.some((delta) => delta.op === "workflowRun.updated")).toBe(true);
    for (const profile of Object.values(DELIVERY_PROFILES) as DeliveryProfile[]) {
      expect(filterConversationDeltasForProfile(deltas, profile)).toEqual(deltas);
    }
  });

  it("同一 run 的重复事件幂等：内容不变不产 delta", () => {
    const log = startedLog();
    progress(log, "node-settled", { instance: { siteId: "ask#1", ordinal: 1 }, outcome: "ok" });
    const { projection } = runAll(log.events);
    const before = projection.getSnapshot().workflowRuns?.revision;
    // 同一条事件重放（同 sequence、同内容）。
    const replay = log.events.at(-1)!;
    expect(projection.applyEvent(replay)).toEqual([]);
    expect(projection.getSnapshot().workflowRuns?.revision).toBe(before);
  });

  // ── report 事件 → reports[]（docs/dynamic-workflow/presentation.md「The run pane」）──
  // 数据面是详情页 Results 区的全部输入；Results 区本身在 packages/ui 的 jsdom 用例里钉。

  it("report 事件按顺序追加进 reports[]：string 原样，object 走 pretty JSON", () => {
    const log = startedLog();
    progress(log, "report", {
      instance: { siteId: "report#1", ordinal: 1 },
      item: "3 stale imports",
    });
    progress(log, "report", {
      instance: { siteId: "report#2", ordinal: 1 },
      item: { file: "a.ts", severity: "warn" },
    });

    const snapshot = runAll(log.events).projection.getSnapshot();
    expect(snapshot.workflowRuns?.runs[0]?.reports).toEqual([
      { siteId: "report#1", ordinal: 1, preview: "3 stale imports" },
      {
        siteId: "report#2",
        ordinal: 1,
        preview: '{\n  "file": "a.ts",\n  "severity": "warn"\n}',
      },
    ]);
    expect(conversationSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  it("零条 report 时 reports 键整个缺席（Results 区据此整区不渲染）", () => {
    const log = startedLog();
    progress(log, "node-queued", { instance: { siteId: "ask#1", ordinal: 1 }, kind: "ask" });
    expect(runsOf(log)?.runs[0]).not.toHaveProperty("reports");
  });

  /**
   * 这一条是 report 与 node 分类的凭证：report 有 site 身份、进 journal、有自己的 RunEvent，
   * 但它**不是 step**。混进 nodes[] 的代价是可观测的——紧凑卡与任务岛的 `settled/observed`
   * 步数读的就是 nodes，一个报得勤的工作流会显得步数虚高，状态叠加也会多亮一格。
   */
  it("report 不进 nodes[]/actors，也不动 nodesUsed；但抬升 lastEventSequence", () => {
    const log = startedLog({ maxConcurrency: 4 });
    progress(log, "node-queued", { instance: { siteId: "ask#1", ordinal: 1 }, kind: "ask" });
    progress(log, "node-dispatched", { instance: { siteId: "ask#1", ordinal: 1 } });
    progress(log, "report", { instance: { siteId: "report#1", ordinal: 1 }, item: "a finding" });

    const run = runsOf(log)?.runs[0];
    expect(run?.nodes.map((node) => node.siteId)).toEqual(["ask#1"]);
    expect(run?.actors).toEqual([]);
    expect(run?.usage.nodesUsed).toBe(1);
    expect(run?.reports).toHaveLength(1);
    // 事件日志要知道有新内容可取，所以水位照常抬升。
    expect(run?.lastEventSequence).toBe(3);
  });

  it("失败结算之后 reports 原样留着：捞回半途产物正是 report 存在的理由", () => {
    const log = startedLog();
    progress(log, "report", { instance: { siteId: "report#1", ordinal: 1 }, item: "finding 1" });
    progress(log, "run-settled", {
      status: "errored",
      error: { code: "DriverError", message: "boom" },
    });

    const run = runsOf(log)?.runs[0];
    expect(run?.status).toBe("errored");
    expect(run?.reports).toEqual([{ siteId: "report#1", ordinal: 1, preview: "finding 1" }]);
  });

  it("同一 report 事件重放（同 sequence 同内容）不产 delta、不重复条目", () => {
    const log = startedLog();
    progress(log, "report", { instance: { siteId: "report#1", ordinal: 1 }, item: "once" });
    const { projection } = runAll(log.events);
    const before = projection.getSnapshot().workflowRuns?.revision;

    expect(projection.applyEvent(log.events.at(-1)!)).toEqual([]);
    expect(projection.getSnapshot().workflowRuns?.revision).toBe(before);
    expect(projection.getSnapshot().workflowRuns?.runs[0]?.reports).toHaveLength(1);
  });

  /**
   * 去重键是实例（siteId × ordinal），不是事件 sequence——脚本 replay 时每个 report 调用都会
   * 重跑。所以一条**新 sequence** 却带已见实例的事件只抬水位，绝不把同一条产物列两次。
   */
  it("新 sequence 带已见实例键：水位抬升，条目不重复", () => {
    const log = startedLog();
    progress(log, "report", { instance: { siteId: "report#1", ordinal: 1 }, item: "once" });
    progress(log, "report", { instance: { siteId: "report#1", ordinal: 1 }, item: "once" });

    const run = runsOf(log)?.runs[0];
    expect(run?.reports).toEqual([{ siteId: "report#1", ordinal: 1, preview: "once" }]);
    expect(run?.lastEventSequence).toBe(2);
  });

  it("reports 触到 64 条上限：拒绝新条目并置 truncated，已有条目照常更新", () => {
    const log = startedLog();
    for (let ordinal = 1; ordinal <= WORKFLOW_RUNS_LIMITS.maxReports + 3; ordinal += 1) {
      progress(log, "report", {
        instance: { siteId: "report#1", ordinal },
        item: `finding ${ordinal}`,
      });
    }
    const run = runsOf(log)?.runs[0];
    expect(run?.reports).toHaveLength(WORKFLOW_RUNS_LIMITS.maxReports);
    expect(run?.truncated).toBe(true);
    // 先到的条目不被后来的挤掉（淘汰会让读者以为早期发现丢了；界的语义是拒新）。
    expect(run?.reports?.[0]?.preview).toBe("finding 1");

    // 触界之后其余键照常更新：结算与水位都不受影响。
    progress(log, "run-settled", { status: "completed" });
    const settled = runsOf(log)?.runs[0];
    expect(settled?.status).toBe("completed");
    expect(settled?.reports).toHaveLength(WORKFLOW_RUNS_LIMITS.maxReports);
  });

  it("单条预览超界即截断（带省略号），仍过 strict schema", () => {
    const log = startedLog();
    // 载荷有界化已经把单个字符串削到 2048，所以真正会超界的是「键多的对象展开成 pretty JSON」。
    const wide: Record<string, string> = {};
    for (let index = 0; index < 64; index += 1) wide[`key${index}`] = "x".repeat(64);
    progress(log, "report", { instance: { siteId: "report#1", ordinal: 1 }, item: wide });

    const snapshot = runAll(log.events).projection.getSnapshot();
    const preview = snapshot.workflowRuns?.runs[0]?.reports?.[0]?.preview ?? "";
    expect(preview.length).toBe(WORKFLOW_RUNS_LIMITS.maxReportPreviewLength);
    expect(preview.endsWith("…")).toBe(true);
    expect(conversationSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  it("instance 缺失的 report 事件被忽略（不造无身份条目），但仍抬水位", () => {
    const log = startedLog();
    progress(log, "report", { item: "orphan" });
    const run = runsOf(log)?.runs[0];
    expect(run).not.toHaveProperty("reports");
    expect(run?.lastEventSequence).toBe(1);
  });
});

// 中枢直接启动已保存工作流（docs/dynamic-workflow/launch.md）：controlOnly 启动轮的活投影。
// TurnStarted(workflow_launch) → turnHeader/userInput 双行 origin=workflowLaunch + 同一份元数据，
// 无助手行；TurnComplete 收口后 header 变 completed（controlOnly 不下发 running/工时）。
describe("workflow-direct-launch 启动轮投影", () => {
  const workflowLaunch = {
    runId: "dwfrun-9",
    toolCallId: "launch-abc",
    name: "deep-research",
    scope: "global" as const,
    path: "/home/u/.zcode/workflows/deep-research.ts",
    args: { topic: "adaptive concurrency" },
    description: "Deep-dive a topic",
  };

  function launchEvents(): SessionEvent[] {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    log.push(
      SessionEventType.TurnStarted,
      {
        turnNumber: 1,
        input: 'Started the saved workflow "deep-research" (global) as run dwfrun-9.',
        messageId: "message-launch-1",
        executionKind: "controlOnly",
        inputSource: "workflow_launch",
        workflowLaunch,
      },
      { turnId: "turn-launch" },
    );
    log.push(
      SessionEventType.TurnComplete,
      { response: "", tokenCount: 0, toolCallCount: 0, duration: 0, resultType: "success" },
      { turnId: "turn-launch" },
    );
    return log.events;
  }

  it("双行 origin=workflowLaunch 且都带启动元数据，无助手行", () => {
    const snapshot = runAll(launchEvents()).projection.getSnapshot();
    expect(() => conversationSnapshotSchema.parse(snapshot)).not.toThrow();

    const rows = snapshot.rows.window;
    expect(rows.map((row) => row.kind)).toEqual(["turnHeader", "userInput"]);

    const header = rows.find((row) => row.kind === "turnHeader");
    expect(header).toMatchObject({
      origin: "workflowLaunch",
      executionKind: "controlOnly",
      state: "completedSuccess",
      workflowLaunch,
    });

    const userInput = rows.find((row) => row.kind === "userInput");
    expect(userInput).toMatchObject({
      origin: "workflowLaunch",
      text: 'Started the saved workflow "deep-research" (global) as run dwfrun-9.',
      workflowLaunch,
    });

    // controlOnly：不残留 running / activeWorks（旧 UI 会把 0ms 误显示成「已工作 1 秒」）。
    expect(snapshot.control.activeWorks).toEqual([]);
  });

  it("启动轮收口让会话离开 draft：phase 成终态，sessions-index 摘要不再被当 draft 丢弃", () => {
    // 2026-09-14 实机：只有一条 controlOnly 启动轮的会话活投影恒为 draft，task-index syncer 丢弃 draft
    // 摘要，侧栏要等重启（store 种子给出终态 phase）才出现。冷热必须同形。
    const events = launchEvents();
    const { projection } = runAll(events.slice(0, 2));
    expect(projection.getSnapshot().control.phase).toBe("draft");
    projection.applyEvent(events[2]!);
    const control = projection.getSnapshot().control;
    expect(control.phase).toBe("completedSuccess");
    expect(control.sessionEnded).toBe(true);
    expect(control.canStop).toBe(false);
    expect(control.activeWorks).toEqual([]);
  });

  it("非 draft 会话上的 controlOnly 轮照旧不碰 session control", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "hi" }, { turnId: "turn-1" });
    log.push(
      SessionEventType.TurnComplete,
      { response: "", tokenCount: 0, toolCallCount: 0, duration: 5, resultType: "cancelled" },
      { turnId: "turn-1" },
    );
    log.push(
      SessionEventType.TurnStarted,
      { turnNumber: 2, input: "/goal x", executionKind: "controlOnly" },
      { turnId: "turn-2" },
    );
    log.push(
      SessionEventType.TurnComplete,
      { response: "", tokenCount: 0, toolCallCount: 0, duration: 0, resultType: "success" },
      { turnId: "turn-2" },
    );
    const snapshot = runAll(log.events).projection.getSnapshot();
    // 上一轮的中断终态保留，控制轮的 success 不改写它。
    expect(snapshot.control.phase).toBe("completedInterrupted");
  });
});

// docs/dynamic-workflow/transcript-and-notifications.md：TurnStarted 上的 epilogueStart 原样落到
// userInput 行；缺席时行上没有这个键（老转录逐字不变）。
describe("userInput 行的 epilogueStart（热路径）", () => {
  it("透传 TurnStarted.epilogueStart；缺席不写键", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    log.push(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: "Summarize\n\n---\nStandard", epilogueStart: 9 },
      { turnId: "turn-1" },
    );
    log.push(SessionEventType.TurnStarted, { turnNumber: 2, input: "plain" }, { turnId: "turn-2" });
    const { projection } = runAll(log.events);
    const rows = projection.getSnapshot().rows.window.filter((row) => row.kind === "userInput");
    expect(rows[0]).toMatchObject({ text: "Summarize\n\n---\nStandard", epilogueStart: 9 });
    expect(rows[1]).not.toHaveProperty("epilogueStart");
  });
});
