import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  AgentErrorCode,
  CoreErrorType,
  SEND_MESSAGE_TOOL_NAME,
  SessionEventType,
  createSessionEvent,
  createSessionId,
  createToolCallId,
  createTraceId,
  createTurnId,
  isCoreError,
  readAgentFailureHandback,
  type SessionEvent,
  type SessionId,
} from "@zcode/contracts";
import { createTurnFailureError } from "../src/runtime/helpers/turn-errors.js";
import {
  createExploreSubagentPort,
  type ExploreSubagentPortOptions,
} from "../src/subagent/runner.js";
import { createErrorResult } from "../src/tool/executor/errors.js";
import { agentToolEntry } from "../src/tool/handlers/agent.js";
import { createRecordingSubagentSessionStore } from "./subagent-test-store.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

// 回归 2026-11-09：同步子代理跑了几十步后 provider 限流，父模型只收到 429 原文、没有 agentId，
// 无法用 SendMessage 续接。工具调用仍是失败；只给模型的文本附部分报告（有正文时）、agentId 行和 usage。
const PROVIDER_FAILURE = "Provider rate limited the request (HTTP 429)";
const PARTIAL_OUTPUT_NOTE = "Everything below is PARTIAL output recovered from the agent";
const AGENT_ID_LINE =
  /agentId: (agent_[\w-]+) \(use SendMessage with to: '\1', summary: '<5-10 word recap>' to continue this agent\)/;

