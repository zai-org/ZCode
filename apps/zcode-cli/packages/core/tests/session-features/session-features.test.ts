import { describe, expect, it, vi } from "vitest";
import {
  CREATE_WORKFLOW_TOOL_NAME,
  ModelRequestSessionFeature,
  SESSION_ENTRY_SESSION_FEATURES,
  createMessageId,
  createPartId,
  createProjectId,
  createSessionId,
  getCurrentModelInvocationContext,
  runWithModelInvocationContext,
  type Logger,
  type MessageWithParts,
  type ModelInvocationContext,
  type SessionEntryInfo,
  type SessionId,
  type SessionStorePort,
} from "@zcode/contracts";
import type { AgentRuntime } from "../../src/runtime.js";
import type { AgentRuntimeInternal } from "../../src/runtime/internal.js";
import { createRuntimeModel } from "../../src/runtime/methods/runtime-model.js";
import {
  parseSessionFeaturesEntryData,
  readSessionFeatures,
  sessionFeaturesFromPersistedMessages,
  sessionFeaturesFromToolResult,
  writeSessionFeaturesEntryAfterFirstPersist,
} from "../../src/runtime/session-features/contract.js";
import { createToolRegistry } from "../../src/tool/registry.js";
import { createRecordingMessageStore } from "../runtime-output-token-continuation-test-helpers.js";
import { createTestAgentRuntime } from "../test-agent-runtime.js";
import { createTestSessionEventStore } from "../test-event-store.js";
import { createTestModelFactory } from "../test-runtime-model.js";

// 规格：docs/design/v2/model/session-features-header.md。
const { WorkflowAuto, WorkflowAutoAttempt, WorkflowCmd } = ModelRequestSessionFeature;
const selection = { providerId: "test", modelId: "model" };
const modelRequest = { messages: [{ role: "user" as const, content: "hi" }] };
const stopResult = { text: "ok", finishReason: "stop" as const };

function internal(runtime: AgentRuntime): AgentRuntimeInternal {
  return runtime as unknown as AgentRuntimeInternal;
}

function savedFeatureEntries(saveSessionEntry: ReturnType<typeof vi.fn>): string[][] {
  return saveSessionEntry.mock.calls
    .map(([entry]) => entry as SessionEntryInfo)
    .filter((entry) => entry.type === SESSION_ENTRY_SESSION_FEATURES)
    .map((entry) => (entry.data as { features: string[] }).features);
}

function warnLogger() {
  const warn = vi.fn();
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
    child: () => logger,
  } as unknown as Logger;
  return { logger, warn };
}

describe("sessionFeaturesFromToolResult", () => {
  it("只有 CreateWorkflow 成功启动后台 run 才打 workflow_auto", () => {
    const backgrounded = { status: "backgrounded", ok: true, backgroundTaskId: "run_1" };
    expect(
      sessionFeaturesFromToolResult({
        toolName: CREATE_WORKFLOW_TOOL_NAME,
        success: true,
        output: backgrounded,
      }),
    ).toEqual([WorkflowAuto, WorkflowAutoAttempt]);
    // 编译失败与宿主没有 run 端口都返回 success，但没有 backgrounded；只打尝试口径
    // （workflow-auto-attempt.test.ts）。
    for (const output of [
      { ok: false, diagnostics: [], response: "errors" },
      { ok: true, diagnostics: [], response: "compiled cleanly" },
    ]) {
      expect(
        sessionFeaturesFromToolResult({
          toolName: CREATE_WORKFLOW_TOOL_NAME,
          success: true,
          output,
        }),
      ).toEqual([WorkflowAutoAttempt]);
    }
    expect(
      sessionFeaturesFromToolResult({
        toolName: CREATE_WORKFLOW_TOOL_NAME,
        success: false,
        output: backgrounded,
      }),
    ).toEqual([WorkflowAutoAttempt]);
    expect(
      sessionFeaturesFromToolResult({ toolName: "Bash", success: true, output: backgrounded }),
    ).toEqual([]);
  });
});

