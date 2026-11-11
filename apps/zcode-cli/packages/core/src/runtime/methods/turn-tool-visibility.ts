import { SEARCH_PLUGINS_TOOL_NAME, SUGGEST_PLUGIN_INSTALL_TOOL_NAME } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  AUTOMATION_MUTATION_TOOL_NAMES,
  AUTOMATION_SELF_PAUSE_TOOL_NAME,
  OFF_PEAK_MUTATION_TOOL_NAMES,
  isAutomationMutationRestrictedTurn,
  isOffPeakCreateRestrictedTurn,
  type RegularTurnLoopState,
} from "./turn-loop-state.js";

export function getTurnTools(runtime: AgentRuntimeInternal, state: RegularTurnLoopState) {
  const disallowed = buildTurnDisallowedTools(state);
  if (state.automationCreateLimitReached) return [];
  const tools = runtime.getTools(state.model);
  return disallowed ? tools.filter((tool) => !disallowed.has(tool.name)) : tools;
}

function buildTurnDisallowedTools(state: RegularTurnLoopState): Set<string> | null {
  const tools = new Set(state.toolDisallowlist ?? []);
  // 同一 runtime 上可交替收到新端与旧端输入；端口存在只表示可执行，不代表本轮可以曝光卡片。
  if (!state.pluginDiscoveryUi) {
    tools.add(SEARCH_PLUGINS_TOOL_NAME);
    tools.add(SUGGEST_PLUGIN_INSTALL_TOOL_NAME);
  }
  if (isAutomationMutationRestrictedTurn(state)) {
    // 修复原因：定时任务执行轮只应运行任务 prompt，不能反过来管理自己的定义。
    // 保留 CronList 供只读查询；所有 mutation 在 provider 请求边界统一隐藏。
    for (const toolName of AUTOMATION_MUTATION_TOOL_NAMES) {
      tools.add(toolName);
    }
  }
  if (!state.automationId?.trim()) {
    // CronPauseSelf 的唯一目标是 Host 准入注入的本轮 automationId；普通用户轮、
    // 只有 denylist / queryId 兜底信号的轮都没有可暂停的任务，必须在 provider 边界隐藏。
    // 不并入 AUTOMATION_MUTATION_TOOL_NAMES：那组是“执行轮隐藏”，这里是“非执行轮隐藏”。
    tools.add(AUTOMATION_SELF_PAUSE_TOOL_NAME);
  }
  if (isOffPeakCreateRestrictedTurn(state)) {
    // D49：闲时执行轮禁止再创建闲时任务（免费池自我放大）；OffPeakList 只读保留。
    // 注意 automation 执行轮不进此分支——cron turn 按 D49-3 放行 OffPeakCreate。
    for (const toolName of OFF_PEAK_MUTATION_TOOL_NAMES) {
      tools.add(toolName);
    }
  }
  return tools.size > 0 ? tools : null;
}