function createFailingChildScenario(childSteps: (step: number) => unknown) {
  const sessionId = createSessionId(`runtime-sync-subagent-failure-${crypto.randomUUID()}`);
  const eventStore = createTestSessionEventStore();
  const parentRequests: any[] = [];
  let parentCallCount = 0;
  let childCallCount = 0;
  const runtime = createTestAgentRuntime(
    sessionId,
    { mode: "build", workingDirectory: "/workspace/project" },
    {
      eventStore,
      sessionStore: createRecordingSubagentSessionStore(),
      modelFactory: createTestModelFactory({
        async generateText(request: any) {
          const toolNames = (request.tools ?? []).map((tool: any) => tool.name);
          if (toolNames.includes("Agent")) {
            parentRequests.push(request);
            parentCallCount++;
            if (parentCallCount === 1) {
              return {
                finishReason: "tool-calls",
                providerMetadata: undefined,
                text: "",
                toolCalls: [
                  {
                    id: "call_failing_explore",
                    name: "Agent",
                    input: {
                      description: "Review module",
                      prompt: "Review the module and report findings.",
                      subagent_type: "Explore",
                    },
                  },
                ],
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "parent saw the failure",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          }
          childCallCount++;
          return childSteps(childCallCount);
        },
      } as never),
    },
  );
  return { eventStore, parentRequests, runtime, sessionId };
}

function childTodoStep(text: string, id: string) {
  return {
    finishReason: "tool-calls",
    providerMetadata: undefined,
    text,
    toolCalls: [
      {
        id,
        name: "TodoWrite",
        input: {
          todos: [{ content: "Review the module", priority: "high", status: "in_progress" }],
        },
      },
    ],
    usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
  };
}

const FAILED_AGENT_TOOL_CALL = { id: "call_failed_agent", input: {}, name: "Agent" };

// 端口级场景：桩掉 runExploreAgent，直接驱动 runner 的失败分支。
async function runPortChild(
  agentId: string,
  runExploreAgent: ExploreSubagentPortOptions["runExploreAgent"],
  options: Partial<ExploreSubagentPortOptions> = {},
) {
  const port = createExploreSubagentPort({
    createAgentId: () => agentId,
    outputRootDir: await mkdtemp(join(tmpdir(), "zcode-subagent-sync-failure-")),
    async emitParentEvent() {},
    runExploreAgent,
    ...options,
  });
  const sessionId = createSessionId(`parent_${agentId}`);
  const turnId = createTurnId(`turn_${agentId}`);
  const rejection = port
    .run({
      agentType: "Explore",
      description: "Port child",
      parentToolCallId: createToolCallId(`call_${agentId}`),
      prompt: "Review the module.",
      sessionId,
      trace: { traceId: createTraceId(), sessionId, turnId },
      turnId,
      workingDirectory: "/tmp",
      workspaceRoot: "/tmp",
    })
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  return { port, rejection };
}

function childModelStep(sessionId: SessionId, text: string, toolCallCount: number) {
  return createSessionEvent(SessionEventType.ModelComplete, sessionId, {
    content: text,
    querySource: "subagent",
    toolCallCount,
    usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
  });
}

describe("sync subagent failure hand-back", () => {
  it("gives the parent model the partial report and agentId while the call stays failed", async () => {
    const { eventStore, parentRequests, runtime, sessionId } = createFailingChildScenario(
      (step) => {
        if (step === 1) return childTodoStep("Interim findings: module A is fine.", "call_todo_1");
        if (step === 2) return childTodoStep("", "call_todo_2");
        throw new Error(PROVIDER_FAILURE);
      },
    );

    const result = await runtime.executeTurn("Use an explore agent to review the module");
    const parentToolMessage = parentRequests[1].messages.find(
      (message: any) => message.role === "tool",
    );
    const modelText = String(parentToolMessage.content);

    expect(result.response).toBe("parent saw the failure");
    expect(modelText.startsWith(PROVIDER_FAILURE)).toBe(true);
    expect(modelText).toContain(PARTIAL_OUTPUT_NOTE);
    expect(modelText).toContain("[Subagent hand-back]");
    expect(modelText).toContain("  Interim findings: module A is fine.");
    expect(modelText).toMatch(AGENT_ID_LINE);
    expect(modelText).toContain("<usage>subagent_tokens: 14\ntool_uses: 2\nduration_ms: ");
    // 截断说明在原文之后、部分报告之前；agentId 行在部分报告之后。
    expect(modelText.indexOf(PARTIAL_OUTPUT_NOTE)).toBeLessThan(
      modelText.indexOf("[Subagent hand-back]"),
    );
    expect(modelText.indexOf("Interim findings")).toBeLessThan(modelText.search(AGENT_ID_LINE));

    // UI 与 App 读的错误摘要不变：只有 provider 原文，不带 agentId 和部分报告。
    const events = await eventStore.getEvents(sessionId);
    const toolError = events.find((event) => event.type === SessionEventType.ToolCallError);
    expect((toolError?.payload as any)?.error?.message).toBe(PROVIDER_FAILURE);
    expect(JSON.stringify(toolError?.payload)).not.toContain("agentId:");
    expect(JSON.stringify(toolError?.payload)).not.toContain("Interim findings");
    const stopped = events.find((event) => event.type === SessionEventType.SubagentStopped);
    expect((stopped?.payload as any)?.status).toBe("failed");
  });

  it("still gives the agentId when the child failed before writing any text", async () => {
    const { parentRequests, runtime } = createFailingChildScenario(() => {
      throw new Error(PROVIDER_FAILURE);
    });

    await runtime.executeTurn("Use an explore agent to review the module");
    const parentToolMessage = parentRequests[1].messages.find(
      (message: any) => message.role === "tool",
    );
    const modelText = String(parentToolMessage.content);

    expect(modelText.startsWith(PROVIDER_FAILURE)).toBe(true);
    expect(modelText).toMatch(AGENT_ID_LINE);
    expect(modelText).toContain("tool_uses: 0");
    expect(modelText).not.toContain(PARTIAL_OUTPUT_NOTE);
    expect(modelText).not.toContain("[Subagent hand-back]");
  });

  it("adds no hand-back when the child fails before its session is ready", async () => {
    const { rejection } = await runPortChild("agent_pre_ready_failure", async () => {
      throw new Error(PROVIDER_FAILURE);
    });
    const error = await rejection;

    expect(error).toBeInstanceOf(Error);
    expect(readAgentFailureHandback(error)).toBeUndefined();
    expect(agentToolEntry.formatErrorModelContent?.(error)).toBeUndefined();
  });

  it("keeps the original CoreError, its stack and its UI summary when it attaches the hand-back", async () => {
    // 回归评审 P1：曾复制错误再挂数据，Node 的 stack accessor 在复制品上读到 undefined。
    const providerError = Object.assign(new Error(PROVIDER_FAILURE), {
      code: "model_rate_limited",
      name: "AiSdkModelAdapterError",
    });
    const turnError = createTurnFailureError(providerError, undefined, "Turn execution failed");
    const originalStack = turnError.stack;
    const uiErrorBefore = createErrorResult(FAILED_AGENT_TOOL_CALL, turnError).error;
    const { rejection } = await runPortChild("agent_core_error_failure", async (request) => {
      await request.onSessionReady?.();
      request.onEvent?.(childModelStep(request.sessionId, "Core error findings.", 1));
      throw turnError;
    });
    const error = await rejection;

    expect(error).toBe(turnError);
    expect(typeof originalStack).toBe("string");
    expect((error as Error).stack).toBe(originalStack);
    expect(Object.keys(error as object)).not.toContain("agentFailureHandback");
    expect(readAgentFailureHandback(error)).toMatchObject({
      agentId: "agent_core_error_failure",
      report: "Core error findings.",
      totalTokens: 5,
      totalToolUseCount: 1,
    });
    const result = createErrorResult(FAILED_AGENT_TOOL_CALL, error as Error, 0, {
      modelNote: agentToolEntry.formatErrorModelContent?.(error),
    });
    expect(result.error).toEqual(uiErrorBefore);
    expect(String(result.modelContent).startsWith(PROVIDER_FAILURE)).toBe(true);
    expect(String(result.modelContent)).toContain("  Core error findings.");
  });

  it("attaches the hand-back to the lifecycle wrapper when the child throws a plain error", async () => {
    const { rejection } = await runPortChild("agent_plain_error_failure", async (request) => {
      await request.onSessionReady?.();
      request.onEvent?.(childModelStep(request.sessionId, "Wrapper findings.", 2));
      throw new Error(PROVIDER_FAILURE);
    });
    const error = await rejection;

    expect(isCoreError(error)).toBe(true);
    if (!isCoreError(error)) return;
    expect(error.type).toBe(CoreErrorType.ToolExecutionFailed);
    expect(error.context?.code).toBe(AgentErrorCode.CHILD_RUNTIME_FAILED);
    expect(typeof error.stack).toBe("string");
    expect(readAgentFailureHandback(error)).toMatchObject({
      report: "Wrapper findings.",
      totalToolUseCount: 2,
    });
    const result = createErrorResult(FAILED_AGENT_TOOL_CALL, error, 0, {
      modelNote: agentToolEntry.formatErrorModelContent?.(error),
    });
    expect(result.error?.message).toBe(PROVIDER_FAILURE);
    expect(result.error?.stack).toBe(error.stack);
    expect(String(result.modelContent)).toContain(PARTIAL_OUTPUT_NOTE);
    expect(String(result.modelContent)).toMatch(AGENT_ID_LINE);
  });

  it("counts billed failed requests and ignores events from other sessions in the hand-back", async () => {
    // 回归评审 P3-1 / P3-2：用量口径与同步完成相同，计入已计费的失败请求；
    // sink 还会转发其他 session 的事件，只认本 child session 的 step。
    const { rejection } = await runPortChild("agent_usage_failure", async (request) => {
      await request.onSessionReady?.();
      request.onEvent?.(childModelStep(request.sessionId, "Own findings.", 1));
      request.onEvent?.(
        createSessionEvent(SessionEventType.ModelNetworkStatus, request.sessionId, {
          type: "model_request_failed",
          usage: { inputTokens: 6, outputTokens: 3, totalTokens: 9 },
        }),
      );
      request.onEvent?.(
        childModelStep(createSessionId("sess_other_session"), "Foreign findings.", 4),
      );
      throw new Error(PROVIDER_FAILURE);
    });

    const error = await rejection;

    expect(readAgentFailureHandback(error)).toMatchObject({
      report: "Own findings.",
      totalTokens: 14,
      totalToolUseCount: 1,
    });
  });

  it("records the provider text, not the turn wrapper, in the failed task and its artifacts", async () => {
    // 回归：同步失败分支原来直接读 error.message，child turn 的 wrapper 文字 "Turn execution failed"
    // 盖住了 provider 原文，TaskOutput、metadata.json、输出文件和 SubagentStopped 都看不到真实原因。
    const events: SessionEvent[] = [];
    const { port, rejection } = await runPortChild(
      "agent_failure_artifacts",
      async (request) => {
        await request.onSessionReady?.();
        throw createTurnFailureError(
          new Error(PROVIDER_FAILURE),
          undefined,
          "Turn execution failed",
        );
      },
      {
        async emitParentEvent(event) {
          events.push(event);
        },
      },
    );
    await rejection;

    const task = await port.getTask?.("agent_failure_artifacts");
    expect(task).toMatchObject({ status: "failed", error: PROVIDER_FAILURE });
    const outputDir = dirname(task!.outputFile!);
    const metadata = JSON.parse(await readFile(join(outputDir, "metadata.json"), "utf8"));
    expect(metadata).toMatchObject({ status: "failed", error: PROVIDER_FAILURE });
    expect(await readFile(task!.outputFile!, "utf8")).toBe(PROVIDER_FAILURE);
    expect(await readFile(join(outputDir, "task.output"), "utf8")).toBe(PROVIDER_FAILURE);
    expect(
      events.find((event) => event.type === SessionEventType.SubagentStopped)?.payload,
    ).toMatchObject({ status: "failed", error: PROVIDER_FAILURE });
  });

  it("adds no hand-back when the user stops the child", async () => {
    let markRunning!: () => void;
    const running = new Promise<void>((resolve) => {
      markRunning = resolve;
    });
    const { port, rejection } = await runPortChild(
      "agent_user_stopped",
      async (request, options) => {
        await request.onSessionReady?.();
        request.onEvent?.(childModelStep(request.sessionId, "Findings before the stop.", 1));
        markRunning();
        return new Promise((_, reject) => {
          options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
            once: true,
          });
        });
      },
    );
    await running;
    await port.stopTask?.("agent_user_stopped", { initiator: "user" });
    const error = await rejection;

    expect(isCoreError(error) && error.type).toBe(CoreErrorType.ToolCancelled);
    expect(readAgentFailureHandback(error)).toBeUndefined();
  });

  it("attaches the hand-back and keeps the timeout type when the inactivity watchdog fails the child", async () => {
    const { rejection } = await runPortChild(
      "agent_inactive_failure",
      async (request) => {
        await request.onSessionReady?.();
        request.onEvent?.(childModelStep(request.sessionId, "Findings before going quiet.", 1));
        return new Promise(() => {});
      },
      { inactivityTimeoutMs: 20 },
    );
    const error = await rejection;

    expect(isCoreError(error) && error.type).toBe(CoreErrorType.ToolTimeout);
    expect(readAgentFailureHandback(error)?.report).toBe("Findings before going quiet.");
    expect(agentToolEntry.formatErrorModelContent?.(error)).toMatch(AGENT_ID_LINE);
  });

  it("lets the parent continue the failed child through SendMessage with the handed-back agentId", async () => {
    const sessionId = createSessionId(`runtime-sync-subagent-continue-${crypto.randomUUID()}`);
    const resumedChildRequests: string[] = [];
    const sendMessageResults: string[] = [];
    const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
    let continuedAgentId = "";
    let parentCalls = 0;
    let childCalls = 0;
    const toolMessageText = (request: any) =>
      (request.messages ?? [])
        .filter((message: any) => message.role === "tool")
        .map((message: any) => String(message.content))
        .join("\n");
    const runtime = createTestAgentRuntime(
      sessionId,
      { mode: "build", workingDirectory: "/workspace/project" },
      {
        eventStore: createTestSessionEventStore(),
        sessionStore: createRecordingSubagentSessionStore(),
        modelFactory: createTestModelFactory({
          async generateText(request: any, observation: any) {
            if (observation.invocationContext?.metadata?.querySource !== "subagent") {
              parentCalls++;
              if (parentCalls === 1) {
                return {
                  finishReason: "tool-calls",
                  text: "",
                  toolCalls: [
                    {
                      id: "call_failing_explore",
                      name: "Agent",
                      input: {
                        description: "Review module",
                        prompt: "Review the module and report findings.",
                        subagent_type: "Explore",
                      },
                    },
                  ],
                  usage,
                };
              }
              if (parentCalls === 2) {
                // 父模型只能从失败的 Agent 结果里读到 agentId，再用它发 SendMessage。
                continuedAgentId = toolMessageText(request).match(AGENT_ID_LINE)?.[1] ?? "";
                return {
                  finishReason: "tool-calls",
                  text: "",
                  toolCalls: [
                    {
                      id: "call_continue_child",
                      name: SEND_MESSAGE_TOOL_NAME,
                      input: {
                        to: continuedAgentId,
                        summary: "continue the review",
                        message: "Continue the review from where you stopped.",
                      },
                    },
                  ],
                  usage,
                };
              }
              // 只记录紧跟 SendMessage 的这次调用；子代理完成后的后台通知还会再开一轮父会话调用。
              if (parentCalls === 3) sendMessageResults.push(toolMessageText(request));
              return { finishReason: "stop", text: "parent done", usage };
            }
            childCalls++;
            if (childCalls === 1) {
              return childTodoStep("Interim findings: module A is fine.", "call_todo_1");
            }
            if (childCalls === 2) throw new Error(PROVIDER_FAILURE);
            resumedChildRequests.push(JSON.stringify(request.messages));
            return { finishReason: "stop", text: "Final review report.", usage };
          },
        } as never),
      },
    );
    const subagentPort = (runtime as unknown as { subagentPort: any }).subagentPort;

    const result = await runtime.executeTurn("Use an explore agent to review the module");
    const resumed = await subagentPort.waitForTask(continuedAgentId);

    expect(result.response).toBe("parent done");
    expect(continuedAgentId).toMatch(/^agent_/);
    expect(sendMessageResults.join("\n")).toContain("resumed it in the background");
    expect(resumed).toMatchObject({ agentId: continuedAgentId, status: "completed" });
    expect(childCalls).toBe(3);
    expect(resumedChildRequests[0]).toContain("Interim findings: module A is fine.");
    expect(resumedChildRequests[0]).toContain("Continue the review from where you stopped.");
  });
});