describe("sessionFeaturesFromPersistedMessages", () => {
  const sessionId = createSessionId("session-features-history");

  it("从 /workflow 原文与 CreateWorkflow 成功 display 推出标签", () => {
    expect(
      sessionFeaturesFromPersistedMessages([
        userMessage(sessionId, "  /workflow tidy the repo"),
        createWorkflowMessage(sessionId, { kind: "create_workflow", ok: true }),
      ]),
    ).toEqual(new Set([WorkflowAuto, WorkflowAutoAttempt, WorkflowCmd]));
  });

  it("不应命中的情况", () => {
    expect(
      sessionFeaturesFromPersistedMessages([
        userMessage(sessionId, "/workflows are cool"),
        userMessage(sessionId, "please run /workflow later"),
        assistantText(sessionId, "/workflow"),
        createWorkflowMessage(sessionId, { kind: "create_workflow", ok: false }),
        createWorkflowMessage(sessionId, undefined),
        createWorkflowMessage(sessionId, { kind: "create_workflow", ok: true }, "error"),
      ]),
      // completed 的 CreateWorkflow part 不论 display 都命中尝试口径（workflow-auto-attempt.test.ts）。
    ).toEqual(new Set([WorkflowAutoAttempt]));
  });
});

describe("parseSessionFeaturesEntryData", () => {
  it("忽略词表外标签与非法载荷", () => {
    expect(
      parseSessionFeaturesEntryData({ features: ["workflow_cmd", "future_feature", 1] }),
    ).toEqual([WorkflowCmd]);
    expect(parseSessionFeaturesEntryData(undefined)).toEqual([]);
    expect(parseSessionFeaturesEntryData({ features: "workflow_cmd" })).toEqual([]);
  });
});

describe("recordSessionFeature（owner）", () => {
  function createRuntime(saveSessionEntry = vi.fn(async (_entry: SessionEntryInfo) => {})) {
    const { logger, warn } = warnLogger();
    const runtime = createTestAgentRuntime(
      createSessionId(`session-features-owner-${Math.random().toString(36).slice(2)}`),
      { modelSelection: selection },
      {
        eventStore: createTestSessionEventStore(),
        logger,
        sessionStore: { saveSessionEntry } as unknown as SessionStorePort,
      },
    );
    return { runtime, saveSessionEntry, warn };
  }

  it("幂等，读取为去重后的字典序", () => {
    const { runtime } = createRuntime();
    expect(runtime.recordSessionFeature({ feature: WorkflowCmd })).toBe(true);
    expect(runtime.recordSessionFeature({ feature: WorkflowAuto })).toBe(true);
    expect(runtime.recordSessionFeature({ feature: WorkflowCmd })).toBe(false);
    expect(readSessionFeatures(internal(runtime))).toEqual([WorkflowAuto, WorkflowCmd]);
  });

  it("未落盘时只改内存；首次落盘后补写一次", async () => {
    const { runtime, saveSessionEntry } = createRuntime();
    runtime.recordSessionFeature({ feature: WorkflowCmd });
    await internal(runtime).sessionFeaturesWrite;
    expect(savedFeatureEntries(saveSessionEntry)).toEqual([]);

    internal(runtime).sessionPersisted = true;
    await writeSessionFeaturesEntryAfterFirstPersist(internal(runtime));
    expect(savedFeatureEntries(saveSessionEntry)).toEqual([[WorkflowCmd]]);
    const entry = saveSessionEntry.mock.calls[0]![0];
    expect(entry).toMatchObject({
      id: `${runtime.getSessionId()}:runtime-session-features`,
      touchSession: false,
    });
  });

  it("没有标签时首次落盘不写", async () => {
    const { runtime, saveSessionEntry } = createRuntime();
    internal(runtime).sessionPersisted = true;
    await writeSessionFeaturesEntryAfterFirstPersist(internal(runtime));
    expect(saveSessionEntry).not.toHaveBeenCalled();
  });

  it("并发打点时写入串行，最后一次写入含全部标签", async () => {
    const gates: Array<() => void> = [];
    const saveSessionEntry = vi.fn(
      (_entry: SessionEntryInfo) => new Promise<void>((resolve) => gates.push(resolve)),
    );
    const { runtime } = createRuntime(saveSessionEntry);
    internal(runtime).sessionPersisted = true;
    runtime.recordSessionFeature({ feature: WorkflowCmd });
    runtime.recordSessionFeature({ feature: WorkflowAuto });
    // 第一次写入还没完成时，第二次不能开始。
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    gates[0]!();
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    gates[1]!();
    await internal(runtime).sessionFeaturesWrite;
    expect(savedFeatureEntries(saveSessionEntry).at(-1)).toEqual([WorkflowAuto, WorkflowCmd]);
  });

  it("写入失败只记 warn，内存标签保留，后续写入照常", async () => {
    const saveSessionEntry = vi
      .fn(async (_entry: SessionEntryInfo) => {})
      .mockRejectedValueOnce(new Error("disk I/O error"));
    const { runtime, warn } = createRuntime(saveSessionEntry);
    internal(runtime).sessionPersisted = true;
    runtime.recordSessionFeature({ feature: WorkflowCmd });
    await internal(runtime).sessionFeaturesWrite;
    expect(warn).toHaveBeenCalledWith(
      "Session features entry write failed",
      expect.objectContaining({ event: "session_features.entry_write_failed" }),
    );
    expect(readSessionFeatures(internal(runtime))).toEqual([WorkflowCmd]);

    runtime.recordSessionFeature({ feature: WorkflowAuto });
    await internal(runtime).sessionFeaturesWrite;
    expect(savedFeatureEntries(saveSessionEntry).at(-1)).toEqual([WorkflowAuto, WorkflowCmd]);
  });
});

