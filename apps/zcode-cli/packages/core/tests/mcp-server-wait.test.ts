// 内部等待与动态 MCP：验证普通 step 快照、实时搜索和模型可见提醒。
// 规格见 docs/mcp-async-tool-catalog-cache.md。等待用手动释放的 Promise，不用 sleep。
import { describe, expect, it, vi } from "vitest";
import {
  type McpPort,
  type McpConnectionSnapshot,
  type McpServerToolSnapshot,
  type ModelRequest,
  toolSearchNameForMode,
} from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import type { ToolExecutionContext } from "../src/tool/types.js";
import {
  createRuntime,
  createSnapshotMcpPort,
  deferred,
  mcpStatus,
  messagesText,
  stdioServer,
  tool,
  toolNames,
} from "./mcp-runtime-fixture.js";

describe("dynamic MCP request boundaries", () => {
  it("does not let a plugin mention wait for unrelated background MCP startup", async () => {
    const startup = Promise.withResolvers<McpConnectionSnapshot>();
    const { runtime, requests } = createRuntime({
      label: "plugin-background",
      snapshot: { local: { status: mcpStatus("connecting") } },
      mcpPort: { connectConfiguredServers: () => startup.promise },
    });
    const turn = runtime.executeTurn("Use [@Demo](plugin://demo@mkt-a)");
    try {
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      await turn;
    } finally {
      startup.resolve({ statuses: {}, tools: [] });
      await turn;
      runtime.beginShutdown();
    }
  });

  it.each(["off", "local", "native"] as const)(
    "offers Wait only without ToolSearch and pending-only search otherwise in %s",
    async (mode) => {
      const { runtime, requests } = createRuntime({
        label: mode,
        toolSearchMode: mode,
        snapshot: { local: { status: mcpStatus("connecting") } },
      });
      await runtime.executeTurn("find tools");
      // ToolSearch 关闭时没有连接中公告，WaitForMcpServers 是唯一提示。
      expect(toolNames(requests[0]).includes("WaitForMcpServers")).toBe(mode === "off");
      // Local 的控制工具以 LocalToolSearch 发送；按模式取当前入口名。
      expect(toolNames(requests[0]).includes(toolSearchNameForMode(mode))).toBe(mode !== "off");
      expect(messagesText(requests[0])).not.toContain("WaitForMcpServers");
      expect(
        messagesText(requests[0]).includes("The following MCP servers are still connecting —"),
      ).toBe(mode !== "off");
      runtime.beginShutdown();
    },
  );

  it("searches ready tools in the same batch but registers them only for the following step", async () => {
    const snapshot: Record<string, McpServerToolSnapshot> = {
      local: { status: mcpStatus("connecting") },
    };
    const { runtime, requests } = createRuntime({
      label: "live-search",
      toolSearchMode: "native",
      toolDisallowlist: ["mcp__local__blocked"],
      snapshot,
      respond: (_request, index) => {
        if (index !== 0) return;
        snapshot.local = {
          status: mcpStatus("connected"),
          tools: [
            { ...tool("local", "ping"), description: "live-catalog probe" },
            { ...tool("local", "blocked"), description: "live-catalog probe" },
            {
              ...tool("local", "app_only"),
              description: "live-catalog probe",
              visibility: ["app"],
            },
          ],
          toolsVersion: "1",
        };
        return {
          text: "",
          finishReason: "tool-calls",
          usage: {},
          toolCalls: [
            {
              id: "search",
              name: "ToolSearch",
              input: { query: "live-catalog probe", max_results: 5 },
            },
            { id: "premature", name: "mcp__local__ping", input: {} },
          ],
        };
      },
    });
    await runtime.executeTurn("use ping");
    expect(toolNames(requests[0])).not.toContain("mcp__local__ping");
    expect(messagesText(requests[1])).toContain("tool_reference");
    expect(messagesText(requests[1])).toContain("mcp__local__ping");
    expect(messagesText(requests[1])).not.toContain("mcp__local__blocked");
    expect(messagesText(requests[1])).not.toContain("mcp__local__app_only");
    expect(toolNames(requests[1])).toContain("mcp__local__ping");
    expect(messagesText(requests[1])).not.toContain("MCP server status for this request");
    runtime.beginShutdown();
  });

  it("preserves the snapshot during continuation and consumes ready state on the next input", async () => {
    const snapshot: Record<string, McpServerToolSnapshot> = {
      local: { status: mcpStatus("connecting") },
    };
    const { runtime, requests } = createRuntime({
      label: "continuation",
      toolSearchMode: "off",
      snapshot,
      respond: (_request, index) => {
        if (index !== 0) return;
        snapshot.local = {
          status: mcpStatus("connected"),
          tools: [tool("local", "ping")],
          toolsVersion: "1",
        };
        return { text: "partial", finishReason: "length", usage: {} };
      },
    });
    await runtime.executeTurn("long answer");
    expect(requests).toHaveLength(2);
    expect(toolNames(requests[1])).toEqual(toolNames(requests[0]));
    await runtime.executeTurn("next input");
    expect(toolNames(requests[2])).toContain("mcp__local__ping");
    runtime.beginShutdown();
  });

  it("reconciles configuration in the background and retracts on the next input", async () => {
    const snapshot: Record<string, McpServerToolSnapshot> = {
      local: { status: mcpStatus("connected"), tools: [tool("local", "ping")], toolsVersion: "1" },
    };
    let config = { enabled: true, servers: { local: stdioServer() } };
    let notify = () => {};
    const connected: string[][] = [];
    const { runtime, requests } = createRuntime({
      label: "reconcile",
      toolSearchMode: "native",
      snapshot,
      mcpConfigurationSource: {
        getSnapshot: () => config,
        subscribe: (listener) => {
          notify = listener;
          return () => {};
        },
        close() {},
      },
      mcpPort: {
        connectConfiguredServers: async (servers) => {
          connected.push(Object.keys(servers));
          return { statuses: {}, tools: [] };
        },
      },
    });
    await runtime.executeTurn("setup");
    config = { enabled: true, servers: {} } as typeof config;
    notify();
    expect(connected.at(-1)).toEqual([]);
    expect(requests).toHaveLength(1);
    await runtime.executeTurn("after removal");
    expect(toolNames(requests[1])).not.toContain("mcp__local__ping");
    expect(messagesText(requests[1])).toContain("their MCP server disconnected");
    expect(messagesText(requests[1])).not.toContain("Disregard those definitions");
    // 其他内置 deferred 工具仍可保留搜索入口。
    runtime.beginShutdown();
  });

  it("does not advance the snapshot during reactive compact", async () => {
    const snapshot: Record<string, McpServerToolSnapshot> = {
      local: { status: mcpStatus("connecting") },
    };
    let overflowed = false;
    const { runtime, requests } = createRuntime({
      label: "compact",
      snapshot,
      respond: (request) => {
        if (messagesText(request).includes("create a detailed summary"))
          return { text: "<summary>Continue task.</summary>", finishReason: "stop", usage: {} };
        if (messagesText(request).includes("OVERFLOW") && !overflowed) {
          overflowed = true;
          snapshot.local = {
            status: mcpStatus("connected"),
            tools: [tool("local", "ping")],
            toolsVersion: "1",
          };
          throw Object.assign(new Error("provider context window exceeded"), {
            code: "model_context_exceeded",
          });
        }
      },
    });
    for (const input of ["one", "two", "three", "OVERFLOW"]) await runtime.executeTurn(input);
    expect(messagesText(requests.at(-1))).toContain("Continue task.");
    expect(toolNames(requests.at(-1))).not.toContain("mcp__local__ping");
    await runtime.executeTurn("normal input");
    expect(toolNames(requests.at(-1))).toContain("mcp__local__ping");
    runtime.beginShutdown();
  });
});

