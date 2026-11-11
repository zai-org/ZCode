import { describe, expect, it } from "vitest";
import {
  CREATE_WORKFLOW_SOURCE_MISSING_ERROR,
  CREATE_WORKFLOW_TOOL_NAME,
  ModelRequestSessionFeature,
  SESSION_ENTRY_SESSION_FEATURES,
  createSessionId,
  type ModelInvocationContext,
  type PermissionBrokerPort,
  type SessionEntryInfo,
  type SessionStorePort,
  type SessionTaskType,
} from "@zcode/contracts";
import type { AgentRuntime } from "../../src/runtime.js";
import type { AgentRuntimeInternal } from "../../src/runtime/internal.js";
import { createRuntimeModel } from "../../src/runtime/methods/runtime-model.js";
import { createWorkflowToolEntry } from "../../src/tool/handlers/create-workflow.js";
import type { ToolEntry, ToolHandler } from "../../src/tool/types.js";
import { createRecordingMessageStore } from "../runtime-output-token-continuation-test-helpers.js";
import { createTestAgentRuntime } from "../test-agent-runtime.js";
import { createTestSessionEventStore } from "../test-event-store.js";
import { createTestModelFactory } from "../test-runtime-model.js";

// 规格：docs/design/v2/model/session-features-header.md「CreateWorkflow 尝试口径的补充规则」。
// 一轮真实的 turn：模型调用一次 CreateWorkflow 再结束，结果经真实 executor 与结算，验证结算之后
// 的下一次模型请求带上 workflow_auto_attempt。
const { WorkflowAuto, WorkflowAutoAttempt, WorkflowCmd } = ModelRequestSessionFeature;
const selection = { providerId: "test", modelId: "model" };

/** 只替换 handler 与权限声明的 CreateWorkflow；不触达脚本分析与草稿落盘。 */
function fakeCreateWorkflow(handler: ToolHandler, permission?: ToolEntry["permission"]): ToolEntry {
  return {
    inputSchema: {},
    metadata: {
      name: CREATE_WORKFLOW_TOOL_NAME,
      concurrentSafe: true,
      destructive: false,
      needsApproval: permission !== undefined,
      readOnly: permission === undefined,
      riskLevel: "low",
      sideEffectScope: "none",
    },
    ...(permission ? { permission } : {}),
    handler,
  } as ToolEntry;
}

async function runTurnWithCreateWorkflow(options: {
  /** 缺省保留 runtime 注册的内置工具面（workflow 子 actor 里没有 CreateWorkflow）。 */
  entry?: ToolEntry;
  input?: Record<string, unknown>;
  broker?: PermissionBrokerPort;
  taskType?: SessionTaskType;
  /** 子 agent 用例：先建一个带该标签的父会话，子会话复用父会话的模型句柄（与真实 subagent 相同）。 */
  parentFeature?: ModelRequestSessionFeature;
  beforeTurn?: (runtime: AgentRuntime) => void;
}) {
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
  const seen: ModelInvocationContext[] = [];
  const brokerRequests: unknown[] = [];
  const scripted = createTestModelFactory({
    async generateText(_request, observation) {
      seen.push(observation.invocationContext!);
      if (seen.length === 1)
        return {
          text: "",
          finishReason: "tool-calls",
          usage: {},
          toolCalls: [
            { id: "call_workflow", name: CREATE_WORKFLOW_TOOL_NAME, input: options.input ?? {} },
          ],
        };
      return { text: "done", finishReason: "stop", usage: {} };
    },
  });
  const parent = options.parentFeature
    ? createTestAgentRuntime(
        createSessionId(`session-features-attempt-parent-${Math.random().toString(36).slice(2)}`),
        { modelSelection: selection },
        { eventStore: createTestSessionEventStore(), modelFactory: scripted },
      )
    : undefined;
  if (parent && options.parentFeature)
    parent.recordSessionFeature({ feature: options.parentFeature });
  const parentModel = parent
    ? createRuntimeModel(parent as unknown as AgentRuntimeInternal, { selection })
    : undefined;
  const runtime = createTestAgentRuntime(
    createSessionId(`session-features-attempt-${Math.random().toString(36).slice(2)}`),
    {
      mode: "yolo",
      modelSelection: selection,
      modelStreaming: "off",
      titleGeneration: { enabled: false },
      ...(options.taskType ? { taskType: options.taskType } : {}),
    },
    {
      eventStore: createTestSessionEventStore(),
      sessionStore,
      ...(options.broker
        ? {
            permissionBroker: {
              requestPermission(request, requestOptions) {
                brokerRequests.push(request);
                return options.broker!.requestPermission(request, requestOptions);
              },
            } satisfies PermissionBrokerPort,
          }
        : {}),
      modelFactory: parentModel ? () => parentModel : scripted,
    },
  );
  if (options.entry) {
    runtime.getToolRegistry().register(options.entry, { silentDuplicateWarning: true });
    runtime.invalidateToolCache();
  }
  options.beforeTurn?.(runtime);
  await runtime.executeTurn("start a workflow");
  await (runtime as unknown as AgentRuntimeInternal).sessionFeaturesWrite;
  const toolPart = store.savedParts.findLast(
    (part: { type: string; tool?: string }) =>
      part.type === "tool" && part.tool === CREATE_WORKFLOW_TOOL_NAME,
  ) as { state: { status: string; error?: string } } | undefined;
  return {
    parentModel,
    seen,
    brokerRequests,
    toolState: toolPart?.state,
    features: seen.map((context) => context.modelRequestSessionFeatures),
    entries: [...entries.values()]
      .filter((entry) => entry.type === SESSION_ENTRY_SESSION_FEATURES)
      .map((entry) => entry.data),
  };
}

