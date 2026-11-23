import { describe, expect, it } from "vitest";
import {
  SessionEventType,
  createSessionEvent,
  createModelId,
  createModelProviderId,
  createSessionId,
  createTurnId,
  type SessionEvent,
  type SessionId,
} from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { mirrorSubagentToolEvent } from "../src/subagent/tool-event-mirror.js";
import { MemoryFileSystem } from "./memory-test-utils.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

describe("subagent tool event projection", () => {
  it("mirrors child blocking interactions into the parent live projection", async () => {
    const sessionId = createSessionId("runtime-subagent-interaction-events");
    const eventStore = createTestSessionEventStore();
    const liveEvents: SessionEvent[] = [];
    const delegatedRequests: Array<Record<string, unknown>> = [];
    let parentCallCount = 0;
    let childCallCount = 0;

    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "yolo",
        modelSelection: {
          providerId: createModelProviderId("provider-test"),
          modelId: createModelId("parent-model"),
        },
        workingDirectory: "/workspace/project",
      },
      {
        eventStore,
        permissionBroker: {
          async requestPermission(request) {
            delegatedRequests.push(request as unknown as Record<string, unknown>);
            return {
              decision: "modify",
              modifiedInput: {
                ...(request.input as Record<string, unknown>),
                answers: { "Which path?": "Parent answered" },
              },
              reason: "answered in parent task",
            };
          },
        },
        modelFactory: createTestModelFactory({
          async generateText(request: any) {
            const toolNames = (request.tools ?? []).map((tool: any) => tool.name);
            if (toolNames.includes("Agent")) {
              parentCallCount++;
              if (parentCallCount === 1) {
                return {
                  finishReason: "tool-calls",
                  providerMetadata: undefined,
                  text: "",
                  toolCalls: [
                    {
                      id: "call_parent_agent",
                      name: "Agent",
                      input: {
                        description: "Ask from child",
                        prompt: "Ask the user which path to take.",
                        subagent_type: "general-purpose",
                      },
                    },
                  ],
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                };
              }
              return {
                finishReason: "stop",
                providerMetadata: undefined,
                text: "parent received child result",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }

            childCallCount++;
            if (childCallCount === 1) {
              return {
                finishReason: "tool-calls",
                providerMetadata: undefined,
                text: "",
                toolCalls: [
                  {
                    id: "call_child_ask",
                    name: "AskUserQuestion",
                    input: {
                      questions: [
                        {
                          header: "Path",
                          multiSelect: false,
                          options: [
                            { description: "Use path A", label: "A" },
                            { description: "Use path B", label: "B" },
                          ],
                          question: "Which path?",
                        },
                      ],
                    },
                  },
                ],
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "child received the answer",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        } as never),
      },
    );

    const unsubscribe = runtime.subscribeEvents({
      onSessionEvent: (event) => {
        liveEvents.push(event);
      },
    });
    try {
      await runtime.executeTurn("Delegate a question to a child.");
    } finally {
      unsubscribe();
    }

    expect(delegatedRequests).toHaveLength(1);
    expect(delegatedRequests[0]).toMatchObject({
      sessionId,
      toolCallId: "call_child_ask",
      toolName: "AskUserQuestion",
      origin: {
        kind: "subagent",
        childSessionId: expect.stringContaining("sess_subagent_agent_"),
        parentSessionId: sessionId,
        parentToolCallId: "call_parent_agent",
      },
    });

    const parentPermissionRequested = liveEvents.find(
      (event) =>
        event.sessionId === sessionId && event.type === SessionEventType.PermissionRequested,
    );
    const parentPermissionResolved = liveEvents.find(
      (event) =>
        event.sessionId === sessionId && event.type === SessionEventType.PermissionResolved,
    );
    expect(parentPermissionRequested?.payload).toMatchObject({
      requestId: expect.stringMatching(/^perm_/),
      toolCallId: expect.not.stringMatching(/^call_child_ask$/),
      toolName: "AskUserQuestion",
      origin: {
        kind: "subagent",
        childSessionId: expect.stringContaining("sess_subagent_agent_"),
        parentSessionId: sessionId,
        parentToolCallId: "call_parent_agent",
      },
    });
    expect(parentPermissionResolved?.payload).toMatchObject({
      requestId: (parentPermissionRequested?.payload as Record<string, unknown>)?.requestId,
      toolCallId: (parentPermissionRequested?.payload as Record<string, unknown>)?.toolCallId,
      decision: "modify",
    });

    const persistedParentEvents = await eventStore.getEvents(sessionId);
    expect(
      persistedParentEvents.some(
        (event) =>
          event.type === SessionEventType.PermissionRequested &&
          (event.payload as Record<string, unknown>).origin !== undefined,
      ),
    ).toBe(false);
  });

  it("mirrors child tool calls to the parent live event sink without persisting them as parent events", async () => {
    const sessionId = createSessionId("runtime-subagent-tool-events");
    const eventStore = createTestSessionEventStore();
    const liveEvents: SessionEvent[] = [];
    let parentCallCount = 0;
    let childCallCount = 0;

    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "build",
        modelSelection: {
          providerId: createModelProviderId("provider-test"),
          modelId: createModelId("parent-model"),
        },
        workingDirectory: "/workspace/project",
        // 这些用例按前台 Agent 写成，关闭「Agent 总在后台」开关（07-subagent.md「ZCode 当前实现」）。
        subagents: { alwaysBackground: false },
      },
      {
        eventStore,
        fileSystemPort: new MemoryFileSystem({
          "/workspace/project/README.md": "ZCode Explore reads this file.\n",
        }),
        modelFactory: createTestModelFactory({
          async generateText(request: any) {
            const toolNames = (request.tools ?? []).map((tool: any) => tool.name);
            if (toolNames.includes("Agent")) {
              parentCallCount++;
              if (parentCallCount === 1) {
                return {
                  finishReason: "tool-calls",
                  providerMetadata: undefined,
                  text: "",
                  toolCalls: [
                    {
                      id: "call_explore",
                      name: "Agent",
                      input: {
                        description: "Read project readme",
                        prompt: "Read README.md and summarize it.",
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
                text: "parent saw child result",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }

            childCallCount++;
            if (childCallCount === 1) {
              return {
                finishReason: "tool-calls",
                providerMetadata: undefined,
                text: "",
                toolCalls: [
                  {
                    id: "call_child_read",
                    name: "Read",
                    input: { file_path: "README.md" },
                  },
                ],
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }

            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "README says Explore can read files.",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        } as never),
      },
    );

    const unsubscribe = runtime.subscribeEvents({
      onSessionEvent: (event) => {
        liveEvents.push(event);
      },
    });
    try {
      await runtime.executeTurn("Use Explore to inspect README.md");
    } finally {
      unsubscribe();
    }

    const parentEvents = await eventStore.getEvents(sessionId);
    const spawnedAgentId = (
      parentEvents.find((event) => event.type === SessionEventType.SubagentSpawned)?.payload as
        | { agentId?: string }
        | undefined
    )?.agentId;
    expect(spawnedAgentId).toMatch(/^agent_/u);
    const childSessionId = parentEvents
      .map((event) => event.payload as Record<string, unknown>)
      .find((payload) => typeof payload.childSessionId === "string")?.childSessionId as
      | string
      | undefined;
    expect(childSessionId).toBeTruthy();

    const childEvents = await eventStore.getEvents(childSessionId as SessionId);
    expect(childEvents.some((event) => event.type === SessionEventType.ToolCallScheduled)).toBe(
      true,
    );

    const mirroredReadEvents = liveEvents.filter((event) => {
      const payload = event.payload as Record<string, unknown>;
      return payload.source === "subagent" && payload.childToolCallId === "call_child_read";
    });
    const mirroredScheduled = mirroredReadEvents.find(
      (event) => event.type === SessionEventType.ToolCallScheduled,
    );
    const mirroredResult = mirroredReadEvents.find(
      (event) => event.type === SessionEventType.ToolCallResult,
    );

    expect(mirroredScheduled?.sessionId).toBe(sessionId);
    expect(mirroredScheduled?.turnId).toBe(parentEvents[0]?.turnId);
    expect(mirroredScheduled?.payload).toMatchObject({
      agentId: spawnedAgentId,
      childSessionId,
      childToolCallId: "call_child_read",
      description: "Read project readme",
      parentToolCallId: "call_explore",
      source: "subagent",
      toolName: "Read",
    });
    expect(mirroredScheduled?.payload).not.toHaveProperty("background");
    expect((mirroredScheduled?.payload as any).toolCallId).not.toBe("call_child_read");
    expect((mirroredResult?.payload as any).toolCallId).toBe(
      (mirroredScheduled?.payload as any).toolCallId,
    );
    expect(mirroredResult?.payload).toMatchObject({
      toolName: "Read",
    });

    const persistedParentReadEvents = parentEvents.filter((event) => {
      const payload = event.payload as Record<string, unknown>;
      return payload.source === "subagent" && payload.toolName === "Read";
    });
    expect(persistedParentReadEvents).toEqual([]);
  });

  it("marks child tool events emitted after foreground auto-background with current provenance", async () => {
    const sessionId = createSessionId("runtime-auto-background-subagent-tool-events");
    const eventStore = createTestSessionEventStore();
    const liveEvents: SessionEvent[] = [];
    const childMayEmitTool = createDeferred<void>();
    const backgroundCompletion = createDeferred<void>();
    let parentCallCount = 0;
    let childCallCount = 0;

    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "build",
        modelSelection: {
          providerId: createModelProviderId("provider-test"),
          modelId: createModelId("parent-model"),
        },
        subagents: { autoBackgroundMs: 1 },
        workingDirectory: "/workspace/project",
      },
      {
        eventStore,
        fileSystemPort: new MemoryFileSystem({
          "/workspace/project/README.md": "ZCode background child reads this file.\n",
        }),
        modelFactory: createTestModelFactory({
          async generateText(request: any) {
            const toolNames = (request.tools ?? []).map((tool: any) => tool.name);
            if (toolNames.includes("Agent")) {
              parentCallCount++;
              if (parentCallCount === 1) {
                return {
                  finishReason: "tool-calls",
                  providerMetadata: undefined,
                  text: "",
                  toolCalls: [
                    {
                      id: "call_auto_background_agent",
                      name: "Agent",
                      input: {
                        description: "Read after moving to background",
                        prompt: "Wait, then read README.md.",
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
                text: "parent continued after background launch",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }

            childCallCount++;
            if (childCallCount === 1) {
              await childMayEmitTool.promise;
              return {
                finishReason: "tool-calls",
                providerMetadata: undefined,
                text: "",
                toolCalls: [
                  {
                    id: "call_background_child_read",
                    name: "Read",
                    input: { file_path: "README.md" },
                  },
                ],
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }

            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "README was read after auto-background.",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        } as never),
      },
    );

    const unsubscribe = runtime.subscribeEvents({
      onSessionEvent: (event) => {
        liveEvents.push(event);
        if (event.type === SessionEventType.BackgroundTaskCompleted) {
          backgroundCompletion.resolve();
        }
      },
    });
    try {
      await runtime.executeTurn("Launch a foreground child that will move to background.");
      childMayEmitTool.resolve();
      await Promise.race([
        backgroundCompletion.promise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Timed out waiting for background child")), 1_000),
        ),
      ]);
    } finally {
      childMayEmitTool.resolve();
      unsubscribe();
    }

    const mirroredReadEvents = liveEvents.filter((event) => {
      const payload = event.payload as Record<string, unknown>;
      return (
        payload.source === "subagent" && payload.childToolCallId === "call_background_child_read"
      );
    });
    expect(mirroredReadEvents.length).toBeGreaterThan(0);
    expect(
      mirroredReadEvents.every(
        (event) => (event.payload as Record<string, unknown>).background === true,
      ),
    ).toBe(true);
  });

  it("mirrors a child permission lifecycle with the same parent tool identity", () => {
    const childSessionId = createSessionId("runtime-denied-child-interaction");
    const parentSessionId = createSessionId("runtime-denied-parent-interaction");
    const parentTurnId = createTurnId("runtime-denied-parent-turn");
    const context = {
      agentId: "agent_denied",
      agentType: "general-purpose",
      background: false,
      childSessionId,
      description: "Run a protected command",
      parentSessionId,
      parentToolCallId: "call_parent_agent",
      parentTurnId,
      toolNameByChildToolCallId: new Map<string, string>(),
    };
    const requestId = "perm_child_bash";
    const requested = mirrorSubagentToolEvent(
      createSessionEvent(SessionEventType.PermissionRequested, childSessionId, {
        requestId,
        toolCallId: "call_child_bash",
        toolName: "Bash",
        riskLevel: "high",
        reason: "Run a protected command",
        input: { command: "echo protected" },
      }),
      context,
    );
    const resolved = mirrorSubagentToolEvent(
      createSessionEvent(SessionEventType.PermissionResolved, childSessionId, {
        requestId,
        toolCallId: "call_child_bash",
        decision: "deny",
      }),
      context,
    );
    const denied = mirrorSubagentToolEvent(
      createSessionEvent(SessionEventType.PermissionDenied, childSessionId, {
        toolCallId: "call_child_bash",
        toolName: "Bash",
        reason: "Denied by the user",
      }),
      context,
    );

    expect(requested).toMatchObject({
      sessionId: parentSessionId,
      turnId: parentTurnId,
      type: SessionEventType.PermissionRequested,
      payload: {
        requestId,
        toolCallId: "tool_subagent_agent_denied_call_child_bash",
        toolName: "Bash",
        origin: {
          kind: "subagent",
          childSessionId,
          parentSessionId,
          parentToolCallId: "call_parent_agent",
        },
      },
    });
    expect(resolved).toMatchObject({
      sessionId: parentSessionId,
      type: SessionEventType.PermissionResolved,
      payload: {
        requestId,
        toolCallId: "tool_subagent_agent_denied_call_child_bash",
        toolName: "Bash",
        decision: "deny",
      },
    });
    expect(denied).toMatchObject({
      sessionId: parentSessionId,
      type: SessionEventType.PermissionDenied,
      payload: {
        toolCallId: "tool_subagent_agent_denied_call_child_bash",
        toolName: "Bash",
        reason: "Denied by the user",
      },
    });
    expect(requested?.payload).not.toHaveProperty("source");
    expect(resolved?.payload).not.toHaveProperty("source");
    expect(denied?.payload).not.toHaveProperty("source");
  });

  it("preserves background provenance on mirrored child permission events", () => {
    const childSessionId = createSessionId("runtime-background-child-permission");
    const parentSessionId = createSessionId("runtime-background-parent-permission");
    const mirrored = mirrorSubagentToolEvent(
      createSessionEvent(SessionEventType.PermissionRequested, childSessionId, {
        requestId: "permission-child",
        toolCallId: "call_child_bash",
        toolName: "Bash",
      }),
      {
        agentId: "agent_background",
        agentType: "general-purpose",
        background: true,
        childSessionId,
        description: "Run a protected command",
        parentSessionId,
        parentToolCallId: "call_parent_agent",
      },
    );

    expect(mirrored?.payload).toMatchObject({
      background: true,
      childSessionId,
      toolCallId: "tool_subagent_agent_background_call_child_bash",
    });
  });
});

function createDeferred<T>(): { promise: Promise<T>; resolve(value?: T): void } {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => resolvePromise(value as T),
  };
}
