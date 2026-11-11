import { describe, expect, it, vi } from "vitest";
import {
  HookEventName,
  RESPOND_TO_COORDINATOR_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  SessionEventType,
  createSessionId,
  modelMessageContentToText,
  type ModelMessageContent,
  type CoordinatorResponsePort,
  type SubagentPort,
  type SubagentSendMessageRequest,
} from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createInMemoryHookRunner } from "../src/hooks/index.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { respondToCoordinatorToolEntry } from "../src/tool/handlers/respond-to-coordinator.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { createRuntimeCommandId } from "../src/runtime/command-queue.js";

describe("AgentRuntime lifecycle hooks", () => {
  it("queues deferred input as TurnSteerQueued when no active turn is steerable", async () => {
    const sessionId = createSessionId("runtime-deferred-input");
    const eventStore = createTestSessionEventStore();
    const runtime = createTestAgentRuntime(sessionId, {}, { eventStore });

    const result = await runtime.enqueueDeferredInput({
      input: "验证期间追加",
      inputId: "cmd-deferred",
    });

    if (result.kind !== "queued") {
      throw new Error(`unexpected deferred input result: ${result.kind}`);
    }
    const events = await eventStore.getEvents(sessionId);
    const queued = events.find((event) => event.type === SessionEventType.TurnSteerQueued);
    expect(queued?.payload).toMatchObject({
      delivery: "queue",
      input: "验证期间追加",
      inputId: "cmd-deferred",
      pendingInputId: result.pendingInputId,
      targetTurnId: "deferred",
    });
  });

  it("accepts attachment-only deferred input and preserves canonical refs", async () => {
    const sessionId = createSessionId("runtime-deferred-attachment-only");
    const eventStore = createTestSessionEventStore();
    const runtime = createTestAgentRuntime(sessionId, {}, { eventStore });
    const attachmentRefs = [
      { ref: "artifact://note", fileName: "note.txt", mime: "text/plain", bytes: 9 },
    ];

    const result = await runtime.enqueueDeferredInput({
      input: "",
      inputId: "cmd-attachment-only",
      attachments: [
        {
          type: "file",
          content: "note body",
          path: "note.txt",
          filename: "note.txt",
          mimeType: "text/plain",
          sizeBytes: 9,
        },
      ],
      intent: {
        sourceCommandId: "cmd-attachment-only",
        clientId: "mobile-client",
        kind: "sendText",
        admissionSeq: 1,
        admittedAt: 1_234,
        requestedDelivery: "guide",
        admittedDelivery: "queue",
        attachmentRefs,
      },
    });

    expect(result.kind).toBe("queued");
    const queued = (await eventStore.getEvents(sessionId)).find(
      (event) => event.type === SessionEventType.TurnSteerQueued,
    );
    expect(queued?.payload).toMatchObject({
      input: "",
      inputId: "cmd-attachment-only",
      intent: { attachmentRefs },
    });
  });

  it("rejects deferred input only when both text and attachments are empty", async () => {
    const sessionId = createSessionId("runtime-deferred-empty-input");
    const eventStore = createTestSessionEventStore();
    const runtime = createTestAgentRuntime(sessionId, {}, { eventStore });

    const result = await runtime.enqueueDeferredInput({ input: "   ", attachments: [] });

    expect(result).toMatchObject({ kind: "rejected", reason: "empty_input" });
    const events = await eventStore.getEvents(sessionId);
    expect(events.some((event) => event.type === SessionEventType.TurnSteerQueued)).toBe(false);
  });

  it("injects SessionStart once and UserPromptSubmit context before model requests", async () => {
    const sessionId = createSessionId("runtime-hooks-context");
    const eventStore = createTestSessionEventStore();
    const hookEvents: string[] = [];
    const sessionStartModels: string[] = [];
    const capturedRequests: string[] = [];
    const hookRunner = createInMemoryHookRunner({
      hooks: [
        {
          event: HookEventName.SessionStart,
          callback: async (input) => {
            hookEvents.push(`${input.hookEventName}:${input.source}`);
            sessionStartModels.push(input.model);
            return {
              hookSpecificOutput: {
                additionalContext: "session-start-context",
                hookEventName: HookEventName.SessionStart,
              },
            };
          },
        },
        {
          event: HookEventName.UserPromptSubmit,
          callback: async (input) => {
            hookEvents.push(`${input.hookEventName}:${input.prompt}`);
            return {
              hookSpecificOutput: {
                additionalContext: `prompt-context:${input.prompt}`,
                hookEventName: HookEventName.UserPromptSubmit,
              },
            };
          },
        },
      ],
    });
    const runtime = createTestAgentRuntime(
      sessionId,
      {},
      {
        eventStore,
        hookRunner,
        modelFactory: createTestModelFactory({
          async generateText(request: { messages: Array<{ content: ModelMessageContent }> }) {
            capturedRequests.push(
              request.messages
                .map((message) => modelMessageContentToText(message.content))
                .join("\n"),
            );
            return modelTextResult("ok");
          },
        } as never),
      },
    );

    await runtime.executeTurn("first", undefined, {
      intent: {
        kind: "sendText",
        modelSelection: {
          providerId: "provider-b",
          modelId: "model-b",
          options: { reasoningLevel: "high" },
        },
        requestedDelivery: "start-now",
        sourceCommandId: "hook-model-switch",
      },
    });
    await runtime.executeTurn("second");

    expect(hookEvents).toEqual([
      "SessionStart:startup",
      "UserPromptSubmit:first",
      "UserPromptSubmit:second",
    ]);
    expect(sessionStartModels).toEqual(["provider-b/model-b"]);
    expect(capturedRequests[0]).toContain("session-start-context");
    expect(capturedRequests[0]).toContain("prompt-context:first");
    expect(capturedRequests[1]).toContain("prompt-context:second");
  });

  // 会话工具设计 0.8：提醒指向 ReadSession，且只在注册了会话工具的根会话注入。
  it.each([true, false])(
    "injects a ReadSession reminder for a session id only with session tools (%s)",
    async (withSessionControl) => {
      const sessionId = createSessionId("runtime-session-reference");
      const referencedSessionId = createSessionId("referenced-context");
      const eventStore = createTestSessionEventStore();
      const capturedRequests: string[] = [];
      const runtime = createTestAgentRuntime(
        sessionId,
        {},
        {
          eventStore,
          ...(withSessionControl
            ? {
                sessionControl: {
                  kind: "cli" as const,
                  context: () => ({ rootSession: { kind: "cli", sessionId } }) as never,
                  control: {} as never,
                },
              }
            : {}),
          modelFactory: createTestModelFactory({
            async generateText(request: { messages: Array<{ content: ModelMessageContent }> }) {
              capturedRequests.push(
                request.messages
                  .map((message) => modelMessageContentToText(message.content))
                  .join("\n"),
              );
              return modelTextResult("ok");
            },
          } as never),
        },
      );

      await runtime.executeTurn(`continue from #${referencedSessionId}`);

      expect(capturedRequests[0]).not.toContain("ReadSessionContext");
      if (withSessionControl) {
        expect(capturedRequests[0]).toContain("ReadSession with sessionId");
        expect(capturedRequests[0]).toContain(`- ${referencedSessionId}`);
      } else {
        expect(capturedRequests[0]).not.toContain("ReadSession with sessionId");
      }
    },
  );

  it("blocks UserPromptSubmit before calling the model", async () => {
    const sessionId = createSessionId("runtime-hooks-block-prompt");
    const eventStore = createTestSessionEventStore();
    let modelCalled = false;
    const hookRunner = createInMemoryHookRunner({
      emitEvent: async (event) => {
        await eventStore.append(event);
      },
      hooks: [
        {
          event: HookEventName.UserPromptSubmit,
          callback: async () => ({
            continue: false,
            reason: "blocked by prompt hook",
            hookSpecificOutput: {
              hookEventName: HookEventName.UserPromptSubmit,
            },
          }),
        },
      ],
    });
    const runtime = createTestAgentRuntime(
      sessionId,
      {},
      {
        eventStore,
        hookRunner,
        modelFactory: createTestModelFactory({
          async generateText() {
            modelCalled = true;
            return modelTextResult("should not run");
          },
        } as never),
      },
    );

    const result = await runtime.executeTurn("blocked prompt");
    const events = await eventStore.getEvents(sessionId);

    expect(result.response).toBe("blocked by prompt hook");
    expect(modelCalled).toBe(false);
    expect(events.map((event) => event.type)).toContain(SessionEventType.HookRunBlocked);
    expect(events.map((event) => event.type)).not.toContain(SessionEventType.ModelRequest);
  });

  it("uses Stop hook feedback to continue the model loop", async () => {
    const sessionId = createSessionId("runtime-hooks-stop-continue");
    const eventStore = createTestSessionEventStore();
    let modelCallCount = 0;
    const capturedRequests: string[] = [];
    const hookRunner = createInMemoryHookRunner({
      hooks: [
        {
          event: HookEventName.Stop,
          callback: async () => {
            if (modelCallCount > 1) return undefined;
            return {
              decision: "block",
              reason: "revise with the stop hook feedback",
              systemMessage: "Ralph iteration 2",
            };
          },
        },
      ],
    });
    const runtime = createTestAgentRuntime(
      sessionId,
      { outputStyle: { name: "Learning", prompt: "Explain tradeoffs while solving the task." } },
      {
        eventStore,
        hookRunner,
        modelFactory: createTestModelFactory({
          async generateText(request: { messages: Array<{ content: ModelMessageContent }> }) {
            modelCallCount++;
            capturedRequests.push(
              request.messages
                .map((message) => modelMessageContentToText(message.content))
                .join("\n"),
            );
            return modelTextResult(modelCallCount === 1 ? "draft answer" : "final answer");
          },
        } as never),
      },
    );

    const result = await runtime.executeTurn("write an answer");

    expect(result.response).toBe("final answer");
    expect(modelCallCount).toBe(2);
    expect(capturedRequests[1]).toContain("draft answer");
    expect(capturedRequests[1]).toContain("revise with the stop hook feedback");
    // Stop hook 续跑不是新的输入：不再收集输入附件，output_style 仍只有轮首那一条。
    expect(capturedRequests[1]!.match(/Learning output style is active/g)).toHaveLength(1);
  });

  it("leaves a notification queued during a Stop hook continuation", async () => {
    const sessionId = createSessionId("runtime-hooks-stop-no-notification-drain");
    let modelCallCount = 0;
    const capturedRequests: string[] = [];
    let internal:
      | {
          branchGeneration: number;
          enqueueRuntimeCommand(command: unknown): void;
          rootTraceContext: unknown;
        }
      | undefined;
    const hookRunner = createInMemoryHookRunner({
      hooks: [
        {
          event: HookEventName.Stop,
          callback: async () => {
            if (modelCallCount > 1) return undefined;
            internal!.enqueueRuntimeCommand({
              branchGeneration: internal!.branchGeneration,
              createdAt: new Date(),
              id: createRuntimeCommandId(),
              mode: "task-notification",
              priority: "next",
              source: "background_task",
              taskId: "bg-task",
              text: "<task-notification>background task done</task-notification>",
              traceContext: internal!.rootTraceContext,
            });
            return { decision: "block", reason: "revise" };
          },
        },
      ],
    });
    const runtime = createTestAgentRuntime(
      sessionId,
      {},
      {
        eventStore: createTestSessionEventStore(),
        hookRunner,
        modelFactory: createTestModelFactory({
          async generateText(request: { messages: Array<{ content: ModelMessageContent }> }) {
            modelCallCount++;
            capturedRequests.push(
              request.messages
                .map((message) => modelMessageContentToText(message.content))
                .join("\n"),
            );
            return modelTextResult(`answer ${modelCallCount}`);
          },
        } as never),
      },
    );
    internal = runtime as unknown as NonNullable<typeof internal>;

    await runtime.executeTurn("write an answer");
    await vi.waitFor(() => expect(modelCallCount).toBe(3));

    // 通知只在完整工具批次之后取出；Stop hook 续跑重发同一份输入，不插入通知。
    expect(capturedRequests[1]).not.toContain("background task done");
    // 通知留在队列里，本轮结束后开新一轮。
    expect(capturedRequests[2]).toContain("background task done");
  });

  it("caps consecutive Stop hook continuations at three", async () => {
    const sessionId = createSessionId("runtime-hooks-stop-cap");
    const eventStore = createTestSessionEventStore();
    let hookCallCount = 0;
    let modelCallCount = 0;
    const hookRunner = createInMemoryHookRunner({
      hooks: [
        {
          event: HookEventName.Stop,
          callback: async () => {
            hookCallCount++;
            return {
              decision: "block",
              reason: `stop feedback ${hookCallCount}`,
            };
          },
        },
      ],
    });
    const runtime = createTestAgentRuntime(
      sessionId,
      {},
      {
        eventStore,
        hookRunner,
        modelFactory: createTestModelFactory({
          async generateText() {
            modelCallCount++;
            return modelTextResult(`answer ${modelCallCount}`);
          },
        } as never),
      },
    );

    const result = await runtime.executeTurn("write an answer");

    expect(result.response).toBe("answer 4");
    expect(modelCallCount).toBe(4);
    expect(hookCallCount).toBe(4);
  });

  it("injects built-in session mailbox context when messaging is enabled", async () => {
    const sessionId = createSessionId("runtime-mailbox-hooks");
    const eventStore = createTestSessionEventStore();
    const capturedRequests: string[] = [];
    let drained = false;
    const runtime = createTestAgentRuntime(
      sessionId,
      {},
      {
        eventStore,
        sessionMailboxPort: {
          async drainUnread() {
            if (drained) return [];
            drained = true;
            return [
              {
                version: 1,
                messageId: "mail-1",
                fromSessionId: "source-session",
                toSessionId: sessionId,
                content: "please check the failing test",
                createdAt: new Date().toISOString(),
              },
            ];
          },
        },
        modelFactory: createTestModelFactory({
          async generateText(request: { messages: Array<{ content: ModelMessageContent }> }) {
            capturedRequests.push(
              request.messages
                .map((message) => modelMessageContentToText(message.content))
                .join("\n"),
            );
            return modelTextResult("ok");
          },
        } as never),
      },
    );

    await runtime.executeTurn("work");

    expect(capturedRequests[0]).toContain("<session-message");
    expect(capturedRequests[0]).toContain("mail-1");
    expect(capturedRequests[0]).toContain("please check the failing test");
    expect(runtime.getToolRegistry().has("send_message")).toBe(false);
    const sendMessageTool = runtime.getToolRegistry().get(SEND_MESSAGE_TOOL_NAME);
    if (!sendMessageTool) throw new Error("Expected send_message tool to be registered");
    const sendMessageInputProperties = (sendMessageTool.inputSchema as any).properties;
    expect(sendMessageInputProperties).toHaveProperty("to");
    expect(sendMessageInputProperties).toHaveProperty("summary");
    expect(sendMessageInputProperties).toHaveProperty("message");
    expect(sendMessageInputProperties).not.toHaveProperty("sessionId");
    expect(sendMessageInputProperties).not.toHaveProperty("content");
  });

  it("executes SendMessage to a local_agent through the subagent port", async () => {
    const sessionId = createSessionId("runtime-send-message-local-agent");
    const eventStore = createTestSessionEventStore();
    const sentMessages: SubagentSendMessageRequest[] = [];
    const capturedRequests: string[] = [];
    let modelCallCount = 0;
    const subagentPort: SubagentPort = {
      async launch() {
        throw new Error("Agent tool should not launch in this test");
      },
      async run() {
        throw new Error("Agent tool should not run in this test");
      },
      async sendMessage(input) {
        sentMessages.push(input);
        return {
          status: "success",
          messageId: "msg-local-agent-1",
          delivery: "steered",
          agentId: input.to,
          taskId: input.to,
          message: `Message msg-local-agent-1 (${input.summary}) sent to ${input.to}.`,
        };
      },
    };
    const runtime = createTestAgentRuntime(
      sessionId,
      {},
      {
        eventStore,
        subagentPort,
        modelFactory: createTestModelFactory({
          async generateText(request: { messages: Array<{ content: ModelMessageContent }> }) {
            modelCallCount++;
            capturedRequests.push(
              request.messages
                .map((message) => modelMessageContentToText(message.content))
                .join("\n"),
            );
            if (modelCallCount === 1) {
              return {
                finishReason: "tool-calls",
                model: "test",
                providerMetadata: undefined,
                text: "",
                toolCalls: [
                  {
                    id: "send-local-agent-call-1",
                    input: {
                      to: "agent_local_1",
                      summary: "继续检查权限",
                      message: "请继续检查权限链路，并只报告结论。",
                    },
                    name: SEND_MESSAGE_TOOL_NAME,
                  },
                ],
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }
            return modelTextResult("sent to local agent");
          },
        } as never),
      },
    );

    const result = await runtime.executeTurn("send the local agent follow-up");

    expect(result.response).toBe("sent to local agent");
    expect(modelCallCount).toBe(2);
    expect(sentMessages).toEqual([
      expect.objectContaining({
        message: "请继续检查权限链路，并只报告结论。",
        summary: "继续检查权限",
        to: "agent_local_1",
      }),
    ]);
    expect(capturedRequests[1]).toContain(
      "Message msg-local-agent-1 (继续检查权限) sent to agent_local_1.",
    );
  });

  it("executes RespondToCoordinator from a plan-mode child runtime", async () => {
    const sessionId = createSessionId("runtime-respond-to-coordinator-plan");
    const requests: Parameters<CoordinatorResponsePort["respond"]>[0][] = [];
    let modelCallCount = 0;
    const runtime = createTestAgentRuntime(
      sessionId,
      { mode: "plan", taskType: "subagent_child" },
      {
        coordinatorResponsePort: {
          respond(request) {
            requests.push(request);
            return {
              status: "success",
              responseId: "response_plan_1",
              message: "Response response_plan_1 was queued for the coordinator.",
            };
          },
        },
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          async generateText() {
            modelCallCount++;
            if (modelCallCount === 1) {
              return {
                finishReason: "tool-calls",
                model: "test",
                providerMetadata: undefined,
                text: "",
                toolCalls: [
                  {
                    id: "respond-plan-call-1",
                    input: {
                      summary: "权限链路进度",
                      message: "已完成入口检查，继续验证异常路径。",
                    },
                    name: RESPOND_TO_COORDINATOR_TOOL_NAME,
                  },
                ],
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }
            return modelTextResult("continued child work");
          },
        } as never),
      },
    );

    const result = await runtime.executeTurn("respond and continue");

    expect(result.response).toBe("continued child work");
    expect(requests).toEqual([
      expect.objectContaining({
        childToolCallId: "respond-plan-call-1",
        message: "已完成入口检查，继续验证异常路径。",
        summary: "权限链路进度",
      }),
    ]);
    expect(requests[0]).not.toHaveProperty("childSessionId");
    expect(requests[0]?.trace).toMatchObject({ sessionId });
  });

  it("keeps RespondToCoordinator behind the enabled child runtime boundary", () => {
    const coordinatorResponsePort: CoordinatorResponsePort = {
      respond() {
        return {
          status: "success",
          responseId: "response_boundary",
          message: "queued",
        };
      },
    };
    const mainRuntime = createTestAgentRuntime(
      createSessionId("runtime-respond-main-boundary"),
      {},
      {
        coordinatorResponsePort,
        eventStore: createTestSessionEventStore(),
      },
    );
    const disallowedChildRuntime = createTestAgentRuntime(
      createSessionId("runtime-respond-disallowed-child"),
      {
        taskType: "subagent_child",
        toolDisallowlist: [RESPOND_TO_COORDINATOR_TOOL_NAME],
      },
      {
        coordinatorResponsePort,
        eventStore: createTestSessionEventStore(),
      },
    );
    const childWithoutPort = createTestAgentRuntime(
      createSessionId("runtime-respond-child-without-port"),
      { taskType: "subagent_child" },
      { eventStore: createTestSessionEventStore() },
    );

    expect(mainRuntime.getToolRegistry().has(RESPOND_TO_COORDINATOR_TOOL_NAME)).toBe(false);
    expect(disallowedChildRuntime.getToolRegistry().has(RESPOND_TO_COORDINATOR_TOOL_NAME)).toBe(
      false,
    );
    expect(childWithoutPort.getToolRegistry().has(RESPOND_TO_COORDINATOR_TOOL_NAME)).toBe(false);
  });

  it("keeps child work actionable after RespondToCoordinator enqueue failure", async () => {
    const capturedRequests: string[] = [];
    const enqueueError = "injected enqueue failure ".repeat(300);
    let modelCallCount = 0;
    const runtime = createTestAgentRuntime(
      createSessionId("runtime-respond-to-coordinator-failed"),
      { taskType: "subagent_child" },
      {
        coordinatorResponsePort: {
          respond() {
            return {
              status: "failed",
              responseId: "response_failed",
              message: "Response failed to queue.",
              error: enqueueError,
            };
          },
        },
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          async generateText(request: { messages: Array<{ content: ModelMessageContent }> }) {
            modelCallCount++;
            capturedRequests.push(
              request.messages
                .map((message) => modelMessageContentToText(message.content))
                .join("\n"),
            );
            if (modelCallCount === 1) {
              return {
                finishReason: "tool-calls",
                model: "test",
                providerMetadata: undefined,
                text: "",
                toolCalls: [
                  {
                    id: "respond-failed-call-1",
                    input: { summary: "progress", message: "still working" },
                    name: RESPOND_TO_COORDINATOR_TOOL_NAME,
                  },
                ],
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }
            return modelTextResult("continued after failed response");
          },
        } as never),
      },
    );

    const result = await runtime.executeTurn("report progress");

    expect(result.response).toBe("continued after failed response");
    expect(capturedRequests[1]).toContain("injected enqueue failure");
    expect(capturedRequests[1]).toContain("Continue the current task");
    expect(capturedRequests[1]).toContain("Tool output truncated by resultBudget");
  });

  it("returns a configuration error when RespondToCoordinator is forced without a port", async () => {
    let modelCallCount = 0;
    const capturedRequests: string[] = [];
    const runtime = createTestAgentRuntime(
      createSessionId("runtime-respond-to-coordinator-missing-port"),
      { taskType: "subagent_child" },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          async generateText(request: { messages: Array<{ content: ModelMessageContent }> }) {
            modelCallCount++;
            capturedRequests.push(
              request.messages
                .map((message) => modelMessageContentToText(message.content))
                .join("\n"),
            );
            if (modelCallCount === 1) {
              return {
                finishReason: "tool-calls",
                model: "test",
                providerMetadata: undefined,
                text: "",
                toolCalls: [
                  {
                    id: "respond-missing-port-call-1",
                    input: { summary: "progress", message: "still working" },
                    name: RESPOND_TO_COORDINATOR_TOOL_NAME,
                  },
                ],
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }
            return modelTextResult("handled configuration error");
          },
        } as never),
      },
    );
    runtime.getToolRegistry().register(respondToCoordinatorToolEntry);

    await runtime.executeTurn("force response tool");

    expect(capturedRequests[1]).toContain(
      "Coordinator response port is not configured for RespondToCoordinator",
    );
  });

  it("queues post-tool session mailbox context as active-turn user input", async () => {
    const sessionId = createSessionId("runtime-mailbox-post-tool");
    const targetSessionId = createSessionId("runtime-mailbox-post-tool-target");
    const eventStore = createTestSessionEventStore();
    const capturedRequests: Array<Array<{ content: ModelMessageContent; role: string }>> = [];
    let drainCount = 0;
    let modelCallCount = 0;
    const runtime = createTestAgentRuntime(
      sessionId,
      {},
      {
        eventStore,
        sessionMailboxPort: {
          async drainUnread() {
            drainCount++;
            if (drainCount !== 2) return [];
            return [
              {
                version: 1,
                messageId: "mail-post-tool-1",
                fromSessionId: targetSessionId,
                toSessionId: sessionId,
                content: "成竹在胸，请你接 胸 字开头的成语。",
                createdAt: new Date().toISOString(),
              },
              {
                version: 1,
                messageId: "mail-post-tool-2",
                fromSessionId: targetSessionId,
                toSessionId: sessionId,
                content: "胸有成竹，请你接 竹 字开头的成语。",
                createdAt: new Date().toISOString(),
              },
            ];
          },
        },
        modelFactory: createTestModelFactory({
          async generateText(request: {
            messages: Array<{ content: ModelMessageContent; role: string }>;
          }) {
            modelCallCount++;
            capturedRequests.push(request.messages);
            if (modelCallCount === 1) {
              return {
                finishReason: "tool-calls",
                model: "test",
                providerMetadata: undefined,
                text: "",
                toolCalls: [
                  {
                    id: "send-message-call-1",
                    input: {
                      to: "agent_missing_for_mailbox_test",
                      summary: "触发 post tool mailbox drain",
                      message: "水到渠成，请你接 成 字开头的成语。",
                    },
                    name: SEND_MESSAGE_TOOL_NAME,
                  },
                ],
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }
            return modelTextResult("received mailbox boundary");
          },
        } as never),
      },
    );

    const result = await runtime.executeTurn("start idiom chain");
    const toolMessage = capturedRequests.flat().find((message) => message.role === "tool");
    const mailboxRequestText = capturedRequests
      .flat()
      .map((message) => modelMessageContentToText(message.content))
      .join("\n");
    const events = await eventStore.getEvents(sessionId);
    const eventTypes = events.map((event) => event.type);

    expect(result.response).toBe("received mailbox boundary");
    expect(modelCallCount).toBeGreaterThanOrEqual(2);
    expect(modelMessageContentToText(toolMessage?.content ?? "")).not.toContain("<session-message");
    expect(mailboxRequestText).toContain("mail-post-tool-1");
    expect(mailboxRequestText).toContain("成竹在胸，请你接 胸 字开头的成语。");
    expect(mailboxRequestText).toContain("mail-post-tool-2");
    expect(mailboxRequestText).toContain("胸有成竹，请你接 竹 字开头的成语。");
    expect(eventTypes).toContain(SessionEventType.TurnSteerQueued);
    expect(eventTypes).toContain(SessionEventType.TurnSteerDrained);
  });
});

function modelTextResult(text: string) {
  return {
    finishReason: "stop",
    model: "test",
    providerMetadata: undefined,
    text,
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
    },
  };
}
