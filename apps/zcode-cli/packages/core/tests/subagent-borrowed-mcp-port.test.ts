import { createMockMcpPort } from "./mcp-runtime-fixture.js";
import { describe, expect, it, vi } from "vitest";
import type {
  McpConnectionSnapshot,
  McpPort,
  McpServerStatus,
  McpToolDescriptor,
} from "@zcode/contracts";
import { createBorrowedSubagentMcpAccess } from "../src/subagent/borrowed-mcp-port.js";

describe("borrowed subagent MCP port", () => {
  it("replays an exact server-scoped startup snapshot with connected tools only", async () => {
    const alphaTool = createDescriptor("alpha", "search");
    const similarlyNamedTool = createDescriptor("alpha-extra", "search");
    const disconnectedTool = createDescriptor("offline", "search");
    const startupSnapshot: McpConnectionSnapshot = {
      statuses: {
        alpha: createStatus("connected"),
        "alpha-extra": createStatus("connected"),
        offline: createStatus("disconnected"),
      },
      tools: [alphaTool, similarlyNamedTool, disconnectedTool],
    };
    const parentPort = createMockMcpPort();

    const borrowed = createBorrowedSubagentMcpAccess(parentPort, startupSnapshot, [
      "alpha",
      "offline",
    ]);

    expect(borrowed.snapshot.statuses).toEqual({
      alpha: startupSnapshot.statuses.alpha,
      offline: startupSnapshot.statuses.offline,
    });
    expect(borrowed.snapshot.tools).toEqual([alphaTool]);

    startupSnapshot.statuses.late = createStatus("connected");
    startupSnapshot.tools.push(createDescriptor("alpha", "late-tool"));
    const firstStatuses = await borrowed.port.status();
    const firstTools = await borrowed.port.listTools();
    delete firstStatuses.alpha;
    firstTools.push(createDescriptor("alpha", "caller-mutation"));

    expect(await borrowed.port.status()).toEqual({
      alpha: startupSnapshot.statuses.alpha,
      offline: startupSnapshot.statuses.offline,
    });
    expect(await borrowed.port.listTools()).toEqual([alphaTool]);
    expect(parentPort.status).not.toHaveBeenCalled();
    expect(parentPort.listTools).not.toHaveBeenCalled();
  });

  it("delegates visible calls without propagating child lifecycle operations", async () => {
    const callTool = vi.fn(async () => ({
      content: [{ type: "text", text: "parent result" }],
    }));
    const parentPort = createMockMcpPort({ callTool });
    const borrowed = createBorrowedSubagentMcpAccess(
      parentPort,
      {
        statuses: {
          alpha: createStatus("connected"),
          beta: createStatus("connected"),
        },
        tools: [createDescriptor("alpha", "search"), createDescriptor("beta", "search")],
      },
      ["alpha"],
    );
    const request = {
      serverName: "alpha",
      toolName: "search",
      arguments: { query: "zcode" },
    };
    const options = { timeoutMs: 1_000 };

    await expect(borrowed.port.callTool(request, options)).resolves.toEqual({
      content: [{ type: "text", text: "parent result" }],
    });
    expect(callTool).toHaveBeenCalledWith(request, options);
    await expect(
      borrowed.port.callTool({ serverName: "beta", toolName: "search" }),
    ).rejects.toThrow("outside visible scope");

    await expect(borrowed.port.connectConfiguredServers({})).rejects.toThrow(
      "cannot mutate parent connection lifecycle",
    );
    await expect(
      borrowed.port.connectServer("alpha", { type: "stdio", command: "mcp" }),
    ).rejects.toThrow("cannot mutate parent connection lifecycle");
    await expect(borrowed.port.disconnectServer("alpha")).rejects.toThrow(
      "cannot mutate parent connection lifecycle",
    );
    await expect(borrowed.port.close()).resolves.toBeUndefined();

    expect(parentPort.connectConfiguredServers).not.toHaveBeenCalled();
    expect(parentPort.connectServer).not.toHaveBeenCalled();
    expect(parentPort.disconnectServer).not.toHaveBeenCalled();
    expect(parentPort.close).not.toHaveBeenCalled();
  });

  it("hides and blocks denied official servers without forwarding to the parent", async () => {
    const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "parent result" }] }));
    const parentPort = createMockMcpPort({ callTool });
    const official = createDescriptor("plugin:computer-use:computer-use", "left_click");
    const unrelated = createDescriptor("plugin:demo:search", "lookup");
    const borrowed = createBorrowedSubagentMcpAccess(
      parentPort,
      {
        statuses: {
          "plugin:computer-use:computer-use": createStatus("connected"),
          "plugin:demo:search": createStatus("connected"),
        },
        tools: [official, unrelated],
      },
      undefined,
      new Set(["plugin:computer-use:computer-use"]),
    );

    expect(borrowed.snapshot.statuses).toEqual({
      "plugin:demo:search": expect.anything(),
    });
    expect(borrowed.snapshot.tools).toEqual([unrelated]);
    await expect(
      borrowed.port.callTool({
        serverName: official.serverName,
        toolName: official.toolName,
      }),
    ).rejects.toThrow("Computer Use is not available in subagent");
    expect(callTool).not.toHaveBeenCalled();
    await expect(
      borrowed.port.callTool({ serverName: unrelated.serverName, toolName: unrelated.toolName }),
    ).resolves.toEqual({ content: [{ type: "text", text: "parent result" }] });
  });
});

