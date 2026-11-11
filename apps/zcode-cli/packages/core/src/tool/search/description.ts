import {
  TOOL_SEARCH_NAME,
  LOCAL_TOOL_SEARCH_NAME,
  DEFERRED_TOOL_CALL_NAME,
  toolSearchNameForMode,
  type ResolvedToolSearchMode,
} from "@zcode/contracts";
import { isMcpToolName } from "../../mcp/name.js";

function description(opening: string, callingConvention: string, resultNote: string): string {
  return `${opening}

Deferred tools appear by name in <system-reminder> messages. Until fetched, only the name is known — there is no parameter schema, so the tool cannot be invoked. This tool takes a query, matches it against the deferred tool list, and returns the matched tools' complete JSONSchema definitions inside a <functions> block. ${callingConvention}

Result format: each matched tool appears as one <function>{"description": "...", "name": "...", "parameters": {...}}</function> line inside the <functions> block${resultNote}

Query forms:
Regular expressions are not supported. Use space-separated keywords for broad searches, or "select:<name>[,<name>...]" for exact tool names. Characters such as "|" and ".*" are treated literally. For example, use "shell terminal execute command".

- "select:TaskStop,mcp__byob__browser_navigate" — fetch these exact deferred tools by name
- "notebook jupyter" — keyword search, up to max_results best matches
- "+slack send" — require "slack" in the name, rank by remaining terms`;
}

export const NATIVE_TOOL_SEARCH_DESCRIPTION = description(
  "Fetches full schema definitions for deferred tools so they can be called.",
  "Once a tool's schema appears in that result, it is callable exactly like any tool defined at the top of the prompt.",
  " — the same encoding as the tool list at the top of this prompt.",
);

// Local 返回的定义描述目标参数，不能把它误读成已注册的直接调用入口。
// 示例原为 TodoWrite；它转为常驻后经包装调用会被拒绝，示例改用没有注册门控、未废弃的 deferred 工具 TaskStop。
// task_id 写占位符：描述是固定文本，没有真实任务 ID，虚构 ID 会被模型照抄成无效调用。
export const LOCAL_TOOL_SEARCH_DESCRIPTION = `${description(
  "Fetches full schema definitions for deferred tools so they can be called using DeferredToolCall.",
  "Call deferred tools through DeferredToolCall with {name, input}. Call resident tools directly using their normal tool calls, even if their definitions were returned by direct selection.",
  ". For deferred tools, parameters describes the input object passed to DeferredToolCall.",
)}

Example (TaskStop is deferred and already loaded):
<example>
DeferredToolCall({"name":"TaskStop","input":{"task_id":"<task_id returned when the task started>"}})
</example>`;

const ADDED_TOOLS_NOTICE = `The following deferred tools are now available via ${TOOL_SEARCH_NAME}. Their schemas are NOT loaded — calling them directly will fail with InputValidationError. Use ${TOOL_SEARCH_NAME} with query "select:<name>[,<name>...]" to load tool schemas before calling them:`;
const LOCAL_ADDED_TOOLS_NOTICE = `The following deferred tools are available via ${LOCAL_TOOL_SEARCH_NAME}. Use query "select:<name>[,<name>...]" to load their complete schemas, then call them through ${DEFERRED_TOOL_CALL_NAME} with {name, input}. Call resident tools directly:`;
const MAX_REMOVED_NAME_LINES = 30;
const MCP_READDED_REASON =
  "(MCP server reconnected — names announced earlier in this conversation)";
const READDED_REASON = "in this session (announced earlier in this conversation)";
const AMBIENT_CONTEXT_NOTICE =
  "This is ambient context — do not narrate it to the user unless they ask or it is directly relevant to their request.";

// 公告 metadata 是唯一事实源；模式切换只重新渲染文案，不替换用户或工具结果中的任意文本。
// hiddenNames 是 removedNames 中仍在 registry、只因本轮限制隐藏的名称，随公告一起持久化，
// 每次请求按同一份事实渲染出同一段文案。
export function renderToolSearchAnnouncement(
  {
    addedNames,
    removedNames,
    readdedNames,
  }: {
    addedNames: readonly string[];
    removedNames: readonly string[];
    readdedNames: readonly string[];
  },
  mode: ResolvedToolSearchMode,
  hiddenNames: readonly string[] = [],
): string {
  const searchName = toolSearchNameForMode(mode);
  const noSearchNotice = `Do not search for them — ${searchName} will return no match`;
  const readded = new Set(readdedNames);
  const listedNames = addedNames.filter((name) => !readded.has(name));
  const paragraphs: string[] = [];
  if (listedNames.length)
    paragraphs.push(
      `${mode === "local" ? LOCAL_ADDED_TOOLS_NOTICE : ADDED_TOOLS_NOTICE}\n${listedNames.join("\n")}`,
    );
  // MCP 与其他工具分段：MCP 段按 server 汇总并写重连，其他工具逗号列名。
  const readdedMcp = readdedNames.filter(isMcpToolName);
  const readdedOther = readdedNames.filter((name) => !isMcpToolName(name));
  const availableAgain = (count: number, reason: string, names: string) =>
    `${count} deferred tool${count === 1 ? " is" : "s are"} available again ${reason}: ${names}. Load via ${searchName} as before.`;
  if (readdedMcp.length)
    paragraphs.push(
      availableAgain(readdedMcp.length, MCP_READDED_REASON, summarizeToolNames(readdedMcp)),
    );
  if (readdedOther.length)
    paragraphs.push(availableAgain(readdedOther.length, READDED_REASON, readdedOther.join(", ")));
  if (removedNames.length) {
    // 仍在目录中、只因本轮限制隐藏的工具不能说成会话内不可用。
    const hiddenSet = new Set(hiddenNames);
    const hidden = removedNames.filter((name) => hiddenSet.has(name));
    const departed = removedNames.filter((name) => !hiddenSet.has(name));
    // 删除原因按工具区分，非 MCP 工具不能写成 MCP 断连。
    // 断开只按 mcp__ 名称前缀判断，不读取连接状态；名称事实仍完整保留在 metadata。
    const disconnected = departed.filter(isMcpToolName);
    const gone = departed.filter((name) => !isMcpToolName(name));
    if (disconnected.length) {
      paragraphs.push(
        disconnected.length > MAX_REMOVED_NAME_LINES
          ? `${disconnected.length} deferred tools are no longer available (MCP server disconnected): ${summarizeToolNames(disconnected)}. ${noSearchNotice}.`
          : `The following deferred tools are no longer available (their MCP server disconnected). ${noSearchNotice}:\n${disconnected.join("\n")}`,
      );
    }
    if (gone.length) {
      paragraphs.push(
        `The following deferred tools are no longer available in this session. ${noSearchNotice}:\n${gone.join("\n")}`,
      );
    }
    if (hidden.length) {
      // 名称较多时按 server 分组，避免大批删除刷屏。
      paragraphs.push(
        hidden.length > MAX_REMOVED_NAME_LINES
          ? `${hidden.length} deferred tools are no longer available: ${summarizeToolNames(hidden)}. ${noSearchNotice}.`
          : `The following deferred tools are no longer available. ${noSearchNotice}:\n${hidden.join("\n")}`,
      );
    }
    paragraphs.push(AMBIENT_CONTEXT_NOTICE);
  }
  return paragraphs.join("\n\n");
}

function summarizeToolNames(names: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const name of names) {
    const group = isMcpToolName(name) ? `${name.split("__", 2).join("__")}__*` : name;
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => (count > 1 ? `${name} (${count})` : name))
    .join(", ");
}
