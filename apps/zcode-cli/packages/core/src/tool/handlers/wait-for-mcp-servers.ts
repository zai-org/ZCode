// ============================================================
// WaitForMcpServers Tool Handler
// ============================================================
// ToolSearch 关闭时没有连接中公告；模型用本工具等待仍在连接的 MCP server。等待与分类由
// runtime 注入的 McpServerWaitPort 完成（只读会话视图、不发起连接或授权），本 handler 只做投影。
// 描述与结果文本是固定字节，规则见 docs/mcp-async-tool-catalog-cache.md「ToolSearch 关闭时」。

import {
  WAIT_FOR_MCP_SERVERS_TOOL_NAME,
  WaitForMcpServersInputJsonSchema,
  WaitForMcpServersInputSchema,
  WaitForMcpServersOutputJsonSchema,
  WaitForMcpServersOutputSchema,
  type ModelMessageContent,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler, ToolHandlerFailure } from "../types.js";

/** 端口最多等 5 秒；留出分类与投影的余量。 */
const WAIT_FOR_MCP_SERVERS_TIMEOUT_MS = 15_000;
const WAIT_FOR_MCP_SERVERS_MODEL_BYTES = 10_000;
/** 业务失败码；从 41 起编，避开其他工具已用的区间。 */
const WAIT_FOR_MCP_SERVERS_UNAVAILABLE_ERROR_CODE = 41;

export const WAIT_FOR_MCP_SERVERS_DESCRIPTION = [
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

/** 每组一行，空组省略；顺序固定。 */
const RESULT_GROUPS = [
  ["connected", "Connected (their tools are now available — call them directly)"],
  ["failed", "Failed to connect"],
  ["stillPending", "Still connecting (try again or proceed without)"],
  ["needsAuth", "Needs authentication (ask the user to authorize them in the ZCode MCP settings)"],
  ["disabled", "Disabled (ask the user to enable them in the ZCode MCP settings)"],
  ["unknown", "Unknown (no MCP server with this name is configured)"],
] as const;

const waitForMcpServersHandler: ToolHandler = async (input, context) => {
  const { servers } = WaitForMcpServersInputSchema.parse(input);
  if (!context.mcpServerWaitPort) {
    return {
      result: false,
      errorCode: WAIT_FOR_MCP_SERVERS_UNAVAILABLE_ERROR_CODE,
      message: "mcp_server_wait_unavailable: this session has no MCP servers to wait for.",
    } satisfies ToolHandlerFailure;
  }
  return context.mcpServerWaitPort.waitForServers(servers, context.abortSignal);
};

function formatWaitForMcpServersModelContent(output: unknown): ModelMessageContent {
  const parsed = WaitForMcpServersOutputSchema.safeParse(output);
  if (!parsed.success) return "WaitForMcpServers returned an invalid result.";
  const result = parsed.data;
  return [
    `ready: ${result.ready}`,
    ...RESULT_GROUPS.flatMap(([key, label]) =>
      result[key].length ? [`${label}: ${result[key].join(", ")}`] : [],
    ),
  ].join("\n");
}

export const waitForMcpServersToolEntry: ToolEntry = {
  capability: "Wait for MCP servers that are still connecting",
  metadata: {
    // 常驻：只在 ToolSearch 关闭时出现，延迟加载没有搜索入口。
    shouldDefer: false,
    name: WAIT_FOR_MCP_SERVERS_TOOL_NAME,
    description: WAIT_FOR_MCP_SERVERS_DESCRIPTION,
    readOnly: true,
    destructive: false,
    // 不可并发：不在流式阶段提前执行，等待结果按回复顺序结算。
    concurrentSafe: false,
    timeoutMs: WAIT_FOR_MCP_SERVERS_TIMEOUT_MS,
    maxOutputBytes: WAIT_FOR_MCP_SERVERS_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: waitForMcpServersHandler,
  inputSchema: WaitForMcpServersInputJsonSchema,
  outputSchema: WaitForMcpServersOutputJsonSchema,
  runtimeInputSchema: WaitForMcpServersInputSchema,
  runtimeOutputSchema: WaitForMcpServersOutputSchema,
  formatModelContent: formatWaitForMcpServersModelContent,
  permission: {
    permission: "waitForMcpServers",
    reason: "WaitForMcpServers only waits for configured MCP servers that are already connecting",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: WAIT_FOR_MCP_SERVERS_MODEL_BYTES,
    maxModelBytes: WAIT_FOR_MCP_SERVERS_MODEL_BYTES,
    strategy: "truncate",
    preview: { maxBytes: WAIT_FOR_MCP_SERVERS_MODEL_BYTES, direction: "head" },
  },
  timeout: {
    kind: "timed",
    defaultMs: WAIT_FOR_MCP_SERVERS_TIMEOUT_MS,
    maxMs: WAIT_FOR_MCP_SERVERS_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "Stopped waiting for MCP servers; their connections continue",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
