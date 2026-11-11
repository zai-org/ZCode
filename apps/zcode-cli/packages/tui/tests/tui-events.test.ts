import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import { applySessionEventToState } from "../src/app-events.js";
import {
  appendAgentResult,
  redactSensitivePromptForTranscript,
  submitDuringActiveTurn,
  submitIdleTurn,
} from "../src/app-submit.js";
import type { Message, ModifiedFileStat, QueuedInput } from "../src/app-model.js";
import type { TuiOptions, TuiSubmitPromptResult } from "../src/types.js";

test("does not render streamed tool input JSON as assistant text", () => {
  const state = createSessionEventState();

  state.apply(
    sessionEvent(SessionEventType.ModelStreaming, {
      delta: '{"description":"Explore project purpose"}',
      kind: "tool_input_delta",
      toolName: "Agent",
    }),
  );

  assert.equal(state.liveModelText, "");
  assert.equal(state.status, "Preparing tool Agent...");
});

test("keeps streamed text and tool parts in assistant message order", () => {
  const state = createSessionEventState();

  state.apply(
    sessionEvent(SessionEventType.ModelStreaming, {
      assistantMessageId: "assistant-1",
      delta: "先看看 package。",
      kind: "text_delta",
    }),
  );
  state.apply(
    sessionEvent(SessionEventType.ModelStreaming, {
      assistantMessageId: "assistant-1",
      delta: "",
      kind: "tool_call",
      toolCallId: "call-1",
      toolName: "Read",
    }),
  );
  state.apply(
    sessionEvent(SessionEventType.ToolCallScheduled, {
      input: { file_path: "package.json" },
      toolCallId: "call-1",
      toolName: "Read",
    }),
  );
  state.apply(
    sessionEvent(SessionEventType.ToolCallResult, {
      duration: 5,
      result: { content: "{}", success: true },
      toolCallId: "call-1",
    }),
  );
  state.apply(
    sessionEvent(SessionEventType.ModelStreaming, {
      assistantMessageId: "assistant-1",
      delta: "",
      done: true,
      kind: "finish",
    }),
  );

  assert.equal(state.liveModelText, "");
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0]?.streaming, false);
  assert.deepEqual(
    state.messages[0]?.parts?.map((part) => part.type),
    ["text", "tool"],
  );
  assert.equal(state.messages[0]?.parts?.[0]?.text, "先看看 package。");
  assert.equal(state.messages[0]?.parts?.[1]?.toolCallId, "call-1");
});

test("does not append a duplicate final response after streamed projection", () => {
  const next = appendAgentResult(
    [
      {
        content: "",
        id: "assistant-1",
        parts: [{ streamProjected: true, text: "完成了。", type: "text" }],
        role: "agent",
        streamProjected: true,
        streaming: true,
      },
    ],
    { response: "完成了。" },
  );

  assert.equal(next.length, 1);
  assert.equal(next[0]?.streaming, false);
  assert.equal(next[0]?.parts?.[0]?.type, "text");
  assert.equal(next[0]?.parts?.[0]?.text, "完成了。");
});

test("does not invent an assistant placeholder for empty final response", () => {
  const next = appendAgentResult([{ content: "你好", role: "user" }], { response: "" });

  assert.deepEqual(next, [{ content: "你好", role: "user" }]);
});

test("renders turn errors into the transcript", () => {
  const state = createSessionEventState();

  state.apply(
    sessionEvent(SessionEventType.TurnError, {
      error: {
        message: "Model returned no text.",
        type: "model_error",
      },
      turnPhase: "streaming",
    }),
  );

  assert.equal(state.status, "Turn failed.");
  assert.equal(state.lastError, "Model returned no text.");
  assert.deepEqual(state.messages, [
    {
      content: "Error: Model returned no text.",
      role: "system",
    },
  ]);
});

test("renders local assistant messages into the transcript", () => {
  const state = createSessionEventState();

  state.apply(
    sessionEvent(SessionEventType.AssistantMessage, {
      content: "Open this URL:\nhttps://chat.z.ai/oauth/authorize",
    }),
  );

  assert.deepEqual(state.messages, [
    {
      content: "Open this URL:\nhttps://chat.z.ai/oauth/authorize",
      role: "agent",
    },
  ]);
});

