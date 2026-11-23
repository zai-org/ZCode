// PLG01/PLG06/PLG07/PLG08/PLG11 的 runtime 集成取证（docs/plugin-reference-mention.md，
// docs/conversation-session-case-catalog.md PLG 组）：
// turn start 注入顺序、冻结 catalog 语义、每轮重解析 + live 交集、model-only 输入不解析、
// reminder 以 model-only notice 持久化并可由 hydration 重建（不落 TurnStarted input、不作为真实 user message）。
import { describe, expect, it, vi } from "vitest";
import {
  createSessionId,
  type McpPort,
  type PluginReferenceCatalog,
  type SkillPort,
  type McpServerStatus,
} from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

const DEMO_CATALOG: PluginReferenceCatalog = {
  plugins: [
    {
      pluginId: "demo@mkt-a",
      name: "demo",
      marketplace: "mkt-a",
      enabled: true,
      conflictingPluginIds: [],
      skillQualifiedNames: ["demo:search"],
      mcpServerNames: ["plugin:demo:main"],
      subagentNames: ["demo:reviewer"],
      rootPath: "/plugins/demo",
    },
  ],
};

function createSkillPort(): SkillPort {
  return {
    async discoverSkills() {
      return {
        skills: [
          {
            name: "search",
            description: "search things",
            pluginName: "demo",
            qualifiedName: "demo:search",
            path: "/plugins/demo/skills/search/SKILL.md",
            directory: "/plugins/demo/skills/search",
            rootPath: "/plugins/demo/skills",
            scope: "user" as const,
            source: "plugin" as const,
            safeToAutoLoad: true,
            frontmatterKeys: [],
          },
        ],
        diagnostics: [],
        totalDiscovered: 1,
      };
    },
    async loadSkill() {
      throw new Error("not needed");
    },
  };
}

function createMcpPort(statuses: Record<string, McpServerStatus>): McpPort {
  const tools = [
    {
      serverName: "plugin:demo:main",
      toolName: "lookup",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
    },
  ];
  return {
    getToolSnapshot: () =>
      Object.fromEntries(
        Object.entries(statuses).map(([name, status]) => [
          name,
          {
            status,
            tools:
              status.status === "connected"
                ? tools.filter((tool) => tool.serverName === name)
                : undefined,
            toolsVersion: "1",
          },
        ]),
      ),
    connectConfiguredServers: async () => ({
      statuses,
      tools,
    }),
    connectServer: async () => ({
      status: "connected",
      transport: "stdio",
      toolCount: 1,
      updatedAt: "now",
    }),
    disconnectServer: async () => undefined,
    // 端口状态与工具快照来自同一份内存记录。
    status: async () => statuses,
    listTools: async () => [],
    callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
    close: async () => {},
  };
}

function connectedStatus(): Record<string, McpServerStatus> {
  return {
    "plugin:demo:main": {
      status: "connected",
      transport: "stdio",
      toolCount: 1,
      updatedAt: "now",
    },
  };
}

interface CapturedRequest {
  messages: Array<{ role: string; text: string }>;
  texts: string[];
  toolNames: string[];
}

function createRuntime(input: {
  catalog?: PluginReferenceCatalog;
  statuses?: Record<string, McpServerStatus>;
  requests: CapturedRequest[];
}) {
  const sessionId = createSessionId("plugin-reference-runtime");
  const statuses = input.statuses ?? connectedStatus();
  return createTestAgentRuntime(
    sessionId,
    {
      mode: "build",
      ...(input.catalog ? { pluginReferenceCatalog: input.catalog } : {}),
      subagents: {
        profiles: [
          {
            name: "demo:reviewer",
            description: "E2E reviewer profile description",
            path: "/plugins/demo/agents/reviewer.md",
            source: "user",
            systemPrompt: "Review the requested files",
          },
        ],
      },
      mcp: {
        enabled: true,
        servers: {
          "plugin:demo:main": {
            type: "stdio",
            command: "node",
            args: ["server.js"],
          },
        },
      },
    },
    {
      eventStore: createTestSessionEventStore(),
      mcpPort: createMcpPort(statuses),
      skillPort: createSkillPort(),
      modelFactory: createTestModelFactory({
        properties: { supportsMidConversationSystem: true },
        async generateText(request: any) {
          const messages = request.messages.map((message: any) => ({
            role: String(message.role),
            text:
              typeof message.content === "string"
                ? message.content
                : JSON.stringify(message.content),
          }));
          input.requests.push({
            messages,
            texts: messages.map((message) => message.text),
            toolNames: (request.tools ?? []).map((tool: { name: string }) => tool.name),
          });
          return {
            finishReason: "stop",
            providerMetadata: undefined,
            text: "done",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          };
        },
      } as never),
    },
  );
}