describe("冷恢复", () => {
  async function resume(input: {
    messages: MessageWithParts[];
    entries?: SessionEntryInfo[];
    failEntryRead?: boolean;
    /** 只让前 N 次 entry 读取失败（默认全部失败）。 */
    failEntryReadTimes?: number;
  }) {
    const sessionId = createSessionId(
      `session-features-resume-${Math.random().toString(36).slice(2)}`,
    );
    const saveSessionEntry = vi.fn(async (_entry: SessionEntryInfo) => {});
    const { logger, warn } = warnLogger();
    let featureReads = 0;
    const store = {
      getSession: vi.fn(async () => persistedSession(sessionId)),
      messages: vi.fn(async () => input.messages),
      sessionEntries: vi.fn(async ({ type }: { type?: string }) => {
        if (type !== SESSION_ENTRY_SESSION_FEATURES) return [];
        featureReads += 1;
        const failing =
          input.failEntryRead === true &&
          (input.failEntryReadTimes === undefined || featureReads <= input.failEntryReadTimes);
        if (failing) throw new Error("database is locked");
        return input.entries ?? [];
      }),
      readTodos: vi.fn(async () => []),
      readTarget: vi.fn(async () => null),
      saveMessage: vi.fn(async () => {}),
      savePart: vi.fn(async () => {}),
      saveSessionEntry,
      updateSession: vi.fn(async () => persistedSession(sessionId)),
    } as unknown as SessionStorePort;
    const runtime = createTestAgentRuntime(
      sessionId,
      { modelSelection: selection, workingDirectory: "/workspace/project" },
      { eventStore: createTestSessionEventStore(), logger, sessionStore: store },
    );
    await runtime.resumeFromStore();
    await internal(runtime).sessionFeaturesWrite;
    return {
      runtime,
      writes: savedFeatureEntries(saveSessionEntry),
      saveSessionEntry,
      sessionId,
      warn,
    };
  }

  // MR !3185 评审第二轮 SG-01：恢复时没读到 entry，之后打新标签也不能用不完整的内存集合覆盖它。
  it("恢复时读 entry 失败、之后再打新标签：写入前合并 entry 原有标签", async () => {
    const sessionId = createSessionId("entry-read-failure-then-record");
    const { runtime, saveSessionEntry } = await resume({
      // 历史里推不出 workflow_auto：它只存在于 entry 中。
      messages: [],
      entries: [featuresEntry(sessionId, ["workflow_auto"])],
      failEntryRead: true,
      failEntryReadTimes: 1,
    });
    expect(readSessionFeatures(internal(runtime))).toEqual([]);

    runtime.recordSessionFeature({ feature: WorkflowCmd });
    await internal(runtime).sessionFeaturesWrite;
    expect(savedFeatureEntries(saveSessionEntry)).toEqual([[WorkflowAuto, WorkflowCmd]]);
    // 读到的 entry 标签同时并回内存，之后的请求也带上它。
    expect(readSessionFeatures(internal(runtime))).toEqual([WorkflowAuto, WorkflowCmd]);
  });

  it("写入前读 entry 仍失败：跳过这次写入并记 warn，内存标签保留", async () => {
    const sessionId = createSessionId("entry-read-failure-on-write");
    const { runtime, saveSessionEntry, warn } = await resume({
      messages: [],
      entries: [featuresEntry(sessionId, ["workflow_auto"])],
      failEntryRead: true,
    });
    runtime.recordSessionFeature({ feature: WorkflowCmd });
    await internal(runtime).sessionFeaturesWrite;
    expect(savedFeatureEntries(saveSessionEntry)).toEqual([]);
    // 恢复时一次、写入前一次。
    expect(
      warn.mock.calls.filter(
        ([, context]) =>
          (context as { event?: string } | undefined)?.event ===
          "session_features.entry_read_failed",
      ),
    ).toHaveLength(2);
    expect(readSessionFeatures(internal(runtime))).toEqual([WorkflowCmd]);
  });

  // MR !3185 评审 SG-01：标签只用于统计，entry 读取失败不能阻断冷恢复。
  it("entry 读取抛错：恢复照常完成，标签来自历史，记 warn 且不覆盖 entry", async () => {
    const sessionId = createSessionId("entry-read-failure");
    const { runtime, writes, warn } = await resume({
      messages: [userMessage(sessionId, "/workflow summarize")],
      failEntryRead: true,
    });
    expect(readSessionFeatures(internal(runtime))).toEqual([WorkflowCmd]);
    expect(warn).toHaveBeenCalledWith(
      "Session features entry read failed",
      expect.objectContaining({
        error: "database is locked",
        event: "session_features.entry_read_failed",
      }),
    );
    // 读不到就不知道 entry 里原有什么：此时补写可能用较少的标签覆盖它。
    expect(writes).toEqual([]);
  });

  it("只有 entry：恢复 entry 里的标签，不重写；词表外标签忽略", async () => {
    const sessionId = createSessionId("any");
    const { runtime, writes } = await resume({
      messages: [],
      entries: [featuresEntry(sessionId, ["workflow_auto", "future_feature"])],
    });
    expect(readSessionFeatures(internal(runtime))).toEqual([WorkflowAuto]);
    expect(writes).toEqual([]);
  });

  it("只有历史：推出标签并补写 entry（fork 子会话走这条）", async () => {
    const sessionId = createSessionId("history-only");
    const { runtime, writes } = await resume({
      messages: [userMessage(sessionId, "/workflow summarize")],
    });
    expect(readSessionFeatures(internal(runtime))).toEqual([WorkflowCmd]);
    expect(writes).toEqual([[WorkflowCmd]]);
  });

  it("entry ∪ 历史；并集比 entry 多时补写", async () => {
    const sessionId = createSessionId("union");
    const { runtime, writes } = await resume({
      messages: [userMessage(sessionId, "/workflow go")],
      entries: [featuresEntry(sessionId, ["workflow_auto"])],
    });
    expect(readSessionFeatures(internal(runtime))).toEqual([WorkflowAuto, WorkflowCmd]);
    expect(writes).toEqual([[WorkflowAuto, WorkflowCmd]]);
  });

  it("没有任何标签时不写", async () => {
    const { runtime, writes } = await resume({ messages: [] });
    expect(readSessionFeatures(internal(runtime))).toEqual([]);
    expect(writes).toEqual([]);
  });
});

