// MCP App 宿主授权（ToolExecutor.authorizeAppTool）的失败类型。
// 规格：docs/design/v2/tool/00-tool-change-chain.md「MCP App 授权失败的错误类型」。
// mcp/uiCallTool 与 plugins/mentionItems 共用这条授权链；调用方按 CoreError.type 区分「被拒绝」
// 与其他失败，不读错误文本。
import { describe, expect, it, vi } from "vitest";
import { CoreErrorType, type McpPort, type PermissionBrokerResult } from "@zcode/contracts";
import { createMcpToolEntry } from "../src/mcp/index.js";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import { ToolExecutorImpl } from "../src/tool/executor/impl.js";
import { ToolRegistryImpl } from "../src/tool/registry.js";

const descriptor = {
  name: "search",
  serverName: "plugin:gitlab:gitlab",
  toolName: "search",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
    additionalProperties: false,
  },
};

const toolEntry = () =>
  createMcpToolEntry("mcp__plugin_gitlab_gitlab__search", descriptor, {} as McpPort, false);

function createExecutor(input: {
  disallowed?: string[];
  broker?: () => Promise<PermissionBrokerResult>;
}) {
  return new ToolExecutorImpl({
    registry: new ToolRegistryImpl(),
    permissionService: new PermissionService({
      ...defaultPermissionConfig,
      disallowedTools: new Set(input.disallowed ?? []),
    }),
    permissionBroker: { requestPermission: input.broker ?? vi.fn() },
    sessionId: "fixture" as never,
    emitEvent: async () => {},
  });
}

describe("authorizeAppTool failure types", () => {
  it("returns the approved input when the user allows", async () => {
    const tool = toolEntry();
    const executor = createExecutor({ broker: async () => ({ decision: "allow" }) });
    await expect(
      executor.authorizeAppTool(
        { id: "call", name: tool.metadata.name, input: { query: "fix" } },
        tool,
      ),
    ).resolves.toEqual({ query: "fix" });
  });

  it("throws permission_denied when the user denies", async () => {
    const tool = toolEntry();
    const executor = createExecutor({ broker: async () => ({ decision: "deny" }) });
    await expect(
      executor.authorizeAppTool(
        { id: "call", name: tool.metadata.name, input: { query: "fix" } },
        tool,
      ),
    ).rejects.toMatchObject({ type: CoreErrorType.PermissionDenied });
  });

  it("throws permission_denied for a deny rule without asking", async () => {
    const tool = toolEntry();
    const broker = vi.fn();
    const executor = createExecutor({ disallowed: [tool.metadata.name], broker });
    await expect(
      executor.authorizeAppTool(
        { id: "call", name: tool.metadata.name, input: { query: "fix" } },
        tool,
      ),
    ).rejects.toMatchObject({ type: CoreErrorType.PermissionDenied });
    expect(broker).not.toHaveBeenCalled();
  });

  it("throws invalid_input, not a denial, when the input does not match the tool schema", async () => {
    const tool = toolEntry();
    const broker = vi.fn();
    const executor = createExecutor({ broker });
    await expect(
      executor.authorizeAppTool({ id: "call", name: tool.metadata.name, input: {} }, tool),
    ).rejects.toMatchObject({ type: CoreErrorType.InvalidInput });
    expect(broker).not.toHaveBeenCalled();
  });
});