test("keeps busy sendInput user row before streamed response", async () => {
  const state = createSessionEventState();
  const response = "你好！";
  const options: TuiOptions = {
    noColor: true,
    stderr: process.stderr,
    stdin: process.stdin,
    stdout: process.stdout,
    submitPrompt: async () => ({ response: "unused" }),
    sendInput: async (_input, submitOptions) => {
      submitOptions.onEvent?.(
        sessionEvent(SessionEventType.ModelStreaming, {
          assistantMessageId: "assistant-1",
          delta: response,
          kind: "text_delta",
        }),
      );
      submitOptions.onEvent?.(
        sessionEvent(SessionEventType.ModelStreaming, {
          assistantMessageId: "assistant-1",
          done: true,
          kind: "finish",
        }),
      );
      return {
        kind: "started_turn",
        result: { response },
      };
    },
  };

  await submitDuringActiveTurn({
    activeTurnId: "turn-1" as never,
    applyResult: (result: TuiSubmitPromptResult) => {
      state.setMessages((current) => appendAgentResult(current, result));
    },
    applySessionEvent: state.apply,
    draftAttachments: [],
    messageInsertIndex: state.messages.length,
    options,
    setDraftValue: () => {},
    setLastError: () => {},
    setMessages: state.setMessages,
    setQueuedInputs: state.setQueuedInputs,
    setStatus: (status) => {
      state.status = status;
    },
    text: "你好",
  });

  assert.deepEqual(
    state.messages.map((message) => message.role),
    ["user", "agent"],
  );
  assert.equal(state.messages[0]?.content, "你好");
  assert.equal(state.messages[1]?.parts?.[0]?.type, "text");
  assert.equal(state.messages[1]?.parts?.[0]?.text, response);
});

test("keeps queued busy input out of the transcript projection", async () => {
  const state = createSessionEventState();
  const options: TuiOptions = {
    noColor: true,
    stderr: process.stderr,
    stdin: process.stdin,
    stdout: process.stdout,
    submitPrompt: async () => ({ response: "unused" }),
    sendInput: async () => ({
      kind: "queued",
      pendingInputId: "pending-1",
      queueLength: 1,
      turnId: "turn-1" as never,
    }),
  };

  await submitDuringActiveTurn({
    activeTurnId: "turn-1" as never,
    applyResult: () => {
      throw new Error("queued input should not start a turn result");
    },
    applySessionEvent: state.apply,
    draftAttachments: [],
    messageInsertIndex: state.messages.length,
    options,
    setDraftValue: () => {},
    setLastError: () => {},
    setMessages: state.setMessages,
    setQueuedInputs: state.setQueuedInputs,
    setStatus: (status) => {
      state.status = status;
    },
    text: "queued follow-up",
  });

  assert.deepEqual(state.messages, []);
  assert.deepEqual(state.queuedInputs, [{ id: "pending-1", text: "queued follow-up" }]);
  assert.equal(state.status, "Input queued.");
});

test("tracks queued turn steering events outside transcript messages", () => {
  const state = createSessionEventState();

  state.apply(
    sessionEvent(SessionEventType.TurnSteerQueued, {
      input: "full queued input",
      inputPreview: "full queued input",
      inputSize: 17,
      pendingInputId: "pending-1",
      queueLength: 1,
      targetTurnId: "turn-1",
    }),
  );

  assert.deepEqual(state.messages, []);
  assert.deepEqual(state.queuedInputs, [{ id: "pending-1", text: "full queued input" }]);

  state.apply(
    sessionEvent(SessionEventType.TurnSteerDrained, {
      injectedMessageIds: ["message-1"],
      pendingInputIds: ["pending-1"],
      targetTurnId: "turn-1",
    }),
  );

  assert.deepEqual(state.queuedInputs, []);
});

test("renders compact lifecycle events as a single timeline row", () => {
  const state = createSessionEventState();

  state.apply(
    sessionEvent(SessionEventType.CompactStarted, {
      messageId: "msg-compact-1",
      operationId: "cmp-1",
      status: "started",
      trigger: "manual",
    }),
  );
  state.apply(
    sessionEvent(SessionEventType.CompactCompleted, {
      messageId: "msg-compact-1",
      operationId: "cmp-1",
      status: "completed",
      trigger: "manual",
    }),
  );

  assert.equal(state.status, "Conversation compacted.");
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0]?.role, "timeline");
  assert.equal(state.messages[0]?.timeline?.status, "completed");
});