describe("runtime 模型句柄", () => {
  function runtimeWithCapture(seen: ModelInvocationContext[], taskType?: "subagent_child") {
    return createTestAgentRuntime(
      createSessionId(`session-features-model-${Math.random().toString(36).slice(2)}`),
      { modelSelection: selection, ...(taskType ? { taskType } : {}) },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          async generateText(_request, observation) {
            seen.push(observation.invocationContext!);
            return stopResult;
          },
          async *streamText() {
            await Promise.resolve();
            seen.push(getCurrentModelInvocationContext()!);
            yield { type: "finish", finishReason: "stop" };
          },
        }),
      },
    );
  }

  it("同一句柄在会话中途新增标签后，下一次调用（含 bind、stream）带上新值", async () => {
    const seen: ModelInvocationContext[] = [];
    const runtime = runtimeWithCapture(seen);
    const model = createRuntimeModel(internal(runtime), { selection });
    await model.generateText(modelRequest);
    runtime.recordSessionFeature({ feature: WorkflowCmd });
    await model.bind({ maxOutputTokens: 64 }).generateText(modelRequest);
    runtime.recordSessionFeature({ feature: WorkflowAuto });
    for await (const _event of model.streamText(modelRequest)) {
      /* 消费完整流。 */
    }
    expect(seen.map((context) => context.modelRequestSessionFeatures)).toEqual([
      undefined,
      [WorkflowCmd],
      [WorkflowAuto, WorkflowCmd],
    ]);
  });

  it("标题、compact 等用途继承宿主标签；调用层带进来的值被覆盖", async () => {
    const seen: ModelInvocationContext[] = [];
    const runtime = runtimeWithCapture(seen);
    const model = createRuntimeModel(internal(runtime), { selection });
    for (const querySource of ["compact", "session_title"]) {
      await runWithModelInvocationContext(
        { metadata: { querySource }, modelRequestSessionFeatures: [WorkflowAuto] },
        () => model.generateText(modelRequest),
      );
    }
    runtime.recordSessionFeature({ feature: WorkflowCmd });
    await runWithModelInvocationContext({ metadata: { querySource: "web_search_tool" } }, () =>
      model.generateText(modelRequest),
    );
    expect(seen.map((context) => context.modelRequestSessionFeatures)).toEqual([
      undefined,
      undefined,
      [WorkflowCmd],
    ]);
  });

  it("工作区独立请求不带标签", async () => {
    const seen: ModelInvocationContext[] = [];
    const runtime = runtimeWithCapture(seen);
    runtime.recordSessionFeature({ feature: WorkflowCmd });
    const model = createRuntimeModel(internal(runtime), { selection, scope: "workspace" });
    await model.generateText(modelRequest);
    expect(seen.map((context) => context.modelRequestSessionFeatures)).toEqual([undefined]);
  });

  it("subagent 复用父句柄时只带子会话自己的标签", async () => {
    const seen: ModelInvocationContext[] = [];
    const parent = runtimeWithCapture(seen);
    parent.recordSessionFeature({ feature: WorkflowCmd });
    const parentModel = createRuntimeModel(internal(parent), { selection });
    const child = createTestAgentRuntime(
      createSessionId("session-features-model-child"),
      { modelSelection: selection, taskType: "subagent_child" },
      { eventStore: createTestSessionEventStore(), modelFactory: () => parentModel },
    );
    const childModel = createRuntimeModel(internal(child), { selection });

    await childModel.generateText(modelRequest);
    child.recordSessionFeature({ feature: WorkflowAuto });
    await childModel.generateText(modelRequest);
    await parentModel.generateText(modelRequest);

    expect(
      seen.map((context) => [context.modelRequestSessionType, context.modelRequestSessionFeatures]),
    ).toEqual([
      ["subagent", undefined],
      ["subagent", [WorkflowAuto]],
      ["main", [WorkflowCmd]],
    ]);
  });
});

