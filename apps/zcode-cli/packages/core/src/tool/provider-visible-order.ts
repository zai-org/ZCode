import { isMcpToolName } from "../mcp/name.js";

const SORTED_PROVIDER_TOOL_NAMES = new Set([
  "Agent",
  "AskUserQuestion",
  "Bash",
  "CronCreate",
  "CronDelete",
  "CronList",
  "CronUpdate",
  "Edit",
  "EnterPlanMode",
  "EnterWorktree",
  "ExitPlanMode",
  "ExitWorktree",
  "Glob",
  "Grep",
  "LSP",
  "NotebookEdit",
  "Read",
  "ScheduleWakeup",
  "SendMessage",
  "Skill",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskOutput",
  "TaskStop",
  "TaskUpdate",
  "TodoRead",
  "TodoWrite",
  "ToolSearch",
  "WaitForMcpServers",
  "WebFetch",
  "WebSearch",
  "Workflow",
  "Write",
]);

// 名单内的工具按名字排序，名单外的工具按注册顺序在其后；
// MCP 工具按名字排序放在最后，顺序与 server 连接顺序无关。
export function orderProviderVisibleToolContracts<T extends { name: string }>(
  tools: readonly T[],
): T[] {
  const referenceTools: T[] = [];
  const localTools: T[] = [];
  const mcpTools: T[] = [];
  for (const tool of tools) {
    if (SORTED_PROVIDER_TOOL_NAMES.has(tool.name)) {
      referenceTools.push(tool);
    } else if (isMcpToolName(tool.name)) {
      mcpTools.push(tool);
    } else {
      localTools.push(tool);
    }
  }

  return [...referenceTools.sort(byName), ...localTools, ...mcpTools.sort(byName)];
}

// 修复原因：不带 locale 的 localeCompare 跟随进程语言设置（如 da-DK 把 "aa" 排在 "z" 之后），
// 同一会话换语言设置恢复时 tools 段字节变化、缓存失效。固定 en-US，与原来常见环境下的顺序相同。
const TOOL_NAME_SORT_LOCALE = "en-US";

function byName(left: { name: string }, right: { name: string }): number {
  return left.name.localeCompare(right.name, TOOL_NAME_SORT_LOCALE);
}
