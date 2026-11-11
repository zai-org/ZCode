import { describe, expect, it, vi } from "vitest";
import {
  CREATE_WORKFLOW_TOOL_NAME,
  GET_WORKFLOW_RUN_TOOL_NAME,
  SESSION_ENTRY_DYNAMIC_WORKFLOW_ACTIVATION,
  createMessageId,
  createPartId,
  createProjectId,
  createSessionId,
  type MessageWithParts,
  type ModelRequest,
  type SessionEntryInfo,
  type SessionStorePort,
} from "@zcode/contracts";
import { AgentRuntime } from "../src/runtime.js";
import { persistedMessagesShowDynamicWorkflow } from "../src/runtime/methods/dynamic-workflow-activation.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

// docs/dynamic-workflow/launch.md「On demand: activation」（DWG-09 / DWG-10 / DWG-13 的 core 一半）：
// onDemand 会话出生时没有十个工作流工具，激活一次即全部到位且不再回收；冷恢复按 entry 或历史判定。

const CMD_SHELL_SELECTION = {
  dialect: "cmd",
  display: { name: "CMD" },
  id: "cmd",
  label: "CMD",
  path: "cmd.exe",
  source: "user-config",
} as const;

const ON_DEMAND_CONFIG = { dynamicWorkflowEnabled: true, dynamicWorkflowToolsOnDemand: true };

function agentDescription(runtime: AgentRuntime): string {
  return runtime.getToolRegistry().get("Agent")?.metadata.description ?? "";
}

function toolNames(runtime: AgentRuntime): string[] {
  return runtime.getTools().map((tool) => tool.name);
}

