import { expect, it } from "vitest";
// 需要用户授权的 server：保留的目录仍在视图里，调用结果告诉模型去哪里授权。
import type { McpServerToolSnapshot, ToolExecutionContext } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../../src/runtime/internal.js";
import { createRuntime, mcpStatus, stdioServer, tool } from "../mcp-runtime-fixture.js";

const TOOL_NAME = "mcp__remote__search";
const AUTHORIZATION = { type: "oauth_authorization_code" } as const;
const NEEDS_AUTH_TEXT =
  "MCP tool is unavailable in the current session: mcp__remote__search. Its MCP server 'remote' needs the user to re-authorize it before its tools work again. Ask the user to authorize it in the ZCode MCP settings.";

function connectedRemote(): Record<string, McpServerToolSnapshot> {
  return {
    remote: {
      status: mcpStatus("connected", { toolCount: 1 }),
      tools: [tool("remote", "search")],
      toolsVersion: "1",
    },
  };
}

async function resolveReady(runtime: ReturnType<typeof createRuntime>["runtime"]) {
  await runtime.executeTurn("prepare");
  const entry = (runtime as unknown as AgentRuntimeInternal).registry.get(TOOL_NAME)!;
  const live = await entry.resolveForExecution!({});
  if (live.status !== "ready") throw new Error(`expected a ready tool, got ${live.status}`);
  return live.entry;
}

it("keeps retained tools of a server whose authorization ended without completing", async () => {
  const snapshot: Record<string, McpServerToolSnapshot> = {
    remote: {
      status: mcpStatus("failed", { failureKind: "oauth_authorization_failed" }),
      tools: [tool("remote", "search")],
      toolsVersion: "1",
    },
  };
  const { runtime } = createRuntime({
    label: "needs-auth-retained",
    snapshot,
    servers: { remote: stdioServer() },
  });
  try {
    // 修复前视图只列 connected/connecting 的工具：授权失败后工具离开视图，产生撤销提醒。
    const view = (runtime as unknown as AgentRuntimeInternal).mcpSession!.read();
    expect(view.tools.map((item) => item.toolName)).toEqual(["search"]);
  } finally {
    runtime.beginShutdown();
  }
});

it("tells the model to ask for authorization when a call starts one", async () => {
  const snapshot = connectedRemote();
  const { runtime } = createRuntime({
    label: "needs-auth-call",
    snapshot,
    servers: { remote: stdioServer() },
    mcpPort: {
      // 调用期 401：adapter 发起授权、发布链接后以原始错误结束这次调用。
      callTool: async () => {
        snapshot.remote = {
          ...snapshot.remote!,
          status: mcpStatus("connecting", { authorization: AUTHORIZATION }),
        };
        throw new Error("Unauthorized");
      },
    },
  });
  try {
    const entry = await resolveReady(runtime);
    await expect(
      entry.handler({}, { abortSignal: new AbortController().signal } as ToolExecutionContext),
    ).rejects.toThrow(NEEDS_AUTH_TEXT);
  } finally {
    runtime.beginShutdown();
  }
});

it("keeps the original error when a call fails for a reason other than authorization", async () => {
  const snapshot = connectedRemote();
  const { runtime } = createRuntime({
    label: "needs-auth-other-error",
    snapshot,
    servers: { remote: stdioServer() },
    mcpPort: {
      callTool: async () => {
        snapshot.remote = { status: mcpStatus("failed") };
        throw new Error("Connection closed");
      },
    },
  });
  try {
    const entry = await resolveReady(runtime);
    // 恢复耗尽等普通失败返回原始错误，不改写成状态文本。
    await expect(
      entry.handler({}, { abortSignal: new AbortController().signal } as ToolExecutionContext),
    ).rejects.toThrow(/^Connection closed$/);
  } finally {
    runtime.beginShutdown();
  }
});
