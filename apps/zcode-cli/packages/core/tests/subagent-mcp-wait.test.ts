import { describe, expect, it, vi } from "vitest";
// 子 agent 启动前的 MCP 等待集合：mcpServers 与 tools 引用的 server 的并集。
import {
  createSessionId,
  modelMessageContentToText,
  type McpServerToolSnapshot,
  type ModelRequest,
} from "@zcode/contracts";
import { createSnapshotMcpPort, mcpStatus, stdioServer, tool } from "./mcp-runtime-fixture.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

const CHILD_AGENT_NAME = "mcp-agent";
const CHILD_REPLY = "mcp-agent 已启动。";
const PARENT_FINAL_REPLY = "父 agent 收到了结果。";
const CHILD_SERVER_WAIT_MS = 30_000;
const MISSING_TOOL_ERROR = "Required MCP tool is not available in the parent MCP snapshot";

type WaitForServer = (name: string) => Promise<{ timedOut: boolean }>;

function requestToolNames(request: ModelRequest | undefined): string[] {
  return request?.tools?.map((entry) => entry.name) ?? [];
}

async function runChild(input: {
  label: string;
  servers: readonly string[];
  snapshot: Record<string, McpServerToolSnapshot>;
  tools: readonly string[];
  waitForServer: WaitForServer;
}) {
  const parentRequests: ModelRequest[] = [];
  const childRequests: ModelRequest[] = [];
  const runtime = createTestAgentRuntime(
    createSessionId(`subagent-mcp-wait-${input.label}`),
    {
      mcp: {
        enabled: true,
        servers: Object.fromEntries(input.servers.map((name) => [name, stdioServer()])),
      },
      mode: "build",
      workingDirectory: "/workspace/project",
      subagents: {
        profiles: [
          {
            name: CHILD_AGENT_NAME,
            description: "只在 tools 里声明 MCP 工具的 agent。",
            source: "project",
            systemPrompt: "使用声明的 MCP 工具。",
            tools: [...input.tools],
          },
        ],
      },
    },
    {
      eventStore: createTestSessionEventStore(),
      mcpPort: createSnapshotMcpPort(input.snapshot, { waitForServer: input.waitForServer }),
      mcpStartupPolicy: "background",
      modelFactory: createTestModelFactory({
        async generateText(request: ModelRequest) {
          if (!requestToolNames(request).includes("Agent")) {
            childRequests.push(request);
            return { finishReason: "stop", text: CHILD_REPLY, usage: {} };
          }
          parentRequests.push(request);
          if (parentRequests.length > 1) {
            return { finishReason: "stop", text: PARENT_FINAL_REPLY, usage: {} };
          }
          return {
            finishReason: "tool-calls",
            text: "",
            toolCalls: [
              {
                id: "call_mcp_agent",
                name: "Agent",
                input: {
                  description: "启动 MCP 子 agent",
                  prompt: "调用声明的 MCP 工具。",
                  subagent_type: CHILD_AGENT_NAME,
                },
              },
            ],
            usage: {},
          };
        },
      } as never),
    },
  );
  try {
    const result = await runtime.executeTurn("让 mcp-agent 跑一下");
    const parentText = (parentRequests[1]?.messages ?? [])
      .map((message) => modelMessageContentToText(message.content))
      .join("\n");
    return { childRequests, parentText, result };
  } finally {
    runtime.beginShutdown();
  }
}

/** 等待结束时把 server 改成已连接并带上一个 search 工具。 */
function connectOnWait(snapshot: Record<string, McpServerToolSnapshot>) {
  return vi.fn<WaitForServer>(async (name) => {
    snapshot[name] = {
      status: mcpStatus("connected", { toolCount: 1 }),
      tools: [tool(name, "search")],
      toolsVersion: "2",
    };
    return { timedOut: false };
  });
}

describe("subagent MCP wait set", () => {
  it("starts a tools-only child after its referenced server finishes connecting", async () => {
    const snapshot: Record<string, McpServerToolSnapshot> = {
      "required-server": { status: mcpStatus("connecting") },
    };
    const waitForServer = connectOnWait(snapshot);

    // 修复前只等 mcpServers：只写 tools 的子 agent 在启动窗口内直接报工具缺失。
    const run = await runChild({
      label: "tools-only",
      servers: ["required-server"],
      snapshot,
      tools: ["mcp__required-server__search"],
      waitForServer,
    });

    expect(waitForServer).toHaveBeenCalledExactlyOnceWith("required-server", {
      timeoutMs: CHILD_SERVER_WAIT_MS,
    });
    expect(run.parentText).not.toContain(MISSING_TOOL_ERROR);
    expect(run.childRequests).toHaveLength(1);
    expect(requestToolNames(run.childRequests[0])).toContain("mcp__required-server__search");
    expect(run.result.response).toBe(PARENT_FINAL_REPLY);
  });

  it("maps model-visible references back to configured names exactly", async () => {
    const snapshot: Record<string, McpServerToolSnapshot> = {
      "plugin:demo:git": { status: mcpStatus("connecting") },
      "plugin:demo:github": { status: mcpStatus("connecting") },
      gitlab: { status: mcpStatus("connecting") },
    };
    const waitForServer = connectOnWait(snapshot);

    // 模型可见名 plugin_demo_git 是 plugin_demo_github 的前缀；子串匹配会多等无关 server。
    const run = await runChild({
      label: "exact-names",
      servers: ["plugin:demo:git", "plugin:demo:github", "gitlab"],
      snapshot,
      tools: ["mcp__plugin_demo_git__search"],
      waitForServer,
    });

    expect(waitForServer).toHaveBeenCalledExactlyOnceWith("plugin:demo:git", {
      timeoutMs: CHILD_SERVER_WAIT_MS,
    });
    expect(run.childRequests).toHaveLength(1);
    expect(requestToolNames(run.childRequests[0])).toContain("mcp__plugin_demo_git__search");
  });

  it("does not wait for unrelated servers when tools use the MCP wildcard", async () => {
    const snapshot: Record<string, McpServerToolSnapshot> = {
      fast: {
        status: mcpStatus("connected", { toolCount: 1 }),
        tools: [tool("fast", "ping")],
        toolsVersion: "1",
      },
      slow: { status: mcpStatus("connecting") },
    };
    const waitForServer = connectOnWait(snapshot);

    const run = await runChild({
      label: "wildcard",
      servers: ["fast", "slow"],
      snapshot,
      tools: ["mcp__*"],
      waitForServer,
    });

    expect(waitForServer).not.toHaveBeenCalled();
    expect(run.childRequests).toHaveLength(1);
  });

  it("keeps the original error when a referenced server fails while waiting", async () => {
    const snapshot: Record<string, McpServerToolSnapshot> = {
      "required-server": { status: mcpStatus("connecting") },
    };
    const waitForServer = vi.fn<WaitForServer>(async (name) => {
      snapshot[name] = { status: mcpStatus("failed", { error: "spawn failed" }) };
      return { timedOut: false };
    });

    const run = await runChild({
      label: "failed",
      servers: ["required-server"],
      snapshot,
      tools: ["mcp__required-server__search"],
      waitForServer,
    });

    expect(waitForServer).toHaveBeenCalledOnce();
    expect(run.childRequests).toEqual([]);
    expect(run.parentText).toContain(MISSING_TOOL_ERROR);
    expect(run.parentText).toContain("mcp__required-server__search");
  });
});