it("consumes ready MCP after a text response followed by guide", async () => {
  const snapshot: Record<string, McpServerToolSnapshot> = {
    local: { status: mcpStatus("connecting") },
  };
  const { runtime, requests } = createRuntime({
    label: "guide",
    snapshot,
    respond: async (_request, index) => {
      if (index !== 0) return;
      snapshot.local = {
        status: mcpStatus("connected"),
        tools: [tool("local", "ping")],
        toolsVersion: "1",
      };
      await runtime.steerTurn({ delivery: "guide", input: "continue with ping" });
    },
  });
  await runtime.executeTurn("start");
  expect(requests).toHaveLength(2);
  expect(toolNames(requests[0])).not.toContain("mcp__local__ping");
  expect(toolNames(requests[1])).toContain("mcp__local__ping");
  runtime.beginShutdown();
});

it("reports an origin-denied server as failed without retracting delivered definitions", async () => {
  const snapshot: Record<string, McpServerToolSnapshot> = {
    local: { status: mcpStatus("connected"), tools: [tool("local", "ping")], toolsVersion: "1" },
  };
  const { runtime, requests } = createRuntime({
    label: "policy-retraction",
    toolSearchMode: "native",
    snapshot,
    respond: (_request, index) =>
      index === 0
        ? {
            text: "",
            finishReason: "tool-calls",
            usage: {},
            toolCalls: [
              {
                id: "search",
                name: "ToolSearch",
                input: { query: "select:mcp__local__ping", max_results: 5 },
              },
            ],
          }
        : undefined,
  });
  try {
    await runtime.executeTurn("setup");
    snapshot.local = { status: mcpStatus("failed", { failureKind: "official_origin_untrusted" }) };
    await runtime.executeTurn("blocked");
    // 来源校验失败与连接失败同样处理：工具离开目录、server 列入失败段，已交付定义不撤回。
    expect(messagesText(requests.at(-1))).not.toContain("Disregard those definitions");
    expect(messagesText(requests.at(-1))).not.toContain("blocked by the organization");
    expect(messagesText(requests.at(-1))).toContain(
      "The following MCP servers are configured but failed to connect",
    );
    snapshot.local = {
      status: mcpStatus("connected"),
      tools: [tool("local", "ping")],
      toolsVersion: "2",
    };
    await runtime.executeTurn("restored");
    expect(messagesText(requests.at(-1))).toContain(
      "1 deferred tool is available again (MCP server reconnected — names announced earlier in this conversation)",
    );
  } finally {
    runtime.beginShutdown();
  }
});