function pluginReferenceIndexes(request: CapturedRequest): number[] {
  return request.texts
    .map((text, index) => (text.includes("<plugin_reference>") ? index : -1))
    .filter((index) => index >= 0);
}

describe("plugin reference runtime injection", () => {
  it("injects a single identifiers-only system reminder after the real user message (PLG01)", async () => {
    const requests: CapturedRequest[] = [];
    const runtime = createRuntime({ catalog: DEMO_CATALOG, requests });

    const result = await runtime.executeTurn(
      "PLG01_MARKER use [@Demo](plugin://demo@mkt-a) for this",
    );
    expect(result.response).toBe("done");

    const request = requests[0]!;
    const reminderIndexes = pluginReferenceIndexes(request);
    expect(reminderIndexes).toHaveLength(1);
    const reminderText = request.texts[reminderIndexes[0]!]!;
    expect(request.messages[reminderIndexes[0]!]?.role).toBe("system");
    expect(reminderText).not.toContain("<system-reminder>");
    expect(reminderText).toContain("<plugin_reference>");
    const pluginReminderText =
      reminderText.match(/<plugin_reference>[\s\S]*?<\/plugin_reference>/)?.[0] ?? "";
    expect(pluginReminderText).toContain('- id: "demo@mkt-a"');
    expect(pluginReminderText).toContain('skills: ["demo:search"]');
    expect(pluginReminderText).toContain('mcp_servers: ["plugin:demo:main"]');
    expect(pluginReminderText).toContain('subagents: ["demo:reviewer"]');
    // identifiers-only：描述、路径、命令、环境变量都不得出现。
    expect(pluginReminderText).not.toContain("/plugins/demo");
    expect(pluginReminderText).not.toContain("server.js");
    expect(pluginReminderText).not.toContain("search things");
    expect(pluginReminderText).not.toContain("E2E reviewer profile description");
    expect(pluginReminderText).not.toContain("Review the requested files");

    const userIndex = request.texts.findIndex((text) => text.includes("PLG01_MARKER"));
    expect(userIndex).toBeLessThan(reminderIndexes[0]!);
  });

  it("skips unknown ids and keeps the conversation running without any reminder (PLG02)", async () => {
    const requests: CapturedRequest[] = [];
    const runtime = createRuntime({ catalog: DEMO_CATALOG, requests });

    const result = await runtime.executeTurn(
      "PLG02_MARKER try [@ghost](plugin://ghost@mkt-x) please",
    );
    expect(result.response).toBe("done");
    expect(pluginReferenceIndexes(requests[0]!)).toHaveLength(0);
  });

  it("resolves against the frozen session catalog only (PLG06)", async () => {
    const requests: CapturedRequest[] = [];
    // catalog 未注入（模拟 Session 冻结时该 Plugin 尚未启用）→ unknown → 不注入。
    const runtime = createRuntime({ requests });

    await runtime.executeTurn("PLG06_MARKER [@Demo](plugin://demo@mkt-a)");
    expect(pluginReferenceIndexes(requests[0]!)).toHaveLength(0);
  });

  it("re-parses on every execution and re-intersects with live inventory (PLG07)", async () => {
    const requests: CapturedRequest[] = [];
    const statuses = connectedStatus();
    const runtime = createRuntime({ catalog: DEMO_CATALOG, statuses, requests });

    await runtime.executeTurn("PLG07_TURN1 [@Demo](plugin://demo@mkt-a)");
    // 模拟 MCP 断线：live status() 变化，冻结 catalog 与已发现 Skill 不变。
    statuses["plugin:demo:main"] = {
      status: "disconnected",
      transport: "stdio",
      toolCount: 0,
      updatedAt: "later",
    };
    await runtime.executeTurn("PLG07_TURN2 [@Demo](plugin://demo@mkt-a)");

    const secondRequest = requests[1]!;
    const reminderIndexes = pluginReferenceIndexes(secondRequest);
    // 第一轮 reminder 作为 append-only 历史保留；第二轮按 live inventory 生成新 reminder。
    expect(reminderIndexes).toHaveLength(2);
    const latestReminder = secondRequest.texts[reminderIndexes.at(-1)!]!;
    expect(latestReminder).toContain("mcp_servers: []");
    expect(latestReminder).toContain('skills: ["demo:search"]');
  });

  it("parses only persisted canonical displayInput, never an expanded command prompt (PLG07)", async () => {
    const requests: CapturedRequest[] = [];
    const runtime = createRuntime({ catalog: DEMO_CATALOG, requests });

    // 自定义命令模板展开后的模型输入即使带 plugin://，也不能凭空获得用户引用语义。
    await runtime.executeTurn("expanded template [@Demo](plugin://demo@mkt-a)", undefined, {
      displayInput: "/template-without-reference",
    });
    expect(pluginReferenceIndexes(requests[0]!)).toHaveLength(0);

    // 反向证明：权威 canonical displayInput 有引用时，即使 runtime prompt 本身没有链接也应注入。
    await runtime.executeTurn("expanded template without a plugin link", undefined, {
      displayInput: "use [@Demo](plugin://demo@mkt-a)",
    });
    expect(pluginReferenceIndexes(requests[1]!)).toHaveLength(1);
  });

  it("excludes MCP servers whose last visible tool is hidden for this turn (PLG10)", async () => {
    const requests: CapturedRequest[] = [];
    const runtime = createRuntime({ catalog: DEMO_CATALOG, requests });

    await runtime.executeTurn("PLG10_MARKER [@Demo](plugin://demo@mkt-a)", undefined, {
      toolDisallowlist: ["mcp__plugin_demo_main__lookup"],
    });

    const request = requests[0]!;
    const reminderIndexes = pluginReferenceIndexes(request);
    expect(reminderIndexes).toHaveLength(1);
    const reminder = request.texts[reminderIndexes[0]!]!;
    expect(reminder).toContain('skills: ["demo:search"]');
    expect(reminder).toContain("mcp_servers: []");
    expect(request.toolNames).not.toContain("mcp__plugin_demo_main__lookup");
  });

  it("does not parse model-only runtime inputs (PLG07 边界)", async () => {
    const requests: CapturedRequest[] = [];
    const runtime = createRuntime({ catalog: DEMO_CATALOG, requests });

    await runtime.executeTurn("PLG_MODEL_ONLY [@Demo](plugin://demo@mkt-a)", undefined, {
      inputVisibility: "model-only",
      inputSource: "goal-continuation",
    });
    expect(pluginReferenceIndexes(requests[0]!)).toHaveLength(0);
  });

  it("persists the reminder as a model-only notice without changing TurnStarted input (PLG08)", async () => {
    const requests: CapturedRequest[] = [];
    const runtime = createRuntime({ catalog: DEMO_CATALOG, requests });
    const persistNotice = vi.spyOn(
      runtime as unknown as {
        persistSyntheticUserNoticeForSession: (...args: any[]) => Promise<void>;
      },
      "persistSyntheticUserNoticeForSession",
    );

    const result = await runtime.executeTurn("PLG08_MARKER [@Demo](plugin://demo@mkt-a)");
    const turnStarted = result.events.find((event) => event.type === "turn_started");
    const payload = (turnStarted?.payload ?? {}) as { input?: string };
    // 用户可见输入保持 canonical 原文；reminder 不混入 TurnStarted input，也不是真实 user message。
    expect(payload.input).toContain("PLG08_MARKER");
    expect(payload.input ?? "").not.toContain("<plugin_reference>");
    expect(
      persistNotice.mock.calls.filter(([notice]) => notice.source === "plugin_reference"),
    ).toHaveLength(1);
    expect(persistNotice).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: runtime.getSessionId(),
        source: "plugin_reference",
        text: expect.stringContaining("<plugin_reference>"),
      }),
    );
  });
});
