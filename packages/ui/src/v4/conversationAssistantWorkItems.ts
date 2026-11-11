import { isSessionToolName } from "@/ToolCallBlocks/session/contract.js";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import * as workflowToolNames from "@/lib/workflowToolNames.js";
import { isZCodeCuaToolName } from "@/lib/cuaPermissionAction.js";
import { joinFilePath } from "@/lib/path.js";
import { readRawToolCallFileSummaries } from "@/ToolCallBlocks/fileSummaries.js";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";
import type { ConversationRow, SubagentRow, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { isShellToolCallAwaitingCommand } from "@/lib/exploreToolCall.js";
import {
  isConversationReasoningRowVisible,
  type ConversationReasoningVisibility,
} from "@/v4/conversationRowContext.js";
import type { AssistantWorkRow } from "@/v4/conversationTurnRenderUnits.js";
import { toolCallRowToLegacyNode } from "@/v4/toolCallRowAdapter.js";

export type ConversationAssistantWorkRenderItem =
  | { kind: "row"; key: string; row: AssistantWorkRow }
  | { kind: "agentToolCall"; key: string; row: ToolCallRow; subagentRow: SubagentRow };

const SUBAGENT_TOOL_NAMES = new Set(["Agent", "Task", "subagent"]);
const isToolCallRow = (row: AssistantWorkRow): row is ToolCallRow => row.kind === "toolCall";
const isAgentToolCallRow = (row: AssistantWorkRow): row is ToolCallRow =>
  isToolCallRow(row) && SUBAGENT_TOOL_NAMES.has(row.toolName);

function shouldDeferUnclassifiedShellToolCall(row: AssistantWorkRow): boolean {
  if (!isToolCallRow(row) || (row.status !== "inputStreaming" && row.status !== "running")) {
    return false;
  }
  const legacyNode = toolCallRowToLegacyNode(row);
  return isShellToolCallAwaitingCommand({
    kind: legacyNode.toolCall.kind,
    input: legacyNode.toolCall.input,
  });
}

/**
 * Agent 工具行 ↔ subagent 行必须按 parentToolCallId 精确配对。
 *
 * 同一轮并发 Agent 工具的 tool call 行按模型输出顺序出现，但 SubagentSpawned
 * 事件按异步调度顺序到达；旧 FIFO 会把一个 Agent 的标题与另一个 childSessionId 拼在一起。
 * 仅对缺少新字段的历史数据保留“同 turn 唯一剩余一对”的无歧义兼容。
 */
function pairSubagentRows(rows: readonly AssistantWorkRow[]): {
  subagentByAgentToolRowId: Map<number, SubagentRow>;
  claimedSubagentRowIds: Set<number>;
} {
  const subagentByAgentToolRowId = new Map<number, SubagentRow>();
  const claimedSubagentRowIds = new Set<number>();
  const agentToolByTurnAndCallId = new Map<string, ToolCallRow>();
  const agentToolRows: ToolCallRow[] = [];
  const subagentRows: SubagentRow[] = [];
  const legacySubagentRows: SubagentRow[] = [];

  for (const row of rows) {
    if (isAgentToolCallRow(row)) {
      agentToolRows.push(row);
      agentToolByTurnAndCallId.set(`${row.turnId}\0${row.toolCallId}`, row);
    } else if (row.kind === "subagent") {
      subagentRows.push(row);
    }
  }
  for (const row of subagentRows) {
    if (!row.parentToolCallId) {
      legacySubagentRows.push(row);
      continue;
    }
    const host = agentToolByTurnAndCallId.get(`${row.turnId}\0${row.parentToolCallId}`);
    if (host && host.turnId === row.turnId && !subagentByAgentToolRowId.has(host.rowId)) {
      subagentByAgentToolRowId.set(host.rowId, row);
      claimedSubagentRowIds.add(row.rowId);
    }
  }

  const remainingAgentToolsByTurn = new Map<string, ToolCallRow[]>();
  for (const row of agentToolRows) {
    if (subagentByAgentToolRowId.has(row.rowId)) continue;
    const turnRows = remainingAgentToolsByTurn.get(row.turnId);
    if (turnRows) {
      turnRows.push(row);
    } else {
      remainingAgentToolsByTurn.set(row.turnId, [row]);
    }
  }
  const legacySubagentsByTurn = new Map<string, SubagentRow[]>();
  for (const row of legacySubagentRows) {
    const turnRows = legacySubagentsByTurn.get(row.turnId);
    if (turnRows) {
      turnRows.push(row);
    } else {
      legacySubagentsByTurn.set(row.turnId, [row]);
    }
  }
  for (const [turnId, subagentRows] of legacySubagentsByTurn) {
    const toolRows = remainingAgentToolsByTurn.get(turnId);
    if (toolRows?.length !== 1 || subagentRows.length !== 1) continue;
    const host = toolRows[0];
    const subagent = subagentRows[0];
    if (!host || !subagent) continue;
    subagentByAgentToolRowId.set(host.rowId, subagent);
    claimedSubagentRowIds.add(subagent.rowId);
  }

  return { subagentByAgentToolRowId, claimedSubagentRowIds };
}

export function buildAssistantWorkRenderItems(
  rows: readonly AssistantWorkRow[],
  reasoningVisibility: ConversationReasoningVisibility & { messageStreamShowTodos?: boolean },
): ConversationAssistantWorkRenderItem[] {
  const visibleRows = rows.filter(
    (row) =>
      (row.kind !== "reasoning" ||
        ((row.state !== "streaming" || row.text.length > 0) &&
          isConversationReasoningRowVisible(row.rowId, reasoningVisibility))) &&
      (row.kind !== "toolCall" ||
        reasoningVisibility.messageStreamShowTodos === true ||
        resolveToolCallIdentity(toolCallRowToLegacyNode(row).toolCall).family !== "todo") &&
      !shouldDeferUnclassifiedShellToolCall(row),
  );
  const { subagentByAgentToolRowId, claimedSubagentRowIds } = pairSubagentRows(visibleRows);
  const items: ConversationAssistantWorkRenderItem[] = [];
  for (const row of visibleRows) {
    if (row.kind === "subagent" && claimedSubagentRowIds.has(row.rowId)) continue;
    const subagentRow = isToolCallRow(row) ? subagentByAgentToolRowId.get(row.rowId) : undefined;
    if (isToolCallRow(row) && subagentRow) {
      items.push({ kind: "agentToolCall", key: `agent:${row.rowId}`, row, subagentRow });
    } else {
      items.push({ kind: "row", key: `row:${row.rowId}`, row });
    }
  }
  return items;
}

export function getAssistantSummaryToolCategory(
  row: AssistantWorkRow,
): "explore" | "run" | "change" | "session" | null {
  if (row.kind !== "toolCall" || row.status === "pendingApproval") return null;
  const tool = toolCallRowToLegacyNode(row).toolCall;
  // 复用专用 renderer 的名字判定，避免 snake_case workflow 被通用 list/search 归类吞掉。
  if (Object.values(workflowToolNames).some((matches) => matches(tool))) return null;
  // 会话工具保留独立类别以维持代表图标优先级，统计时按调用次数合入执行数量。
  if (isSessionToolName(tool.toolName ?? tool.kind)) return "session";
  const family = resolveToolCallIdentity(tool).family;
  if (["file-read", "search", "web-fetch", "explore"].includes(family)) return "explore";
  if (
    family === "shell" ||
    family === "node-repl" ||
    [tool.toolName, tool.kind].some(isZCodeCuaToolName)
  )
    return "run";
  if (family === "file-write") return "change";
  return null;
}

/** 正文、Workflow、Subagent 与未归类工具是边界；不重新拼接真实工具关系。 */
export function groupConsecutiveAssistantSummaries(
  items: readonly ConversationAssistantWorkRenderItem[],
) {
  const groups: { key: string; items: ConversationAssistantWorkRenderItem[] }[] = [];
  let current: (typeof groups)[number] | undefined;
  for (const item of items) {
    const summary =
      item.kind !== "agentToolCall" &&
      (item.row.kind === "reasoning" || getAssistantSummaryToolCategory(item.row) !== null);
    if (!summary) {
      groups.push({ key: item.key, items: [item] });
      current = undefined;
      continue;
    }
    if (!current) {
      current = { key: item.key, items: [] };
      groups.push(current);
    }
    current.items.push(item);
  }
  return groups;
}

// 工具行不可变；过去只缓存路径，文件列表仍在每次渲染重建 diff。两处共用完整摘要缓存。
const fileSummariesByRow = new WeakMap<
  ToolCallRow,
  ReturnType<typeof readRawToolCallFileSummaries>
>();
function fileSummaries(row: ToolCallRow) {
  const cached = fileSummariesByRow.get(row);
  if (cached) return cached;
  const tool = toolCallRowToLegacyNode(row).toolCall;
  const summaries = readRawToolCallFileSummaries(tool.raw, tool);
  fileSummariesByRow.set(row, summaries);
  return summaries;
}
function changedPaths(row: ToolCallRow): readonly string[] {
  // filePath 是目录展示字段；计数使用包含文件名的原始完整 path。
  return fileSummaries(row)
    .map((file) => file.path)
    .filter(Boolean);
}

// 路径别名曾被当作不同文件；计数和列表必须共用词法去重键，不依赖宿主文件系统。
function summaryFilePath(path: string, workspacePath?: string): string {
  const joined = (workspacePath ? joinFilePath(workspacePath, path) : path).replace(/\\/g, "/");
  const root = joined.startsWith("//")
    ? (joined.match(/^\/\/[^/]+\/[^/]+/)?.[0] ?? "//")
    : (joined.match(/^[A-Za-z]:\//)?.[0] ?? (joined.startsWith("/") ? "/" : ""));
  const parts: string[] = [];
  for (const part of joined.slice(root.length).split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && parts.length && parts.at(-1) !== "..") parts.pop();
    else if (part !== ".." || !root) parts.push(part);
  }
  return root + (root && !root.endsWith("/") && parts.length ? "/" : "") + parts.join("/");
}

export function formatAssistantSummaryStatistics(
  items: readonly ConversationAssistantWorkRenderItem[],
  intl: IntlInstance,
  workspacePath?: string,
  completed = false,
): string {
  let explore = 0,
    run = 0,
    unresolved = 0;
  const files = new Set<string>();
  for (const item of items) {
    const category =
      item.kind === "agentToolCall" ? null : getAssistantSummaryToolCategory(item.row);
    if (category === "explore") explore++;
    // 统计工具调用，不统计返回的目标数；同一会话的多次操作也分别计数。
    if (category === "run" || category === "session") run++;
    if (category === "change" && item.row.kind === "toolCall") {
      const paths = changedPaths(item.row);
      if (!paths.length) unresolved++;
      for (const path of paths) files.add(summaryFilePath(path, workspacePath));
    }
  }
  const parts = (
    [
      ["explore", explore],
      ["run", run],
      ["change", files.size],
      ["unresolved", unresolved],
    ] as const
  )
    .filter(([, count]) => count > 0)
    .map(([category, count]) =>
      // 项目 intl 只替换占位符，不解析 ICU；复用 one/other 键，避免把模板原文显示给用户。
      intl.formatMessage(
        {
          id: `chat.summaryGroup.${category}.${completed ? "completed." : ""}${count === 1 ? "one" : "other"}`,
        },
        { count },
      ),
    );
  return (
    parts.join(intl.formatMessage({ id: "chat.summaryGroup.separator" })) ||
    intl.formatMessage({ id: "chat.summaryGroup.reasoning" })
  );
}

/** 整轮可见尾项决定可追加的组；不能把 history/正文的展示拆分当成独立生命周期。 */
export function getAssistantSummaryTailRowId(
  rows: readonly ConversationRow[],
  visibility: ConversationReasoningVisibility & { messageStreamShowTodos?: boolean },
): number | undefined {
  if (rows.at(-1)?.kind === "userInput") return undefined;
  const workRows = rows.filter(
    (row): row is AssistantWorkRow => row.kind !== "turnHeader" && row.kind !== "userInput",
  );
  return buildAssistantWorkRenderItems(workRows, visibility).at(-1)?.row.rowId;
}

/** 活动摘要与结构闭合分别派生，不能把暂时没有活动项误判为闭合。 */
export function getActiveAssistantSummaryItem(
  items: readonly ConversationAssistantWorkRenderItem[],
) {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!;
    const row = item.row;
    if (
      row.kind === "reasoning"
        ? row.state === "streaming"
        : row.kind === "toolCall" && (row.status === "inputStreaming" || row.status === "running")
    )
      return item;
  }
  return undefined;
}

/** 只为统计选择代表图标，不改变工具顺序或活动摘要的图标。 */
export function getAssistantSummaryIconItem(items: readonly ConversationAssistantWorkRenderItem[]) {
  let selected: ConversationAssistantWorkRenderItem | undefined;
  let selectedPriority = Infinity;
  for (const item of items) {
    const category = getAssistantSummaryToolCategory(item.row);
    if (!category || item.row.kind !== "toolCall") continue;
    const tool = toolCallRowToLegacyNode(item.row).toolCall;
    const priority = [tool.toolName, tool.kind].some(isZCodeCuaToolName)
      ? 0
      : resolveToolCallIdentity(tool).family === "node-repl"
        ? 1
        : category === "change"
          ? 2
          : category === "run"
            ? 3
            : 4;
    if (priority < selectedPriority) {
      selected = item;
      selectedPriority = priority;
    }
  }
  return selected;
}

/** 仅 Change 的计数可展示文件；思考不计数，混合工具保留原统计。 */
export function getAssistantSummaryChangeFiles(
  items: readonly ConversationAssistantWorkRenderItem[],
  workspacePath?: string,
) {
  const files = new Map<string, ReturnType<typeof readRawToolCallFileSummaries>[number]>();
  let unresolved = 0;
  for (const item of items) {
    const category = getAssistantSummaryToolCategory(item.row);
    if (category && category !== "change") return undefined;
    if (category !== "change" || item.row.kind !== "toolCall") continue;
    const summaries = fileSummaries(item.row);
    if (!summaries.length) unresolved++;
    for (const file of summaries) {
      const path = summaryFilePath(file.path, workspacePath);
      if (!files.has(path)) files.set(path, { ...file, path });
    }
  }
  return files.size ? { files: [...files.values()], unresolved } : undefined;
}