it("explains why a previously offered MCP tool is no longer callable", async () => {
  const snapshot: Record<string, McpServerToolSnapshot> = {
    local: { status: mcpStatus("connected"), tools: [tool("local", "ping")], toolsVersion: "1" },
  };
  const { runtime, requests } = createRuntime({
    label: "unregistered-reason",
    snapshot,
    respond: (_request, index) =>
      index === 1
        ? {
            text: "",
            finishReason: "tool-calls",
            usage: {},
            toolCalls: [
              { id: "offered", name: "mcp__local__ping", input: {} },
              { id: "unknown", name: "mcp__other__ping", input: {} },
            ],
          }
        : undefined,
  });
  try {
    await runtime.executeTurn("first");
    snapshot.local = { status: mcpStatus("failed") };
    await runtime.executeTurn("second");
    const text = messagesText(requests[2]);
    // 修复前模型只看到 "No such tool available"，无法区分 server 断开与工具下线。
    expect(text).toContain(
      "<tool_use_error>Error: No such tool available: mcp__local__ping. Its MCP server 'local' has disconnected. Continue without this tool; it becomes callable again only if the server reconnects.</tool_use_error>",
    );
    // 本会话从未提供过的名称保持原报错。
    expect(text).toContain(
      "<tool_use_error>Error: No such tool available: mcp__other__ping</tool_use_error>",
    );
  } finally {
    runtime.beginShutdown();
  }
});

it("checks configuration again after an execution wait", async () => {
  const snapshot = {
    local: { status: mcpStatus("connected"), tools: [tool("local", "ping")], toolsVersion: "1" },
  };
  let waits = 0;
  let configuration = { enabled: true, servers: { local: stdioServer() } };
  let changed = () => {};

  const { runtime } = createRuntime({
    label: "withdraw-during-wait",
    snapshot,
    mcpConfigurationSource: {
      getSnapshot: () => configuration,
      subscribe: (listener) => {
        changed = listener;
        return () => {};
      },
      close() {},
    },
    mcpPort: {
      waitForServer: async () => {
        waits++;
        configuration = { enabled: false, servers: {} } as typeof configuration;
        changed();
        return { timedOut: false };
      },
    },
  });
  try {
    await runtime.executeTurn("prepare tools");
    const entry = (runtime as unknown as AgentRuntimeInternal).registry.get("mcp__local__ping")!;
    const resolved = await entry.resolveForExecution!({});
    expect(waits).toBe(1);
    expect(resolved.status).not.toBe("ready");
  } finally {
    runtime.beginShutdown();
  }
});

