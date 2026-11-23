import type { ModelToolContract } from "../deps.js";
import { registerBuiltInTools } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { resolveEmbeddedSearchBranchCapability } from "../../embedded-search/capability.js";
import {
  resolveBuiltInToolAllowlist,
  resolveRuntimeAgentAlwaysBackground,
  resolveRuntimeDisallowedTools,
  resolveRuntimeDynamicWorkflowToolsIncluded,
} from "../helpers/tool-allowlist.js";
import { isToolNameDisallowed } from "../../tool/tool-visibility.js";

export function resolveRuntimeEmbeddedSearchEnabled(runtime: AgentRuntimeInternal): boolean {
  const builtInToolAllowlist = resolveBuiltInToolAllowlist(runtime.config);
  const decision = resolveEmbeddedSearchBranchCapability({
    // bashAvailable 的含义是「Bash 最终会被注册」，所以要和注册时用同一份 resolved 名单。
    // 现在的结构性禁用里没有 Bash，这里的结果不变；用同一个 helper 是为了以后名单变化时两边不漂移。
    bashAvailable:
      (builtInToolAllowlist === undefined || builtInToolAllowlist.includes("Bash")) &&
      !isToolNameDisallowed("Bash", resolveRuntimeDisallowedTools(runtime.config)),
  });
  return decision.useEmbeddedSearchBranch;
}

export function refreshBranchAwareBuiltInTools(runtime: AgentRuntimeInternal): void {
  const embeddedSearchEnabled = resolveRuntimeEmbeddedSearchEnabled(runtime);
  if (embeddedSearchEnabled) {
    runtime.registry.unregister("Glob");
    runtime.registry.unregister("Grep");
  }

  registerBuiltInTools(runtime.registry, {
    bashTimeoutPolicy: runtime.config.bashTimeoutPolicy,
    includeSkill: Boolean(runtime.skillPort),
    includeAgent: Boolean(runtime.subagentPort),
    embeddedSearchEnabled,
    // 本函数是**第二个**
    // 注册入口，且刻意只传一个精简选项集。对「只有 true 才注册」的门（OffPeak / Cron / Workflow…）
    // 省略是安全的；但动态工作流灰度门的极性相反——「缺席即开启」，省略等于把首次装配剃掉的
    // 十个工具在 shell 初始化时原样加回来（registry.register 会覆盖同名项，
    // silentDuplicateWarnings 还把告警吞掉，所以全程无声）。推导因此必须与 runtime-tools.ts
    // 共用同一个 helper，不能在这里重写一遍判断。
    includeDynamicWorkflow: resolveRuntimeDynamicWorkflowToolsIncluded(runtime),
    // Agent 后台开关同样「缺席即开启」，省略会在刷新时把关闭开关的 Agent 换回总在后台的形态。
    agentAlwaysBackground: resolveRuntimeAgentAlwaysBackground(runtime.config),
    // 会话工具同名两种实现，刷新必须沿用首次装配选定的运行位置，不能回落到另一种。
    sessionControlKind: runtime.sessionControlKind,
    allowedTools: resolveBuiltInToolAllowlist(runtime.config),
    // 与灰度门同理：结构性禁用（按 taskType 推导）必须和首次装配共用 resolveRuntimeDisallowedTools。
    // 曾经这里只传了用户配置的 toolDisallowlist，于是 shell 初始化或按需激活之后，子 runtime 在
    // 会话中途把首次装配剃掉的工作流工具加了回来（Z-011）。
    disallowedTools: resolveRuntimeDisallowedTools(runtime.config),
    silentDuplicateWarnings: true,
  });
  runtime.invalidateToolCache();
}

export function filterEmbeddedSearchRuntimeVisibleTools(
  runtime: AgentRuntimeInternal,
  tools: ModelToolContract[],
): ModelToolContract[] {
  if (!resolveRuntimeEmbeddedSearchEnabled(runtime)) return tools;
  return tools.filter((tool) => tool.name !== "Glob" && tool.name !== "Grep");
}
