import { expect, it, vi } from "vitest";
import { createSessionId, type McpServerToolSnapshot } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../../src/runtime/internal.js";
import { createRuntime, createSnapshotMcpPort, mcpStatus, tool } from "../mcp-runtime-fixture.js";
import { createTestAgentRuntime } from "../test-agent-runtime.js";
import { createTestSessionEventStore } from "../test-event-store.js";
import { isBorrowedMcpPort } from "../../src/subagent/borrowed-mcp-port.js";

it.each(["missing", "connected", "failed", "empty", "pending"])(
  "uses cached tools only for an admitted pending record with an unknown list: %s",
  async (status) => {
    const snapshot: Record<string, McpServerToolSnapshot> =
      status === "missing"
        ? {}
        : {
            local: {
              status: mcpStatus(
                status === "pending"
                  ? "connecting"
                  : status === "empty"
                    ? "connected"
                    : (status as "connected" | "failed"),
              ),
              ...(status === "empty" ? { tools: [] } : {}),
            },
          };
    const { runtime } = createRuntime({
      label: `cache-${status}`,
      snapshot,
      mcpToolCatalogPort: {
        prepare: () => ({
          lookup: { status: "complete", byServer: { local: [tool("local", "cached")] } },
          publish() {},
        }),
      },
    });
    try {
      const session = (runtime as unknown as AgentRuntimeInternal).mcpSession!;
      session.start();
      expect(session.read().tools.map((item) => item.toolName)).toEqual(
        status === "pending" ? ["cached"] : [],
      );
    } finally {
      runtime.beginShutdown();
    }
  },
);

it("reports background recovery only as pending and does not classify authorization as failure", async () => {
  const snapshot: Record<string, McpServerToolSnapshot> = {
    local: { status: mcpStatus("connecting", { error: "socket closed" }) },
  };
  const { runtime } = createRuntime({
    label: "recovery-facts",
    snapshot,
    toolSearchMode: "native",
  });
  try {
    await runtime.executeTurn("first");
    expect((runtime as unknown as AgentRuntimeInternal).mcpServerStatusFacts).toMatchObject({
      pending: ["local"],
      failed: [],
    });
    snapshot.local = {
      status: mcpStatus("failed", {
        authorization: {
          type: "oauth_authorization_code",
          authorizationUrl: "https://example.com/authorize",
          startedAt: "2026-01-01T00:00:00Z",
        },
      }),
    };
    await runtime.executeTurn("authorization required");
    expect((runtime as unknown as AgentRuntimeInternal).mcpServerStatusFacts).toMatchObject({
      pending: [],
      needsAuth: ["local"],
      failed: [],
    });
  } finally {
    runtime.beginShutdown();
  }
});
it("compares normalized connection diagnostics before deciding whether to repeat an announcement", async () => {
  const snapshot = {
    local: { status: mcpStatus("failed", { error: "socket\nclosed", errorCode: "ECONNRESET" }) },
  };
  const { runtime } = createRuntime({
    label: "normalized-diagnostic",
    snapshot,
    toolSearchMode: "native",
  });
  try {
    await runtime.executeTurn("first");
    const before = (runtime as unknown as AgentRuntimeInternal).mcpServerStatusFacts;
    expect(before.failed).toEqual([
      { name: "local", errorCode: "ECONNRESET", error: "socket closed" },
    ]);
    snapshot.local.status = mcpStatus("failed", {
      error: "socket\tclosed",
      errorCode: "ECONNRESET",
    });
    await runtime.executeTurn("same fact");
    expect((runtime as unknown as AgentRuntimeInternal).mcpServerStatusFacts).toEqual(before);
  } finally {
    runtime.beginShutdown();
  }
});
it("reads new connection records before notifications without publishing from reads", async () => {
  const snapshot: Record<string, McpServerToolSnapshot> = {
    local: { status: mcpStatus("connecting") },
  };
  const publish = vi.fn();
  const { runtime } = createRuntime({
    label: "pure-read",
    snapshot,
    mcpPort: { onSnapshotChanged: () => () => {} },
    mcpToolCatalogPort: {
      prepare: () => ({ lookup: { status: "incomplete", byServer: {} }, publish }),
    },
  });
  try {
    await runtime.executeTurn("first");
    publish.mockClear();
    snapshot.local = {
      status: mcpStatus("connected"),
      tools: [tool("local", "fresh")],
      toolsVersion: "1",
    };
    const session = (runtime as unknown as AgentRuntimeInternal).mcpSession!;
    expect(session.read().tools.map((item) => item.toolName)).toEqual(["fresh"]);
    session.read();
    expect(publish).not.toHaveBeenCalled();
  } finally {
    runtime.beginShutdown();
  }
});

it("registers the wait tool only with an MCP session and offers it only while a server connects", () => {
  const { runtime } = createRuntime({ label: "wait-registry", snapshot: {} });
  const withoutMcp = createTestAgentRuntime(
    createSessionId("wait-registry-without-mcp"),
    {},
    { eventStore: createTestSessionEventStore() },
  );
  try {
    expect(
      (runtime as unknown as AgentRuntimeInternal).registry.get("WaitForMcpServers"),
    ).toBeDefined();
    // 没有 server 在连接、也没有发送过：工具名单与没有该工具时相同。
    expect(runtime.getTools().map((entry) => entry.name)).not.toContain("WaitForMcpServers");
    expect(
      (withoutMcp as unknown as AgentRuntimeInternal).registry.get("WaitForMcpServers"),
    ).toBeUndefined();
  } finally {
    runtime.beginShutdown();
    withoutMcp.beginShutdown();
  }
});

