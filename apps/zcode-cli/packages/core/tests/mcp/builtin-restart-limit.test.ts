import { expect, it } from "vitest";
// 内建 server 超过自动重启上限：adapter 保留的目录仍在视图里，下一次执行准入重连。
import type { McpServerToolSnapshot } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../../src/runtime/internal.js";
import { createRuntime, mcpStatus, stdioServer, tool } from "../mcp-runtime-fixture.js";

function readTools(snapshot: Record<string, McpServerToolSnapshot>): string[] {
  const { runtime } = createRuntime({
    label: "builtin-restart-limit",
    snapshot,
    servers: { node_repl: stdioServer() },
  });
  try {
    return (runtime as unknown as AgentRuntimeInternal)
      .mcpSession!.read()
      .tools.map((item) => item.toolName);
  } finally {
    runtime.beginShutdown();
  }
}

it("keeps the catalog the adapter retained after an unexpected disconnect", () => {
  // 修复前视图只列 connected/connecting 与 needs-auth 的工具：超过重启上限后工具离开视图，
  // 模型不再调用，执行准入的重连也就到不了。
  expect(
    readTools({
      node_repl: {
        status: mcpStatus("failed", { failureKind: "unexpected_disconnect" }),
        tools: [tool("node_repl", "js")],
        toolsVersion: "1",
      },
    }),
  ).toEqual(["js"]);
});

it("does not list stale tools of an explicitly disconnected server", () => {
  expect(
    readTools({
      node_repl: { status: mcpStatus("disconnected"), tools: [tool("node_repl", "js")] },
    }),
  ).toEqual([]);
});