describe("onDemand：出生不注册，激活后到位（DWG-09）", () => {
  it("激活前后的注册表、模型可见工具面与 Agent 描述", async () => {
    const runtime = new AgentRuntime(createSessionId("dwf-on-demand-activate"), ON_DEMAND_CONFIG, {
      eventStore: createTestSessionEventStore(),
      toolRegistry: createToolRegistry(),
    });
    expect(runtime.getToolRegistry().has(CREATE_WORKFLOW_TOOL_NAME)).toBe(false);
    expect(toolNames(runtime)).not.toContain(GET_WORKFLOW_RUN_TOOL_NAME);
    expect(agentDescription(runtime)).not.toContain("CreateWorkflow");
    // 反向断言：只差工作流那十个，普通工具面完整。
    expect(runtime.getToolRegistry().has("Read")).toBe(true);

    await expect(runtime.activateDynamicWorkflowTools({ source: "command" })).resolves.toBe(true);
    expect(runtime.getToolRegistry().has(CREATE_WORKFLOW_TOOL_NAME)).toBe(true);
    // getTools 走 cachedTools：激活必须让下一次读取看到新注册表，而不是沿用激活前的缓存。
    expect(toolNames(runtime)).toContain(GET_WORKFLOW_RUN_TOOL_NAME);
    expect(agentDescription(runtime)).toContain("CreateWorkflow");

    // 第二次是 no-op。
    await expect(runtime.activateDynamicWorkflowTools({ source: "command" })).resolves.toBe(false);
  });

  it("激活后分支刷新（shell 初始化）不再把工具剃掉，也不会把未激活会话的工具加回来", async () => {
    const activated = new AgentRuntime(
      createSessionId("dwf-on-demand-refresh-a"),
      ON_DEMAND_CONFIG,
      {
        eventStore: createTestSessionEventStore(),
        toolRegistry: createToolRegistry(),
      },
    );
    await activated.activateDynamicWorkflowTools({ source: "command" });
    expect(activated.initializeSessionShellEnvironmentIfNeeded(CMD_SHELL_SELECTION)).toBe(true);
    expect(activated.getToolRegistry().has(CREATE_WORKFLOW_TOOL_NAME)).toBe(true);

    const dormant = new AgentRuntime(createSessionId("dwf-on-demand-refresh-b"), ON_DEMAND_CONFIG, {
      eventStore: createTestSessionEventStore(),
      toolRegistry: createToolRegistry(),
    });
    expect(dormant.initializeSessionShellEnvironmentIfNeeded(CMD_SHELL_SELECTION)).toBe(true);
    expect(dormant.getToolRegistry().has(CREATE_WORKFLOW_TOOL_NAME)).toBe(false);
  });

  it.each([
    { name: "alwaysOn（布尔 true，无按需标志）", config: { dynamicWorkflowEnabled: true } },
    { name: "不参与灰度（TUI / headless，两个字段都缺席）", config: {} },
    {
      name: "按需标志显式 false",
      config: { dynamicWorkflowEnabled: true, dynamicWorkflowToolsOnDemand: false },
    },
  ])("$name：出生即激活，activate 是 no-op（DWG-13）", async ({ config }) => {
    const runtime = new AgentRuntime(createSessionId("dwf-eager"), config, {
      eventStore: createTestSessionEventStore(),
      toolRegistry: createToolRegistry(),
    });
    expect(runtime.getToolRegistry().has(CREATE_WORKFLOW_TOOL_NAME)).toBe(true);
    await expect(runtime.activateDynamicWorkflowTools({ source: "command" })).resolves.toBe(false);
  });

  it("灰度关闭的会话不因激活调用而拿到工具（enabled 仍是第一道门）", async () => {
    const runtime = new AgentRuntime(
      createSessionId("dwf-disabled-activate"),
      { dynamicWorkflowEnabled: false, dynamicWorkflowToolsOnDemand: true },
      { eventStore: createTestSessionEventStore(), toolRegistry: createToolRegistry() },
    );
    await runtime.activateDynamicWorkflowTools({ source: "command" });
    expect(runtime.getToolRegistry().has(CREATE_WORKFLOW_TOOL_NAME)).toBe(false);
  });

  it("激活后的首个模型请求带着工作流工具（激活先于 executeTurn 的调用方契约）", async () => {
    const requests: ModelRequest[] = [];
    const runtime = createTestAgentRuntime(
      createSessionId("dwf-on-demand-request"),
      { ...ON_DEMAND_CONFIG, workingDirectory: "/workspace/project" },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          async generateText(request) {
            requests.push(request);
            return {
              finishReason: "stop",
              text: "ok",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            } as never;
          },
        }),
      },
    );
    await runtime.executeTurn("hello");
    await runtime.activateDynamicWorkflowTools({ source: "command" });
    await runtime.executeTurn("/workflow ship it");
    const names = requests.map((request) => (request.tools ?? []).map((tool) => tool.name));
    expect(names[0]).not.toContain(CREATE_WORKFLOW_TOOL_NAME);
    expect(names[1]).toContain(CREATE_WORKFLOW_TOOL_NAME);
  });
});

// ---------------------------------------------------------------------------
// 冷恢复（DWG-10）
// ---------------------------------------------------------------------------

function persistedSession(sessionId: ReturnType<typeof createSessionId>) {
  return {
    id: sessionId,
    projectID: createProjectId("dwf-on-demand"),
    directory: "/workspace/project",
    slug: "dwf-on-demand",
    title: "on demand",
    version: "test",
    taskType: "interactive",
    time: { created: 1, updated: 1 },
  };
}

function userMessage(
  sessionId: ReturnType<typeof createSessionId>,
  text: string,
): MessageWithParts {
  const messageId = createMessageId();
  return {
    info: {
      id: messageId,
      sessionID: sessionId,
      role: "user",
      agent: "zcode-agent",
      time: { created: 1 },
    },
    parts: [
      { id: createPartId("u"), messageID: messageId, sessionID: sessionId, type: "text", text },
    ],
  } as unknown as MessageWithParts;
}