describe("工具结果结算打点（端到端）", () => {
  async function runTurnWithCreateWorkflow(output: Record<string, unknown>) {
    const store = createRecordingMessageStore();
    const entries = new Map<string, SessionEntryInfo>();
    const sessionStore = {
      ...store,
      async getProjectPermission() {
        return null;
      },
      async saveSessionEntry(entry: SessionEntryInfo) {
        entries.set(entry.id, entry);
      },
    } as unknown as SessionStorePort;
    const registry = createToolRegistry();
    const fakeCreateWorkflow = {
      inputSchema: {},
      metadata: {
        name: CREATE_WORKFLOW_TOOL_NAME,
        concurrentSafe: true,
        destructive: false,
        needsApproval: false,
        readOnly: true,
        riskLevel: "low",
        sideEffectScope: "none",
      },
      handler: async () => output,
    };
    const seen: ModelInvocationContext[] = [];
    const runtime = createTestAgentRuntime(
      createSessionId(`session-features-turn-${Math.random().toString(36).slice(2)}`),
      { mode: "yolo", modelStreaming: "off", titleGeneration: { enabled: false } },
      {
        eventStore: createTestSessionEventStore(),
        sessionStore,
        toolRegistry: registry,
        modelFactory: createTestModelFactory({
          async generateText(_request, observation) {
            seen.push(observation.invocationContext!);
            if (seen.length === 1)
              return {
                text: "",
                finishReason: "tool-calls",
                usage: {},
                toolCalls: [{ id: "call_workflow", name: CREATE_WORKFLOW_TOOL_NAME, input: {} }],
              };
            return { text: "done", finishReason: "stop", usage: {} };
          },
        }),
      },
    );
    // runtime 构造时注册内置工具，之后再换成只返回给定输出的假 CreateWorkflow。
    runtime.getToolRegistry().register(fakeCreateWorkflow, { silentDuplicateWarning: true });
    runtime.invalidateToolCache();
    await runtime.executeTurn("start a workflow");
    await internal(runtime).sessionFeaturesWrite;
    return {
      features: seen.map((context) => context.modelRequestSessionFeatures),
      entries: [...entries.values()].filter(
        (entry) => entry.type === SESSION_ENTRY_SESSION_FEATURES,
      ),
    };
  }

  it("CreateWorkflow backgrounded：下一次模型请求带 workflow_auto，并写入 entry", async () => {
    const { features, entries } = await runTurnWithCreateWorkflow({
      ok: true,
      diagnostics: [],
      response: "started",
      status: "backgrounded",
      backgroundTaskId: "run_1",
    });
    expect(features).toEqual([undefined, [WorkflowAuto, WorkflowAutoAttempt]]);
    expect(entries.map((entry) => entry.data)).toEqual([
      { features: [WorkflowAuto, WorkflowAutoAttempt] },
    ]);
  });

  it("只编译不启动：不打 workflow_auto，只打 workflow_auto_attempt", async () => {
    const { features, entries } = await runTurnWithCreateWorkflow({
      ok: true,
      diagnostics: [],
      response: "compiled cleanly",
    });
    expect(features).toEqual([undefined, [WorkflowAutoAttempt]]);
    expect(entries.map((entry) => entry.data)).toEqual([{ features: [WorkflowAutoAttempt] }]);
  });
});