it("reports recovery from the connection owner's state and retains searchable tools", async () => {
  const snapshot: Record<string, McpServerToolSnapshot> = {
    local: {
      status: mcpStatus("connecting", { error: "stream closed" }),
      tools: [tool("local", "ping")],
      toolsVersion: "1",
    },
  };
  const { runtime, requests } = createRuntime({
    label: "recovery-facts",
    toolSearchMode: "native",
    snapshot,
  });
  try {
    await runtime.executeTurn("check capabilities");
    expect(messagesText(requests[0])).toContain("The following MCP servers are still connecting —");
    expect(messagesText(requests[0])).toContain("mcp__local__ping");
  } finally {
    runtime.beginShutdown();
  }
});

it("publishes each server catalog before the other servers finish, including an empty refresh", async () => {
  const snapshot: Record<string, McpServerToolSnapshot> = {
    fast: { status: mcpStatus("connecting") },
    slow: { status: mcpStatus("connecting") },
  };
  let notify = () => {};
  const published: Record<string, McpServerToolSnapshot>[] = [];
  const { runtime } = createRuntime({
    label: "independent-cache-publication",
    snapshot,
    servers: { fast: stdioServer(), slow: stdioServer() },
    mcpPort: {
      onSnapshotChanged(listener) {
        notify = listener;
        return () => {
          notify = () => {};
        };
      },
    },
    mcpToolCatalogPort: {
      prepare: () => ({
        lookup: { status: "incomplete", byServer: {} },
        publish: (value) => {
          if (value.fast?.status.status === "connected") published.push(structuredClone(value));
        },
      }),
    },
  });
  try {
    await runtime.executeTurn("start");
    snapshot.fast = {
      status: mcpStatus("connected"),
      tools: [tool("fast", "ping")],
      toolsVersion: "1",
    };
    notify();
    expect(published.map((value) => value.fast!.tools!.map((tool) => tool.toolName))).toEqual([
      ["ping"],
    ]);
    snapshot.fast = { status: mcpStatus("connected"), tools: [], toolsVersion: "2" };
    notify();
    expect(published.map((value) => value.fast!.tools!.map((tool) => tool.toolName))).toEqual([
      ["ping"],
      [],
    ]);
    expect(snapshot.slow.status.status).toBe("connecting");
  } finally {
    runtime.beginShutdown();
  }
  notify();
  expect(published).toHaveLength(2);
});

it("admits a destructive live tool on its first call from a display-only catalog", async () => {
  const descriptor = { ...tool("local", "erase"), annotations: { destructiveHint: true } };
  const snapshot: Record<string, McpServerToolSnapshot> = {
    local: { status: mcpStatus("connecting") },
  };
  const { runtime } = createRuntime({
    label: "catalog-unknown-execution-metadata",
    snapshot,
    mcpToolCatalogPort: {
      prepare: () => ({
        lookup: { status: "complete", byServer: { local: [tool("local", "erase")] } },
        publish() {},
      }),
    },
  });
  try {
    await runtime.executeTurn("prepare");
    const entry = (runtime as unknown as AgentRuntimeInternal).registry.get("mcp__local__erase")!;
    expect(entry.metadata.readOnly).toBe(false);
    expect(entry.metadata.concurrentSafe).toBe(false);
    snapshot.local = { status: mcpStatus("connected"), tools: [descriptor], toolsVersion: "1" };
    const live = await entry.resolveForExecution!({});
    expect(live.status).toBe("ready");
    if (live.status === "ready") expect(live.entry.metadata.destructive).toBe(true);
  } finally {
    runtime.beginShutdown();
  }
});