function assistantToolMessage(
  sessionId: ReturnType<typeof createSessionId>,
  tool: string,
): MessageWithParts {
  const messageId = createMessageId();
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
        tool,
        state: {
          status: "completed",
          input: {},
          output: "ok",
          title: tool,
          metadata: {},
          time: { start: 1, end: 2 },
        },
      },
    ],
  } as unknown as MessageWithParts;
}

function activationEntry(sessionId: ReturnType<typeof createSessionId>): SessionEntryInfo {
  return {
    id: `${sessionId}:runtime-dynamic-workflow-activation`,
    sessionID: sessionId,
    type: SESSION_ENTRY_DYNAMIC_WORKFLOW_ACTIVATION,
    time: { created: 1, updated: 1 },
    data: { activated: true, source: "command" },
  };
}

async function resumeOnDemandRuntime(input: {
  messages: MessageWithParts[];
  entries?: SessionEntryInfo[];
  config?: Record<string, unknown>;
  failActivationWrite?: boolean;
}) {
  const sessionId = createSessionId(`dwf-on-demand-resume-${Math.random().toString(36).slice(2)}`);
  const saveSessionEntry = vi.fn(async (entry: SessionEntryInfo) => {
    if (input.failActivationWrite && entry.type === SESSION_ENTRY_DYNAMIC_WORKFLOW_ACTIVATION)
      throw new Error("disk I/O error");
  });
  const store = {
    getSession: vi.fn(async () => persistedSession(sessionId)),
    messages: vi.fn(async () => input.messages),
    sessionEntries: vi.fn(async ({ type }: { type?: string }) =>
      type === SESSION_ENTRY_DYNAMIC_WORKFLOW_ACTIVATION ? (input.entries ?? []) : [],
    ),
    readTodos: vi.fn(async () => []),
    readTarget: vi.fn(async () => null),
    saveMessage: vi.fn(async () => {}),
    savePart: vi.fn(async () => {}),
    saveSessionEntry,
    updateSession: vi.fn(async () => persistedSession(sessionId)),
  } as unknown as SessionStorePort;
  const runtime = createTestAgentRuntime(
    sessionId,
    { ...ON_DEMAND_CONFIG, ...input.config, workingDirectory: "/workspace/project" },
    {
      eventStore: createTestSessionEventStore(),
      sessionStore: store,
      toolRegistry: createToolRegistry(),
    },
  );
  await runtime.resumeFromStore();
  const activationWrites = saveSessionEntry.mock.calls.filter(
    ([entry]) => (entry as SessionEntryInfo).type === SESSION_ENTRY_DYNAMIC_WORKFLOW_ACTIVATION,
  );
  return { runtime, activationWrites, saveSessionEntry };
}

