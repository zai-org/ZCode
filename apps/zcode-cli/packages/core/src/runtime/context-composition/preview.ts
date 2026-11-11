// 草稿预演：按所查模型模拟「下一个请求」，在 entries 的副本上走一遍请求准备，再用同一分类函数出数。
// 规格：apps/zcode-cli/docs/design/v2/model/context-composition.md §3.5。
//
// 不做：persistAnnouncements（会落库，并让 deferred 草稿升为 immediate 持久化）、写历史、发请求、跑 hooks、
// 环境与 Git 的 IO 探测、会消费一次性状态的提醒（Memory 更新、计划退出、silent turn、todo）。
import { countContextPrefixMessages } from "../deps.js";
import type { ContextBuildResult, Model, ModelToolContract, TraceContext } from "../deps.js";
import { buildContextHistoryEntries } from "../methods/context-history-entries.js";
import {
  systemReminderAttachmentEntry,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";
import { buildToolSearchAnnouncement } from "../../tool/search/exposure.js";
import { collectRuntimeAgentListing } from "../helpers/agent-listing.js";
import {
  buildRuntimeModeReminderBody,
  buildRuntimeOutputStyleReminderBody,
} from "../helpers/runtime-reminders.js";
import { prepareRuntimeProviderRequest } from "../helpers/runtime-provider-request-messages.js";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  baselineCurrentEnvironment,
  buildRequestAnnouncements,
  buildRuntimeContextAnnouncements,
  collectSkillsListing,
  latestAnnouncedEnvironment,
  previewSessionContextAnnouncement,
} from "../methods/context-refresh.js";
import { AUTOMATION_SELF_PAUSE_TOOL_NAME } from "../methods/turn-loop-state.js";
import { classifyContextComposition, type ContextCompositionBreakdown } from "./classifier.js";
import { collectContextCompositionItems } from "./items.js";

export async function previewContextComposition(
  runtime: AgentRuntimeInternal,
  input: { model: Model; traceContext: TraceContext },
): Promise<ContextCompositionBreakdown> {
  const { model, traceContext } = input;
  // 可接受的副作用：与技能面板同一条初始化路径（启动 MCP、建记忆与 gen-ui 目录、内存里装好前缀），都不落库。
  await runtime.ensureContextInitialized(traceContext, model);
  await runtime.initializeMcp(traceContext);
  const contextResult = buildPreviewContextResult(runtime, model);
  // 普通用户轮里 CronPauseSelf 在请求边界隐藏（turn-tool-visibility.ts）；预演按普通轮处理。
  const tools = runtime
    .getTools(model)
    .filter((tool) => tool.name !== AUTOMATION_SELF_PAUSE_TOOL_NAME);
  const canonical = runtime.messageHistory.borrowReadOnlyRuntimeEntries();
  const entries = simulateRequestEntries(runtime, {
    contextResult,
    entries: [
      ...buildContextHistoryEntries(contextResult),
      ...canonical.slice(countContextPrefixMessages(canonical)),
    ],
    model,
    tools,
  });
  const prepared = prepareRuntimeProviderRequest(runtime, {
    model,
    tools,
    registry: runtime.getToolRegistry(),
    entries,
    applyCacheControl: true,
  });
  return classifyContextComposition({
    sections: contextResult.sections,
    messages: prepared.request.messages,
    originEntries: prepared.projection.originEntries,
    sourceEntries: prepared.projection.sourceEntries,
    tools: prepared.request.tools,
    ...collectContextCompositionItems(runtime),
  });
}

/**
 * 按所查模型新建 context 前缀，不写回 runtime：不调 rebuildContextPrefix，
 * 不改 contextBuilder / latestContextBuildResult / 历史，也不把 envInfo 写回 config。
 */
function buildPreviewContextResult(
  runtime: AgentRuntimeInternal,
  model: Model,
): ContextBuildResult {
  const snapshot =
    runtime.contextSourceSnapshot ??
    runtime.createConfigOnlyContextSnapshot(runtime.workingDirectory);
  return runtime
    .createContextBuilderFromSnapshot(snapshot, runtime.memoryRoot, {
      memoryIndexContent: runtime.memoryIndexContent,
      model,
      persistEnvInfo: false,
    })
    .build();
}

/** 输入附件与请求前公告，顺序同 turn-loop.ts 的 collectInputAttachments 与 appendRequestAnnouncements。 */
function simulateRequestEntries(
  runtime: AgentRuntimeInternal,
  input: {
    contextResult: ContextBuildResult;
    entries: RuntimeMessageEntry[];
    model: Model;
    tools: readonly ModelToolContract[];
  },
): RuntimeMessageEntry[] {
  const { contextResult, model, tools } = input;
  const entries = input.entries;
  const outputStyle = runtime.config.outputStyle;
  entries.push(
    ...buildRuntimeContextAnnouncements(runtime, entries, {
      contextResult,
      environment: baselineCurrentEnvironment(runtime, latestAnnouncedEnvironment(entries)),
      model,
      outputStyle,
    }),
  );
  const toolSearch = buildToolSearchAnnouncement({
    model,
    mode: runtime.config.toolSearch?.mode,
    tools,
    registry: runtime.getToolRegistry(),
    entries,
  });
  if (toolSearch) entries.push(toolSearch);
  const agentListing = collectRuntimeAgentListing(runtime, entries, tools);
  if (agentListing) entries.push(agentListing);
  const skillsListing = collectSkillsListing(runtime, entries, contextResult);
  if (skillsListing) entries.push(skillsListing);
  const modeReminder = buildRuntimeModeReminderBody(
    entries,
    runtime.getMode(),
    runtime.getPlanEnabled(),
  );
  if (modeReminder) entries.push(systemReminderAttachmentEntry("runtime_mode", modeReminder));
  const outputStyleReminder = buildRuntimeOutputStyleReminderBody(outputStyle);
  if (outputStyleReminder)
    entries.push(systemReminderAttachmentEntry("output_style", outputStyleReminder));
  const sessionContext = previewSessionContextAnnouncement(runtime, entries, contextResult);
  entries.push(...buildRequestAnnouncements(runtime, entries, sessionContext, contextResult));
  return entries;
}
