import { expect, it, vi } from "vitest";
import type { McpServerToolSnapshot } from "@zcode/contracts";
import { classifyServer } from "../../src/mcp/runtime/session.js";
import type { AgentRuntimeInternal } from "../../src/runtime/internal.js";
import { createRuntime, mcpStatus, stdioServer, tool } from "../mcp-runtime-fixture.js";

it.each([
  ["config disabled", { enabled: false, servers: { local: {} } }, "connected", "disabled"],
  ["server disabled", { servers: { local: { enabled: false } } }, "connected", "disabled"],
  ["status disabled", { servers: { local: {} } }, "disabled", "disabled"],
  ["removed from config", { servers: {} }, "connected", "not_configured"],
  ["no record", { servers: { local: {} } }, undefined, "absent"],
  ["connecting", { servers: { local: {} } }, "connecting", "pending"],
  ["connected", { servers: { local: {} } }, "connected", "connected"],
  ["failed", { servers: { local: {} } }, "failed", "failed"],
  ["no server map", {}, "connected", "connected"],
] as const)("classifies a server: %s", (_label, config, status, expected) => {
  expect(
    classifyServer(
      config as Parameters<typeof classifyServer>[0],
      "local",
      status ? mcpStatus(status) : undefined,
    ),
  ).toBe(expected);
});

it.each([
  ["authorization prompt", { authorization: { type: "oauth_authorization_code" } }],
  ["authorization failure", { failureKind: "oauth_authorization_failed" }],
  ["origin denied", { failureKind: "official_origin_untrusted" }],
] as const)("classifies a failed server with %s", (label, extra) => {
  expect(
    classifyServer(
      { servers: { local: {} } } as Parameters<typeof classifyServer>[0],
      "local",
      mcpStatus("failed", extra as Parameters<typeof mcpStatus>[1]),
    ),
  ).toBe(label === "origin denied" ? "failed" : "needs_auth");
});

it("a child waits only for its scoped servers that are still connecting", async () => {
  const waitForServer = vi.fn(async () => ({ timedOut: false }));
  const snapshot: Record<string, McpServerToolSnapshot> = {
    fast: { status: mcpStatus("connected"), tools: [tool("fast", "ping")], toolsVersion: "1" },
    slow: { status: mcpStatus("connecting") },
  };
  const { runtime } = createRuntime({
    label: "child-wait",
    snapshot,
    servers: { fast: stdioServer(), slow: stdioServer() },
    mcpPort: { waitForServer },
  });
  try {
    void (runtime as unknown as AgentRuntimeInternal).mcpSession!.start();
    // 启动始终未完成：修复前 child 等整个父启动，与自己无关的慢 server 会卡住 child 创建。
    const unscoped = await runtime.createChildMcpAccess();
    expect(unscoped.snapshot?.tools.map((item) => item.toolName)).toEqual(["ping"]);
    expect(waitForServer).not.toHaveBeenCalled();
    await runtime.createChildMcpAccess(["fast", "slow"]);
    expect(waitForServer).toHaveBeenCalledExactlyOnceWith("slow", { timeoutMs: 30_000 });
    waitForServer.mockClear();
    // 等待集合可比借用范围大：tools 引用的 server 也要等，借用范围仍只认 scoped。
    const widened = await runtime.createChildMcpAccess(["fast"], undefined, {
      waitFor: ["fast", "slow"],
    });
    expect(waitForServer).toHaveBeenCalledExactlyOnceWith("slow", { timeoutMs: 30_000 });
    expect(Object.keys(widened.snapshot?.statuses ?? {})).toEqual(["fast"]);
  } finally {
    runtime.beginShutdown();
  }
});
