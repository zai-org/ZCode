import { renderMcpSearchMiss } from "../search/mcp-diagnostics.js";
import { NATIVE_TOOL_SEARCH_DESCRIPTION } from "../search/description.js";
import {
  TOOL_SEARCH_NAME,
  LOCAL_TOOL_SEARCH_NAME,
  ToolSearchInputJsonSchema,
  ToolSearchInputSchema,
  ToolSearchOutputJsonSchema,
  ToolSearchOutputSchema,
} from "@zcode/contracts";
import type { ToolEntry } from "../types.js";
import { toModelVisibleMcpNamePart } from "../../mcp/name.js";
import { searchTools } from "../search/search.js";

const MAX_SEARCH_RESULT_BYTES = 100_000;
const SEARCH_TIMEOUT_MS = 10_000;
const NO_MATCHING_TOOLS_MESSAGE =
  "No matching deferred tools found. Loaded tools are not searchable here and need no loading. Check your loaded tool list and query; try corrected spelling, alternative names, or broader keywords before concluding a tool is missing.";
const MCP_SEARCH_WAIT_MS = 5_000;

export const toolSearchToolEntry: ToolEntry = {
  capability: "Search available tools and load their definitions",
  aliases: [LOCAL_TOOL_SEARCH_NAME],
  metadata: {
    name: TOOL_SEARCH_NAME,
    // 模型侧说明使用固定文案；schema 展开由 provider 处理，客户端仍只返回真实引用。
    description: NATIVE_TOOL_SEARCH_DESCRIPTION,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: SEARCH_TIMEOUT_MS,
    maxOutputBytes: MAX_SEARCH_RESULT_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  inputSchema: ToolSearchInputJsonSchema,
  outputSchema: ToolSearchOutputJsonSchema,
  runtimeInputSchema: ToolSearchInputSchema,
  runtimeOutputSchema: ToolSearchOutputSchema,
  handler: async (input, context) => {
    context.abortSignal?.throwIfAborted();
    if (!context.toolSearch?.enabled)
      throw new Error("ToolSearch is not enabled for this request.");
    const { query, max_results } = ToolSearchInputSchema.parse(input);
    const search = context.toolSearch;
    const read = () =>
      search.readLatest?.() ?? { catalog: search.catalog, pending: [], failed: [] };
    let view = read();
    let matches = searchTools(query, view.catalog, max_results);
    const selected = /^select:/i.test(query)
      ? query
          .slice(7)
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean)
      : [];
    const missing = selected.filter(
      (name) => searchTools(`select:${name}`, view.catalog).length === 0,
    );
    if (matches.length === 0 || missing.length > 0) {
      view = read();
      const target = missing.length ? missing.join(" ") : query;
      const explicit = [
        ...target.matchAll(/mcp__([a-zA-Z0-9._-]+?)(?:__|(?=[^a-zA-Z0-9._-]|$))/g),
      ].map((match) => match[1]!);
      const known = [
        ...view.pending,
        ...view.failed.map((server) => server.name),
        ...view.catalog.flatMap((tool) => (tool.mcp ? [tool.mcp.serverName] : [])),
      ];
      for (const name of known) {
        // 服务名必须完整匹配，git 不能把 digital 误判成只搜索 git。
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (new RegExp(`\\b${escaped}\\b`, "i").test(target)) explicit.push(name);
      }
      const pending = view.pending.filter(
        (name) =>
          explicit.length === 0 ||
          explicit.includes(name) ||
          explicit.includes(toModelVisibleMcpNamePart(name)),
      );
      const unresolved = selected.length
        ? selected.some((name) => searchTools(`select:${name}`, view.catalog).length === 0)
        : searchTools(query, view.catalog, max_results).length === 0;
      if (unresolved && pending.length) {
        await search.waitForPending?.(pending, MCP_SEARCH_WAIT_MS, context.abortSignal);
        context.abortSignal?.throwIfAborted();
        view = read();
      }
      matches = searchTools(query, view.catalog, max_results);
    }
    return {
      query,
      matches,
      total_deferred_tools: view.catalog.filter((tool) => tool.deferred).length,
      ...(matches.length === 0 && view.pending.length
        ? { pending_mcp_servers: [...view.pending] }
        : {}),
      ...(matches.length === 0 && view.failed.length ? { failed_mcp_servers: view.failed } : {}),
    };
  },
  formatModelContent: (output) => {
    const {
      matches,
      pending_mcp_servers: pending = [],
      failed_mcp_servers: failed = [],
    } = ToolSearchOutputSchema.parse(output);
    if (matches.length)
      return matches.map((toolName) => ({ type: "tool_reference" as const, toolName }));
    // 没有 MCP server 在连接或失败时用通用未命中提示；有时改用带 MCP 诊断的文案。
    return pending.length || failed.length
      ? renderMcpSearchMiss({ pending, failed })
      : NO_MATCHING_TOOLS_MESSAGE;
  },
  permission: {
    permission: "tool.search",
    reason: "Search the current allowed tool catalog",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_SEARCH_RESULT_BYTES,
    maxModelBytes: MAX_SEARCH_RESULT_BYTES,
    strategy: "truncate",
    preview: { maxBytes: MAX_SEARCH_RESULT_BYTES, direction: "head" },
  },
  timeout: { defaultMs: SEARCH_TIMEOUT_MS, maxMs: SEARCH_TIMEOUT_MS, allowCallOverride: false },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "ToolSearch was cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