test("renders compact retrying events as the same running timeline row", () => {
  const state = createSessionEventState();

  state.apply(
    sessionEvent(SessionEventType.CompactStarted, {
      attempt: 1,
      maxAttempts: 3,
      messageId: "msg-compact-retry",
      operationId: "cmp-retry",
      status: "started",
      trigger: "auto",
    }),
  );
  state.apply(
    sessionEvent(SessionEventType.CompactStarted, {
      attempt: 2,
      maxAttempts: 3,
      messageId: "msg-compact-retry",
      operationId: "cmp-retry",
      reason: "Failed to generate compact summary",
      status: "retrying",
      trigger: "auto",
    }),
  );

  assert.equal(state.status, "Retrying context compression (2/3)");
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0]?.timeline?.status, "retrying");
  assert.equal(state.messages[0]?.timeline?.attempt, 2);
  assert.equal(state.messages[0]?.timeline?.maxAttempts, 3);

  state.apply(
    sessionEvent(SessionEventType.CompactFailed, {
      attempt: 3,
      maxAttempts: 3,
      messageId: "msg-compact-retry",
      operationId: "cmp-retry",
      reason: "Failed to generate compact summary",
      status: "failed",
      trigger: "auto",
    }),
  );

  assert.equal(state.status, "Context compression failed.");
  assert.equal(state.lastError, "Failed to generate compact summary");
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0]?.timeline?.status, "failed");
  assert.equal(state.messages[0]?.timeline?.reason, "Failed to generate compact summary");
  assert.equal(state.messages[0]?.timeline?.attempt, 3);
});

test("renders skipped compact events without a failure state", () => {
  const state = createSessionEventState();

  state.apply(
    sessionEvent(SessionEventType.CompactCompleted, {
      messageId: "msg-compact-skipped",
      operationId: "cmp-skipped",
      status: "skipped",
      trigger: "manual",
    }),
  );

  assert.equal(state.status, "Context is up to date; no compression needed");
  assert.equal(state.lastError, undefined);
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0]?.role, "timeline");
  assert.equal(state.messages[0]?.timeline?.status, "skipped");
});

test("renders compact turn errors on the timeline instead of system transcript errors", () => {
  const state = createSessionEventState();

  state.apply(
    sessionEvent(SessionEventType.CompactStarted, {
      messageId: "msg-compact-1",
      operationId: "cmp-1",
      status: "started",
      trigger: "manual",
    }),
  );
  state.apply(
    sessionEvent(SessionEventType.TurnError, {
      error: {
        message: "No summary produced.",
        type: "compact_failed",
      },
      turnPhase: "compact",
    }),
  );

  assert.equal(state.status, "Context compression failed.");
  assert.equal(state.lastError, "No summary produced.");
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0]?.role, "timeline");
  assert.equal(state.messages[0]?.timeline?.status, "failed");
  assert.equal(state.messages[0]?.timeline?.reason, "No summary produced.");
});

test("submitting compact slash command creates timeline row without a user row", async () => {
  const state = createSessionEventState();
  const options: TuiOptions = {
    noColor: true,
    stderr: process.stderr,
    stdin: process.stdin,
    stdout: process.stdout,
    submitPrompt: async () => ({ response: "" }),
  };

  await submitIdleTurn({
    applyResult: (result: TuiSubmitPromptResult) => {
      state.setMessages((current) => appendAgentResult(current, result));
    },
    applySessionEvent: state.apply,
    draftAttachments: [],
    options,
    setBusy: () => {},
    setDraftAttachments: () => {},
    setDraftValue: () => {},
    setLastError: () => {},
    setLiveModelText: () => {},
    setMessages: state.setMessages,
    setSelection: () => {},
    setSlashSelection: () => {},
    setStatus: (status) => {
      state.status = status;
    },
    setStatusDetails: () => {},
    text: "/compact keep failures",
    turnRef: { current: undefined },
  });

  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0]?.role, "timeline");
  assert.equal(state.messages[0]?.timeline?.status, "started");
  assert.equal(state.messages[0]?.timeline?.command, "/compact keep failures");
});

test("redacts manual coding plan api keys from local transcript rows", () => {
  assert.equal(
    redactSensitivePromptForTranscript("/login zai-coding-plan-api-key zai-secret-key"),
    "/login zai-coding-plan-api-key <redacted>",
  );
  assert.equal(
    redactSensitivePromptForTranscript("/login bigmodel-coding-plan-api-key bm-secret-key"),
    "/login bigmodel-coding-plan-api-key <redacted>",
  );
  assert.equal(
    redactSensitivePromptForTranscript("/login zai-coding-plan-api-key"),
    "/login zai-coding-plan-api-key",
  );
});

test("updates the model projection from model selected events", () => {
  const state = createSessionEventState();

  state.apply(
    sessionEvent(SessionEventType.ModelSelected, {
      modelSelection: {
        modelId: "openai/gpt-5.5",
        providerId: "gateway",
      },
    }),
  );

  assert.equal(state.model, "gateway/openai/gpt-5.5");
});

