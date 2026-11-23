// plugin_reference reminder 的 turn-start 注入。
// 契约：解析 canonical text → 冻结 catalog →
// 与 live Skill/MCP/Subagent inventory 取交集 → 生成本轮 model-only reminder。
// 失败语义：对话 fail open（任何异常都不阻塞本轮），能力注入 fail closed（异常时不注入）。
import { toMcpToolName } from "../../mcp/index.js";
import {
  buildPluginReferenceReminderBody,
  extractPluginReferences,
  type LivePluginMcpServer,
  type LivePluginSkill,
  type LivePluginSubagent,
} from "../../plugin-reference/index.js";
import { systemReminderAttachmentEntry } from "../../agent/message-history.js";
import { commitTurnRequestEntries } from "./turn-output-token-continuation.js";
import type { TurnRequestState } from "./turn-loop-state.js";
import type { McpSessionView } from "../../mcp/runtime/session.js";
import { createMessageId, traceContextToLogContext } from "../deps.js";
import type { TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { currentSkillCatalog } from "./context.js";

function collectLiveMcpServers(
  runtime: AgentRuntimeInternal,
  view: McpSessionView | undefined,
  toolDisallowlist: readonly string[] | undefined,
): LivePluginMcpServer[] {
  if (!view) return [];
  // 与本次工具投影共用普通 step 的快照；引用不另等连接，也不读取首载目录。
  const registeredToolNames = new Set(runtime.getTools().map((tool) => tool.name));
  // 与 turn-loop 的 provider 工具过滤保持完全相同的“完整工具名”语义；
  // 带参数的执行规则不会把整个工具从 provider 工具表移除，不能在 reminder 侧扩大解释。
  const turnDisallowedToolNames = new Set(toolDisallowlist ?? []);
  const providerVisibleToolCounts = new Map<string, number>();
  for (const descriptor of view.tools) {
    // provider-visible = 当前快照里的 tool 先通过 Session 全局 allow/disallow 注册过滤，
    // 再通过本轮 toolDisallowlist。根因：只看 registry 会把“本轮隐藏、全局仍注册”的
    // MCP tool 误算成可见能力，reminder 会声称一个 provider 实际拿不到的 server。
    const toolName = toMcpToolName(descriptor);
    if (!registeredToolNames.has(toolName)) continue;
    if (turnDisallowedToolNames.has(toolName)) continue;
    providerVisibleToolCounts.set(
      descriptor.serverName,
      (providerVisibleToolCounts.get(descriptor.serverName) ?? 0) + 1,
    );
  }
  return Object.entries(view.servers).map(([serverName, { status }]) => ({
    serverName,
    connected: status.status === "connected",
    providerVisibleToolCount: providerVisibleToolCounts.get(serverName) ?? 0,
  }));
}

function collectLivePluginSkills(runtime: AgentRuntimeInternal): LivePluginSkill[] {
  const skills: LivePluginSkill[] = [];
  for (const skill of currentSkillCatalog(runtime)?.skills ?? []) {
    if (skill.source !== "plugin") continue;
    if (!skill.pluginName || !skill.qualifiedName) continue;
    skills.push({
      qualifiedName: skill.qualifiedName,
      pluginName: skill.pluginName,
      rootPath: skill.rootPath,
      source: skill.source,
    });
  }
  return skills;
}

function collectLivePluginSubagents(runtime: AgentRuntimeInternal): LivePluginSubagent[] {
  const subagents: LivePluginSubagent[] = [];
  for (const profile of runtime.getAgentDefinitions().activeAgents) {
    const name = profile.name.trim();
    const path = profile.path?.trim();
    // Plugin profile 由 bootstrap 从 Markdown 成功解析后才进入 config，且一定携带 path。
    // 无 path 的内置/inline profile 无法做 provenance 回溯，按 fail closed 跳过。
    if (!name || !path) continue;
    subagents.push({ name, path });
  }
  return subagents;
}

export async function injectPluginReferenceReminderFromTurn(
  this: AgentRuntimeInternal,
  userInput: string,
  traceContext: TraceContext,
  requestState: TurnRequestState,
  mcpView: McpSessionView | undefined,
  toolDisallowlist?: readonly string[],
): Promise<void> {
  // 无引用是绝对主路径：不 touch MCP/skills，零开销返回。
  const extraction = extractPluginReferences(userInput);
  if (extraction.references.length === 0) {
    if (extraction.invalidCount > 0) {
      this.logger?.debug("Plugin reference parse rejected invalid destinations", {
        ...traceContextToLogContext(traceContext),
        event: "plugin_reference.parse.invalid",
        invalidCount: extraction.invalidCount,
        module: "core.runtime",
      });
    }
    return;
  }

  const startedAt = Date.now();
  try {
    const liveMcpServers = collectLiveMcpServers(this, mcpView, toolDisallowlist);
    const liveSkills = collectLivePluginSkills(this);
    const liveSubagents = collectLivePluginSubagents(this);
    const result = buildPluginReferenceReminderBody({
      references: extraction.references,
      catalog: this.config.pluginReferenceCatalog,
      liveSkills,
      liveMcpServers,
      liveSubagents,
    });
    // 每轮与消息流同数量级 → 必须 debug（生产 no-op），只输出受控标识与计数。
    this.logger?.debug("Plugin reference reminder resolved", {
      ...traceContextToLogContext(traceContext),
      durationMs: Date.now() - startedAt,
      event: "plugin_reference.reminder.resolved",
      invalidCount: extraction.invalidCount,
      mcpServerCount: result.diagnostics.mcpServerCount,
      module: "core.runtime",
      referenceCount: extraction.references.length,
      resolvedPluginIds: result.diagnostics.resolvedPluginIds,
      skillCount: result.diagnostics.skillCount,
      subagentCount: result.diagnostics.subagentCount,
      skipped: result.diagnostics.skipped,
      truncated: result.diagnostics.truncated || extraction.truncatedCount > 0,
    });
    if (!result.body) return;
    commitTurnRequestEntries(this, requestState, [
      systemReminderAttachmentEntry("plugin_reference", result.body),
    ]);
    // 根因：只写 runtime attachment 会让热会话保留 reminder、cold resume 却丢失，
    // 历史消息序列因此错位并破坏 provider 前缀缓存。先注入再以 model-only notice
    // 原文落库，通用 hydration 会按同一 source 重建 attachment，UI 不产生用户气泡。
    await this.persistSyntheticUserNoticeForSession({
      messageID: createMessageId(),
      sessionId: this.sessionId,
      source: "plugin_reference",
      text: result.body,
      traceContext,
    });
  } catch (error) {
    // 对话 fail open：reminder 生成失败不影响本轮发送；能力注入 fail closed：不写任何兜底内容。
    this.logger?.debug("Plugin reference reminder generation failed", {
      ...traceContextToLogContext(traceContext),
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      event: "plugin_reference.reminder.failed",
      module: "core.runtime",
      referenceCount: extraction.references.length,
    });
  }
}