function createDescriptor(serverName: string, toolName: string): McpToolDescriptor {
  return {
    serverName,
    toolName,
    inputSchema: { type: "object" },
  };
}

function createStatus(status: McpServerStatus["status"]): McpServerStatus {
  return {
    status,
    transport: "stdio",
    toolCount: status === "connected" ? 1 : 0,
    updatedAt: "now",
  };
}

it("reads live definitions inside the original child scope and fences replaced sources", async () => {
  let connection = { identity: "source-a", generation: 1 };
  const original = {
    serverName: "alpha",
    toolName: "read",
    inputSchema: { type: "object" } as const,
  };
  const live = { ...original, annotations: { readOnlyHint: true } };
  const statuses = {
    alpha: {
      status: "connected" as const,
      transport: "stdio" as const,
      toolCount: 1,
      updatedAt: "",
    },
  };
  const callTool = vi.fn(async () => ({ content: [] }));
  const waitForServer = vi.fn(async () => ({ timedOut: false }));
  const parent = createMockMcpPort({
    waitForServer,
    callTool,
    appConnectionSnapshot: () => connection,
    getToolSnapshot: () => ({
      alpha: {
        status: statuses.alpha,
        tools: [live, { ...live, toolName: "new" }],
        toolsVersion: "2",
      },
      extra: { status: statuses.alpha, tools: [], toolsVersion: "1" },
    }),
  });
  const child = createBorrowedSubagentMcpAccess(parent, { statuses, tools: [original] });
  await child.port.waitForServer!("alpha", { timeoutMs: 100 });
  await child.port.waitForServer!("extra", { timeoutMs: 100 });
  expect(waitForServer).toHaveBeenCalledExactlyOnceWith("alpha", { timeoutMs: 100 });
  expect(Object.keys(child.port.getToolSnapshot!()!)).toEqual(["alpha"]);
  expect(child.port.getToolSnapshot!()!.alpha!.tools).toEqual([live]);
  connection = { ...connection, generation: 2 }; // 原配置恢复，允许重新准入。
  await child.port.callTool({ serverName: "alpha", toolName: "read" });
  // 同配置重连只换 generation，调用直接交给父连接晚绑定，不附带连接栅栏。
  expect(callTool).toHaveBeenCalledWith({ serverName: "alpha", toolName: "read" }, undefined);
  callTool.mockClear();
  connection = { identity: "source-b", generation: 1 };
  expect(child.port.getToolSnapshot!()).toEqual({});
  await expect(child.port.callTool({ serverName: "alpha", toolName: "read" })).rejects.toThrow(
    /changed/,
  );
  expect(callTool).not.toHaveBeenCalled();
});