it("preserves an injected port's directory when the parent does not own server configuration", async () => {
  const parentId = createSessionId("injected-parent");
  const port = createSnapshotMcpPort({
    local: { status: mcpStatus("connected"), tools: [tool("local", "ping")], toolsVersion: "1" },
  });
  const parent = createTestAgentRuntime(
    parentId,
    {},
    {
      eventStore: createTestSessionEventStore(),
      mcpPort: port,
    },
  );
  const access = await parent.createChildMcpAccess();
  // 所有权由端口标记推导，child 入口不再需要单独传递所有权参数。
  expect(isBorrowedMcpPort(access.deps.mcpPort)).toBe(true);
  expect(isBorrowedMcpPort(port)).toBe(false);
  const child = createTestAgentRuntime(
    createSessionId("injected-child"),
    {
      parentSessionId: parentId,
      mcp: access.config,
    },
    { eventStore: createTestSessionEventStore(), ...access.deps },
  );
  try {
    expect((child as unknown as AgentRuntimeInternal).mcpSession!.read().tools).toEqual([
      tool("local", "ping"),
    ]);
  } finally {
    child.beginShutdown();
    parent.beginShutdown();
  }
});

it("a fork owns its connection even though its history has a parent", async () => {
  const connectConfiguredServers = vi.fn(async () => ({ statuses: {}, tools: [] }));
  const runtime = createTestAgentRuntime(
    createSessionId("fork-owner"),
    {
      parentSessionId: createSessionId("fork-parent"),
      mcp: { enabled: true, servers: { local: { type: "stdio", command: "node" } } },
    },
    {
      eventStore: createTestSessionEventStore(),
      mcpPort: createSnapshotMcpPort({}, { connectConfiguredServers }),
    },
  );
  try {
    await (runtime as unknown as AgentRuntimeInternal).mcpSession!.start();
    expect(connectConfiguredServers).toHaveBeenCalledOnce();
  } finally {
    runtime.beginShutdown();
  }
});

it("a view without a catalog publisher does not subscribe to connection notifications", () => {
  const subscribe = vi.fn(() => vi.fn());
  const { runtime } = createRuntime({
    label: "no-publisher",
    snapshot: {},
    mcpPort: { onSnapshotChanged: subscribe },
  });
  try {
    (runtime as unknown as AgentRuntimeInternal).mcpSession!.start();
    expect(subscribe).not.toHaveBeenCalled();
  } finally {
    runtime.beginShutdown();
  }
});

it("target check follows the live connection and rejects only a missing tool or server", async () => {
  const target = tool("local", "run");
  const snapshot: Record<string, McpServerToolSnapshot> = {
    local: { status: mcpStatus("connected"), tools: [target], toolsVersion: "1" },
  };
  const { runtime } = createRuntime({ label: "target-admission", snapshot });
  try {
    const admission = await (runtime as unknown as AgentRuntimeInternal).mcpSession!.resolve(
      target,
    );
    if (!("checkTarget" in admission)) throw new Error("Tool admission failed");
    expect(admission.checkTarget()).toBeUndefined();
    snapshot.local = {
      ...snapshot.local!,
      tools: [
        { ...target, inputSchema: { type: "object", properties: { added: { type: "string" } } } },
        tool("local", "other"),
      ],
      toolsVersion: "2",
    };
    // 定义刷新或同配置重连不影响已批准的调用。
    expect(admission.checkTarget()).toBeUndefined();
    snapshot.local = { ...snapshot.local!, tools: [tool("local", "other")], toolsVersion: "3" };
    expect(admission.checkTarget()).toBe(
      "Its MCP server 'local' is connected but does not offer this tool here. Continue without it.",
    );
    snapshot.local = { status: mcpStatus("failed") };
    expect(admission.checkTarget()).toBe(
      "Its MCP server 'local' has disconnected. Continue without this tool; it becomes callable again only if the server reconnects.",
    );
  } finally {
    runtime.beginShutdown();
  }
});

it.each(["failed", "connecting", "disabled"] as const)(
  "execution rejection explains the current server state: %s",
  async (status) => {
    const snapshot = {
      local: { status: mcpStatus(status), tools: [tool("local", "run")], toolsVersion: "1" },
    };
    const { runtime } = createRuntime({ label: `unavailable-${status}`, snapshot });
    try {
      const resolved = await (runtime as unknown as AgentRuntimeInternal).mcpSession!.resolve(
        tool("local", "run"),
      );
      expect(resolved).toMatchObject({
        unavailableReason: expect.stringMatching(
          status === "connecting"
            ? /still connecting/
            : status === "disabled"
              ? /disabled/
              : /disconnected/,
        ),
      });
    } finally {
      runtime.beginShutdown();
    }
  },
);