test("aggregates current-session modified files from file diff displays", () => {
  const state = createSessionEventState("/workspace/project");
  const display = {
    additions: 3,
    deletions: 1,
    filePath: "/workspace/project/src/App.jsx",
    kind: "file_diff",
    structuredPatch: [],
  };

  state.apply(
    sessionEvent(SessionEventType.ToolCallResult, {
      duration: 5,
      result: { content: "ok", display, success: true },
      toolCallId: "call-1",
    }),
  );
  state.apply(
    sessionEvent(SessionEventType.ToolCallResult, {
      duration: 5,
      result: { content: "ok", display, success: true },
      toolCallId: "call-1",
    }),
  );
  state.apply(
    sessionEvent(SessionEventType.ToolCallResult, {
      duration: 5,
      result: {
        content: "ok",
        display: { ...display, additions: 2, deletions: 4 },
        success: true,
      },
      toolCallId: "call-2",
    }),
  );

  assert.deepEqual(state.modifiedFiles, [
    {
      additions: 5,
      deletions: 5,
      filePath: "src/App.jsx",
    },
  ]);
});

function createSessionEventState(workspaceDirectory?: string): {
  apply: (event: SessionEvent) => void;
  lastError: string | undefined;
  liveModelText: string;
  model: string | undefined;
  modifiedFiles: ModifiedFileStat[];
  messages: Message[];
  queuedInputs: QueuedInput[];
  setMessages: (updater: Message[] | ((current: Message[]) => Message[])) => void;
  setQueuedInputs: (updater: QueuedInput[] | ((current: QueuedInput[]) => QueuedInput[])) => void;
  status: string;
} {
  const state: {
    lastError: string | undefined;
    liveModelText: string;
    messages: Message[];
    model: string | undefined;
    modifiedFiles: ModifiedFileStat[];
    queuedInputs: QueuedInput[];
    status: string;
  } = {
    lastError: undefined,
    liveModelText: "",
    messages: [],
    model: undefined,
    modifiedFiles: [],
    queuedInputs: [],
    status: "",
  };
  const assistantMessageIdsByToolCallId = new Map<string, string>();
  const modifiedFileToolCallIds = new Set<string>();
  const toolNamesById = new Map<string, string>();
  return {
    apply: (event) => {
      applySessionEventToState(event, {
        assistantMessageIdsByToolCallId,
        setActiveTurnId: () => {},
        setCacheStats: () => {},
        setContextUsage: () => {},
        setLastError: (message) => {
          state.lastError = message;
        },
        setLiveModelText: (updater) => {
          state.liveModelText =
            typeof updater === "function" ? updater(state.liveModelText) : updater;
        },
        setMessages: (updater) => {
          state.messages = typeof updater === "function" ? updater(state.messages) : updater;
        },
        setModel: (model) => {
          state.model = model;
        },
        setModifiedFiles: (updater) => {
          state.modifiedFiles =
            typeof updater === "function" ? updater(state.modifiedFiles) : updater;
        },
        setNetworkRequests: () => {},
        setQueuedInputs: (updater) => {
          state.queuedInputs =
            typeof updater === "function" ? updater(state.queuedInputs) : updater;
        },
        setStatus: (next) => {
          state.status = next;
        },
        setTodos: () => {},
        setUsage: () => {},
        toolNamesById,
        modifiedFileToolCallIds,
        workspaceDirectory,
      });
    },
    get lastError() {
      return state.lastError;
    },
    get liveModelText() {
      return state.liveModelText;
    },
    get model() {
      return state.model;
    },
    get modifiedFiles() {
      return state.modifiedFiles;
    },
    get messages() {
      return state.messages;
    },
    get queuedInputs() {
      return state.queuedInputs;
    },
    setMessages: (updater) => {
      state.messages = typeof updater === "function" ? updater(state.messages) : updater;
    },
    setQueuedInputs: (updater) => {
      state.queuedInputs = typeof updater === "function" ? updater(state.queuedInputs) : updater;
    },
    get status() {
      return state.status;
    },
    set status(nextStatus: string) {
      state.status = nextStatus;
    },
  };
}

function sessionEvent(type: SessionEventType, payload: unknown): SessionEvent {
  return {
    id: "event-1",
    payload,
    sequenceNumber: 1,
    sessionId: "session-1",
    timestamp: new Date(0),
    traceId: "trace-1",
    type,
  } as SessionEvent;
}