it.each(["connection", "definition"])(
  "runs an approved call after a same-config %s change",
  async (change) => {
    const descriptor = tool("local", "ping");
    const snapshot = {
      local: { status: mcpStatus("connected"), tools: [descriptor], toolsVersion: "1" },
    };
    let generation = 1;
    let calls = 0;
    const { runtime } = createRuntime({
      label: "execution-target-binding",
      snapshot,
      mcpPort: {
        appConnectionSnapshot: () => ({ identity: "local", generation }),
        callTool: async () => {
          calls++;
          return { content: [] };
        },
      },
    });
    try {
      await runtime.executeTurn("prepare");
      const entry = (runtime as unknown as AgentRuntimeInternal).registry.get("mcp__local__ping")!;
      const live = await entry.resolveForExecution!({});
      expect(live.status).toBe("ready");
      if (live.status !== "ready") return;
      if (change === "connection") generation++;
      else
        snapshot.local = {
          ...snapshot.local,
          tools: [
            {
              ...descriptor,
              inputSchema: { type: "object", properties: { required: { type: "string" } } },
            },
          ],
          toolsVersion: "2",
        };
      // 模型调用晚绑定当前连接：同配置重连或定义刷新后，已批准的调用仍执行。
      await live.entry.handler({}, {
        abortSignal: new AbortController().signal,
      } as ToolExecutionContext);
      expect(calls).toBe(1);
    } finally {
      runtime.beginShutdown();
    }
  },
);

it("rejects an approved call after its server configuration changes", async () => {
  const snapshot = {
    local: { status: mcpStatus("connected"), tools: [tool("local", "ping")], toolsVersion: "1" },
  };
  let configuration = { enabled: true, servers: { local: stdioServer() } };
  let changed = () => {};
  let calls = 0;
  const { runtime } = createRuntime({
    label: "execution-config-change",
    snapshot,
    mcpConfigurationSource: {
      getSnapshot: () => configuration,
      subscribe: (listener) => {
        changed = listener;
        return () => {};
      },
      close() {},
    },
    mcpPort: {
      callTool: async () => {
        calls++;
        return { content: [] };
      },
    },
  });
  try {
    await runtime.executeTurn("prepare");
    const entry = (runtime as unknown as AgentRuntimeInternal).registry.get("mcp__local__ping")!;
    const live = await entry.resolveForExecution!({});
    expect(live.status).toBe("ready");
    if (live.status !== "ready") return;
    configuration = { enabled: true, servers: { local: { ...stdioServer(), args: ["next"] } } };
    changed();
    await expect(
      live.entry.handler({}, {
        abortSignal: new AbortController().signal,
      } as ToolExecutionContext),
    ).rejects.toThrow(
      "MCP tool is unavailable in the current session: mcp__local__ping. Its MCP server 'local' has disconnected.",
    );
    expect(calls).toBe(0);
  } finally {
    runtime.beginShutdown();
  }
});