describe("CreateWorkflow 尝试口径：工具结果结算打点（端到端）", () => {
  it("handler 抛错：下一次请求带 workflow_auto_attempt，并写入 entry", async () => {
    const turn = await runTurnWithCreateWorkflow({
      entry: fakeCreateWorkflow(async () => {
        throw new Error("engine crashed");
      }),
    });

    expect(turn.toolState).toMatchObject({ status: "error", error: "engine crashed" });
    expect(turn.features).toEqual([undefined, [WorkflowAutoAttempt]]);
    expect(turn.entries).toEqual([{ features: [WorkflowAutoAttempt] }]);
  });

  it("参数校验失败（真实 CreateWorkflow，script / path / saved 都没给）：同样打", async () => {
    const turn = await runTurnWithCreateWorkflow({ entry: createWorkflowToolEntry, input: {} });

    // 前提：失败来自 validateInput 的来源校验，在 hook 与权限之前早退。
    expect(turn.toolState).toMatchObject({
      status: "error",
      error: CREATE_WORKFLOW_SOURCE_MISSING_ERROR,
    });
    expect(turn.features).toEqual([undefined, [WorkflowAutoAttempt]]);
    expect(turn.entries).toEqual([{ features: [WorkflowAutoAttempt] }]);
  });

  it("编译失败：只打 workflow_auto_attempt", async () => {
    const turn = await runTurnWithCreateWorkflow({
      entry: fakeCreateWorkflow(async () => ({ ok: false, diagnostics: [], response: "errors" })),
    });

    expect(turn.toolState?.status).toBe("completed");
    expect(turn.features).toEqual([undefined, [WorkflowAutoAttempt]]);
  });

  it("成功启动：两个标签同时出现", async () => {
    const turn = await runTurnWithCreateWorkflow({
      entry: fakeCreateWorkflow(async () => ({
        ok: true,
        diagnostics: [],
        response: "started",
        status: "backgrounded",
        backgroundTaskId: "run_1",
      })),
    });

    expect(turn.features).toEqual([undefined, [WorkflowAuto, WorkflowAutoAttempt]]);
    expect(turn.entries).toEqual([{ features: [WorkflowAuto, WorkflowAutoAttempt] }]);
  });

  it("用户在确认窗拒绝：不打（yolo 模式下 alwaysAsk 照样弹窗）", async () => {
    let handlerCalls = 0;
    const turn = await runTurnWithCreateWorkflow({
      entry: fakeCreateWorkflow(async () => {
        handlerCalls += 1;
        return { ok: true, diagnostics: [], response: "started", status: "backgrounded" };
      }, createWorkflowToolEntry.permission),
      broker: {
        requestPermission: async () => ({ decision: "deny", reason: "not now" }),
      },
    });

    // 前提：确实弹了窗、被拒绝，模型拿到结果后又发了一次请求。
    expect(turn.brokerRequests).toHaveLength(1);
    expect(handlerCalls).toBe(0);
    expect(turn.toolState).toMatchObject({ status: "error", error: "not now" });
    expect(turn.features).toEqual([undefined, undefined]);
    expect(turn.entries).toEqual([]);
  });

  it("子 agent 复用父句柄：标签只记在子会话上，不带父会话的，父会话也不带子会话的", async () => {
    const child = await runTurnWithCreateWorkflow({
      taskType: "subagent_child",
      parentFeature: WorkflowCmd,
      entry: fakeCreateWorkflow(async () => ({
        ok: true,
        diagnostics: [],
        response: "compiled cleanly",
      })),
    });

    expect(child.features).toEqual([undefined, [WorkflowAutoAttempt]]);
    // 子会话结束后父会话自己发一次请求：只带父会话的标签。
    await child.parentModel!.generateText({ messages: [{ role: "user", content: "hi" }] });
    expect(
      child.seen.map((context) => [
        context.modelRequestSessionType,
        context.modelRequestSessionFeatures,
      ]),
    ).toEqual([
      ["subagent", undefined],
      ["subagent", [WorkflowAutoAttempt]],
      ["main", [WorkflowCmd]],
    ]);
  });

  it("workflow 子 actor：CreateWorkflow 结构性禁用，凭空调用得到 tool_not_found，不打", async () => {
    const turn = await runTurnWithCreateWorkflow({
      taskType: "workflow_child",
      input: { script: "return 1;" },
      beforeTurn: (runtime) => {
        // 前提：子 actor 的工具面里确实没有 CreateWorkflow。
        expect(runtime.getToolRegistry().get(CREATE_WORKFLOW_TOOL_NAME)).toBeUndefined();
      },
    });

    expect(turn.toolState).toMatchObject({
      status: "error",
      error: `Tool not found: ${CREATE_WORKFLOW_TOOL_NAME}`,
    });
    expect(turn.features).toEqual([undefined, undefined]);
    expect(turn.entries).toEqual([]);
  });
});