describe("onDemand 冷恢复（DWG-10）", () => {
  it("entry 在场：首轮之前就有工具，且不重写 entry", async () => {
    const { runtime, activationWrites } = await resumeOnDemandRuntime({
      messages: [],
      entries: [activationEntry(createSessionId("any"))],
    });
    expect(runtime.getToolRegistry().has(CREATE_WORKFLOW_TOOL_NAME)).toBe(true);
    expect(activationWrites).toHaveLength(0);
  });

  it("没有 entry 但历史里有 `/workflow` 用户消息：按历史激活并补写 entry", async () => {
    const sessionId = createSessionId("h");
    const { runtime, activationWrites } = await resumeOnDemandRuntime({
      messages: [userMessage(sessionId, "hello"), userMessage(sessionId, "/workflow ship it")],
    });
    expect(runtime.getToolRegistry().has(CREATE_WORKFLOW_TOOL_NAME)).toBe(true);
    expect(activationWrites).toHaveLength(1);
    expect((activationWrites[0]![0] as SessionEntryInfo).data).toEqual({
      activated: true,
      source: "resume_history",
    });
  });

  it("没有 entry 但历史里有十个工具之一的调用（出生在 alwaysOn 的会话）：激活", async () => {
    const sessionId = createSessionId("h2");
    const { runtime } = await resumeOnDemandRuntime({
      messages: [
        userMessage(sessionId, "hello"),
        assistantToolMessage(sessionId, "ListWorkflowRuns"),
      ],
    });
    expect(runtime.getToolRegistry().has(CREATE_WORKFLOW_TOOL_NAME)).toBe(true);
  });

  it("两者都没有：保持按需，不写 entry", async () => {
    const sessionId = createSessionId("h3");
    const { runtime, activationWrites } = await resumeOnDemandRuntime({
      messages: [userMessage(sessionId, "hello"), assistantToolMessage(sessionId, "Read")],
    });
    expect(runtime.getToolRegistry().has(CREATE_WORKFLOW_TOOL_NAME)).toBe(false);
    expect(activationWrites).toHaveLength(0);
  });

  it("恢复后激活会落 entry（会话已持久化）", async () => {
    const sessionId = createSessionId("h4");
    const { runtime, saveSessionEntry } = await resumeOnDemandRuntime({
      messages: [userMessage(sessionId, "hello")],
    });
    await runtime.activateDynamicWorkflowTools({ source: "run_control" });
    const written = saveSessionEntry.mock.calls
      .map(([entry]) => entry as SessionEntryInfo)
      .filter((entry) => entry.type === SESSION_ENTRY_DYNAMIC_WORKFLOW_ACTIVATION);
    expect(written).toHaveLength(1);
    expect(written[0]!.data).toEqual({ activated: true, source: "run_control" });
  });

  it("激活 entry 写失败不让激活失败：工具照常到位，调用方拿到 true", async () => {
    // entry 只是历史扫描的捷径，缺了它冷恢复仍按 `/workflow` 或工作流工具调用判出激活。
    const sessionId = createSessionId("h5");
    const { runtime, saveSessionEntry } = await resumeOnDemandRuntime({
      messages: [userMessage(sessionId, "hello")],
      failActivationWrite: true,
    });
    await expect(runtime.activateDynamicWorkflowTools({ source: "command" })).resolves.toBe(true);
    expect(runtime.getToolRegistry().has(CREATE_WORKFLOW_TOOL_NAME)).toBe(true);
    expect(
      saveSessionEntry.mock.calls.filter(
        ([entry]) => entry.type === SESSION_ENTRY_DYNAMIC_WORKFLOW_ACTIVATION,
      ),
    ).toHaveLength(1);
  });

  it("alwaysOn 会话恢复时不看记录，出生即激活", async () => {
    const { runtime, activationWrites } = await resumeOnDemandRuntime({
      messages: [],
      config: { dynamicWorkflowToolsOnDemand: false },
    });
    expect(runtime.getToolRegistry().has(CREATE_WORKFLOW_TOOL_NAME)).toBe(true);
    expect(activationWrites).toHaveLength(0);
  });
});

describe("persistedMessagesShowDynamicWorkflow：历史判据", () => {
  const sessionId = createSessionId("scan");
  it.each([
    { text: "/workflow ship it", expected: true },
    { text: "/workflow", expected: true },
    { text: "  /Workflow do it", expected: true },
    { text: "please /workflow now", expected: false },
    { text: "/workflows list", expected: false },
    { text: "/init", expected: false },
  ])("用户文本 %j → %s", ({ text, expected }) => {
    expect(persistedMessagesShowDynamicWorkflow([userMessage(sessionId, text)])).toBe(expected);
  });

  it("assistant 的工具调用只认十个工作流工具；用户消息里的工具名文本不算", () => {
    expect(
      persistedMessagesShowDynamicWorkflow([assistantToolMessage(sessionId, "CreateWorkflow")]),
    ).toBe(true);
    expect(
      persistedMessagesShowDynamicWorkflow([assistantToolMessage(sessionId, "Workflow")]),
    ).toBe(false);
    expect(persistedMessagesShowDynamicWorkflow([userMessage(sessionId, "CreateWorkflow")])).toBe(
      false,
    );
    expect(persistedMessagesShowDynamicWorkflow([])).toBe(false);
  });
});