function persistedSession(sessionId: SessionId) {
  return {
    id: sessionId,
    projectID: createProjectId("session-features"),
    directory: "/workspace/project",
    slug: "session-features",
    title: "session features",
    version: "test",
    taskType: "interactive",
    time: { created: 1, updated: 1 },
  };
}

function featuresEntry(sessionId: SessionId, features: string[]): SessionEntryInfo {
  return {
    id: `${sessionId}:runtime-session-features`,
    sessionID: sessionId,
    type: SESSION_ENTRY_SESSION_FEATURES,
    time: { created: 1, updated: 1 },
    data: { features },
  };
}

function userMessage(sessionId: SessionId, text: string): MessageWithParts {
  return textMessage(sessionId, "user", text);
}

function assistantText(sessionId: SessionId, text: string): MessageWithParts {
  return textMessage(sessionId, "assistant", text);
}

function textMessage(
  sessionId: SessionId,
  role: "user" | "assistant",
  text: string,
): MessageWithParts {
  const messageId = createMessageId();
  return {
    info: { id: messageId, sessionID: sessionId, role, agent: "zcode-agent", time: { created: 1 } },
    parts: [
      { id: createPartId("u"), messageID: messageId, sessionID: sessionId, type: "text", text },
    ],
  } as unknown as MessageWithParts;
}

function createWorkflowMessage(
  sessionId: SessionId,
  display: Record<string, unknown> | undefined,
  status: "completed" | "error" = "completed",
): MessageWithParts {
  const messageId = createMessageId();
  const state =
    status === "completed"
      ? {
          status,
          input: {},
          output: "started",
          title: CREATE_WORKFLOW_TOOL_NAME,
          metadata: display === undefined ? {} : { display },
          time: { start: 1, end: 2 },
        }
      : { status, input: {}, error: "failed", metadata: { display }, time: { start: 1, end: 2 } };
  return {
    info: {
      id: messageId,
      sessionID: sessionId,
      role: "assistant",
      agent: "zcode-agent",
      time: { created: 2, completed: 3 },
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      {
        id: createPartId("t"),
        messageID: messageId,
        sessionID: sessionId,
        type: "tool",
        callID: "call_1",
        tool: CREATE_WORKFLOW_TOOL_NAME,
        state,
      },
    ],
  } as unknown as MessageWithParts;
}