// ToolSearch 关闭时没有连接中公告：WaitForMcpServers 与执行器等待是模型知道 server 仍在连接的途径。
// 规格见 docs/mcp-async-tool-catalog-cache.md「ToolSearch 关闭时：WaitForMcpServers」「执行时不可用」。
describe("connecting MCP servers without ToolSearch", () => {
  const WAIT_DESCRIPTION = [
    "Wait for MCP servers that are still connecting and whose tools are not",
    "yet in your tool list. Pass `servers` to wait for specific ones, or omit",
    "it to wait for all pending servers (once none is pending, a call without",
    "`servers` reports any server that failed to connect or is not configured).",
    "",
    "If the user's request needs tools from a still-connecting server, call this",
    "tool to wait for it. Once it connects, its tools will be added to your tool",
    "list and you can use them directly. Returns ready=true when servers are",
    "ready, ready=false if they failed to connect, need authentication, or are",
    "disabled.",
    "",
    "You do not need to ask the user for confirmation to use this tool.",
  ].join("\n");

  function toolCallResponse(calls: Array<{ id: string; name: string; input?: unknown }>) {
    return {
      text: "",
      finishReason: "tool-calls",
      usage: {},
      toolCalls: calls.map((call) => ({ input: {}, ...call })),
    };
  }

  // MCP 工具总要审批；走真实执行器的用例用放行的 broker。
  const allowAll = { requestPermission: async () => ({ decision: "allow" as const }) };

  function toolResult(request: ModelRequest | undefined, id: string) {
    return request?.messages.find(
      (message) => message.role === "tool" && message.toolCallId === id,
    ) as { content: unknown; isError?: boolean } | undefined;
  }

  it("sends the fixed definition in sorted position and latches it after the first send", async () => {
    const snapshot: Record<string, McpServerToolSnapshot> = {
      local: { status: mcpStatus("connecting") },
    };
    const { runtime, requests } = createRuntime({ label: "wait-latch", snapshot });
    try {
      await runtime.executeTurn("first");
      const names = toolNames(requests[0]);
      const wait = requests[0]?.tools?.find((entry) => entry.name === "WaitForMcpServers");
      expect(wait?.description).toBe(WAIT_DESCRIPTION);
      expect(JSON.stringify(wait?.inputSchema)).toBe(
        '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"servers":{"description":"Server names to wait for (default: all pending)","type":"array","items":{"type":"string"}}},"additionalProperties":false}',
      );
      // 进入按名字排序的名单：排在 WebFetch 之前。
      expect(names.indexOf("WaitForMcpServers")).toBeLessThan(names.indexOf("WebFetch"));
      snapshot.local = {
        status: mcpStatus("connected"),
        tools: [tool("local", "ping")],
        toolsVersion: "1",
      };
      await runtime.executeTurn("second");
      // 发送过一次后保持，tools 段不因连接完成而变化。
      expect(toolNames(requests[1])).toContain("WaitForMcpServers");
    } finally {
      runtime.beginShutdown();
    }
  });

  it("never offers Wait when no server is connecting and nothing was sent", async () => {
    const { runtime, requests } = createRuntime({
      label: "wait-idle",
      snapshot: {
        local: {
          status: mcpStatus("connected"),
          tools: [tool("local", "ping")],
          toolsVersion: "1",
        },
      },
    });
    try {
      await runtime.executeTurn("first");
      expect(toolNames(requests[0])).not.toContain("WaitForMcpServers");
      // 不带模型的工具名单（持久化记录、子 agent 继承）同样不含它。
      expect(runtime.getTools().map((entry) => entry.name)).not.toContain("WaitForMcpServers");
    } finally {
      runtime.beginShutdown();
    }
  });

  it("waits for pending servers and reports each group with is_error when not ready", async () => {
    const snapshot: Record<string, McpServerToolSnapshot> = {
      local: { status: mcpStatus("connecting") },
      broken: { status: mcpStatus("failed", { error: "refused" }) },
    };
    const waited: string[] = [];
    const { runtime, requests } = createRuntime({
      label: "wait-groups",
      snapshot,
      servers: { local: stdioServer(), broken: stdioServer() },
      mcpPort: {
        waitForServer: async (name, options) => {
          waited.push(`${name}:${options.timeoutMs}`);
          snapshot.local = {
            status: mcpStatus("connected"),
            tools: [tool("local", "ping")],
            toolsVersion: "1",
          };
          return { timedOut: false };
        },
      },
      respond: (_request, index) =>
        index === 0
          ? toolCallResponse([
              { id: "all", name: "WaitForMcpServers" },
              { id: "named", name: "WaitForMcpServers", input: { servers: ["broken", "nope"] } },
            ])
          : undefined,
    });
    try {
      await runtime.executeTurn("wait");
      // 不传 servers 时只等 pending；不发起连接或授权。
      expect(waited).toEqual(["local:5000"]);
      expect(toolResult(requests[1], "all")).toMatchObject({
        content:
          "ready: true\nConnected (their tools are now available — call them directly): local",
        isError: false,
      });
      expect(toolResult(requests[1], "named")).toMatchObject({
        content:
          "ready: false\nFailed to connect: broken\nUnknown (no MCP server with this name is configured): nope",
        isError: true,
      });
    } finally {
      runtime.beginShutdown();
    }
  });

  it("runs a tool whose server finishes its first connection during the wait", async () => {
    const snapshot: Record<string, McpServerToolSnapshot> = {
      local: { status: mcpStatus("connecting") },
    };
    const calls: string[] = [];
    const waits: number[] = [];
    const { runtime, requests } = createRuntime({
      label: "pending-tool-wait",
      snapshot,
      permissionBroker: allowAll,
      mcpPort: {
        waitForServer: async (_name, options) => {
          // 执行准入（reconnect）对已连接 server 立即返回，不计入首次连接等待。
          if (!options.reconnect) waits.push(options.timeoutMs);
          snapshot.local = {
            status: mcpStatus("connected"),
            tools: [tool("local", "ping")],
            toolsVersion: "1",
          };
          return { timedOut: false };
        },
        callTool: async (request) => {
          calls.push(`${request.serverName}/${request.toolName}`);
          return { content: [{ type: "text", text: "pong" }] };
        },
      },
      respond: (_request, index) =>
        index === 0 ? toolCallResponse([{ id: "early", name: "mcp__local__ping" }]) : undefined,
    });
    try {
      await runtime.executeTurn("call early");
      expect(waits).toEqual([10_000]);
      expect(calls).toEqual(["local/ping"]);
      expect(toolResult(requests[1], "early")).toMatchObject({ isError: false });
      expect(JSON.stringify(toolResult(requests[1], "early")?.content)).toContain("pong");
    } finally {
      runtime.beginShutdown();
    }
  });

  it("shares ten seconds per response and stops waiting for an exhausted connection", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const snapshot: Record<string, McpServerToolSnapshot> = {
      local: { status: mcpStatus("connecting", { updatedAt: "episode-1" }) },
      other: { status: mcpStatus("connecting", { updatedAt: "episode-1" }) },
    };
    const waits: string[] = [];
    const { runtime, requests } = createRuntime({
      label: "pending-tool-budget",
      snapshot,
      servers: { local: stdioServer(), other: stdioServer() },
      mcpPort: {
        waitForServer: async (name, options) => {
          waits.push(`${name}:${options.timeoutMs}`);
          if (name === "other") {
            vi.setSystemTime(Date.now() + 4_000);
            snapshot.other = { status: mcpStatus("failed") };
            return { timedOut: false };
          }
          vi.setSystemTime(Date.now() + options.timeoutMs);
          return { timedOut: true };
        },
      },
      respond: (_request, index) =>
        index === 0
          ? toolCallResponse([
              { id: "other-call", name: "mcp__other__ping" },
              { id: "first", name: "mcp__local__ping" },
              { id: "second", name: "mcp__local__ping" },
            ])
          : index === 1
            ? toolCallResponse([{ id: "later", name: "mcp__local__ping" }])
            : index === 3
              ? toolCallResponse([{ id: "again", name: "mcp__local__ping" }])
              : undefined,
    });
    try {
      await runtime.executeTurn("call while connecting");
      // 同一回复共用 10 秒：other 用掉 4 秒，local 只剩 6 秒；没等满，不记为用尽。
      expect(waits.slice(0, 2)).toEqual(["other:10000", "local:6000"]);
      // 下一回复重新计预算；local 这次等满 10 秒，之后同一次连接不再等。
      expect(waits.slice(2)).toEqual(["local:10000"]);
      const text = JSON.stringify(toolResult(requests[2], "later")?.content);
      expect(text).toContain(
        "No such tool available: mcp__local__ping. The MCP server 'local' is still connecting. Call WaitForMcpServers to wait for it, then try again.",
      );
      snapshot.local = { status: mcpStatus("connecting", { updatedAt: "episode-2" }) };
      waits.length = 0;
      await runtime.executeTurn("new connection");
      // 新的一次连接重新允许等待。
      expect(waits).toEqual(["local:10000"]);
    } finally {
      vi.useRealTimers();
      runtime.beginShutdown();
    }
  });

  it("marks a connection exhausted when its full wait times out even if the clock reads less", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const waits: number[] = [];
    const { runtime } = createRuntime({
      label: "pending-tool-timed-out",
      snapshot: { local: { status: mcpStatus("connecting", { updatedAt: "episode-1" }) } },
      mcpPort: {
        waitForServer: async (_name, options) => {
          waits.push(options.timeoutMs);
          // 计时器按毫秒截断：等待已超时，墙钟只走了 9999 ms。
          vi.setSystemTime(Date.now() + options.timeoutMs - 1);
          return { timedOut: true };
        },
      },
      respond: (_request, index) =>
        index === 0 || index === 1
          ? toolCallResponse([{ id: `call-${index}`, name: "mcp__local__ping" }])
          : undefined,
    });
    try {
      await runtime.executeTurn("call twice");
      // 第一次等满后记为用尽；下一条回复不再为同一次连接等待。
      expect(waits).toEqual([10_000]);
    } finally {
      vi.useRealTimers();
      runtime.beginShutdown();
    }
  });

  it("maps the official computer-use tool prefix to its namespaced server", async () => {
    const official = "plugin:computer-use:computer-use";
    const snapshot: Record<string, McpServerToolSnapshot> = {
      [official]: { status: mcpStatus("connecting") },
    };
    const waited: string[] = [];
    const { runtime, requests } = createRuntime({
      label: "cua-prefix",
      snapshot,
      servers: { [official]: stdioServer() },
      mcpPort: {
        waitForServer: async (name, options) => {
          waited.push(`${name}:${options.timeoutMs}`);
          return { timedOut: false };
        },
      },
      respond: (_request, index) =>
        index === 0
          ? toolCallResponse([
              { id: "early", name: "mcp__computer-use__click" },
              { id: "wait", name: "WaitForMcpServers", input: { servers: ["computer-use"] } },
            ])
          : undefined,
    });
    try {
      await runtime.executeTurn("use the computer");
      // 规范名 `mcp__computer-use__*` 的连接记录名带插件命名空间：首次连接等待和名称匹配都要认出它。
      expect(waited).toEqual([`${official}:10000`, `${official}:5000`]);
      expect(toolResult(requests[1], "wait")).toMatchObject({
        content: `ready: false\nStill connecting (try again or proceed without): ${official}`,
        isError: true,
      });
    } finally {
      runtime.beginShutdown();
    }
  });

  it("does not wait for a recovering server that keeps its tool list", async () => {
    let waits = 0;
    const { runtime, requests } = createRuntime({
      label: "recovering-no-wait",
      snapshot: {
        local: {
          status: mcpStatus("connecting"),
          tools: [tool("local", "ping")],
          toolsVersion: "1",
        },
      },
      mcpPort: {
        waitForServer: async () => {
          waits++;
          return { timedOut: false };
        },
      },
      respond: (_request, index) =>
        index === 0 ? toolCallResponse([{ id: "guess", name: "mcp__local__unknown" }]) : undefined,
    });
    try {
      await runtime.executeTurn("guess a name");
      expect(waits).toBe(0);
      expect(JSON.stringify(toolResult(requests[1], "guess")?.content)).toContain(
        "No such tool available: mcp__local__unknown",
      );
    } finally {
      runtime.beginShutdown();
    }
  });

  it("runs a tool whose server connected after the step without waiting", async () => {
    const snapshot: Record<string, McpServerToolSnapshot> = {
      local: { status: mcpStatus("connecting") },
    };
    let waits = 0;
    const calls: string[] = [];
    const { runtime } = createRuntime({
      label: "connected-after-step",
      toolSearchMode: "native",
      snapshot,
      permissionBroker: allowAll,
      mcpPort: {
        waitForServer: async (_name, options) => {
          // 执行准入（reconnect）对已连接 server 立即返回，不计入首次连接等待。
          if (!options.reconnect) waits++;
          return { timedOut: false };
        },
        callTool: async (request) => {
          calls.push(request.toolName);
          return { content: [{ type: "text", text: "pong" }] };
        },
      },
      respond: (_request, index) => {
        if (index !== 0) return undefined;
        snapshot.local = {
          status: mcpStatus("connected"),
          tools: [tool("local", "ping")],
          toolsVersion: "1",
        };
        return toolCallResponse([{ id: "fresh", name: "mcp__local__ping" }]);
      },
    });
    try {
      await runtime.executeTurn("call fresh");
      expect(waits).toBe(0);
      expect(calls).toEqual(["ping"]);
    } finally {
      runtime.beginShutdown();
    }
  });
});
