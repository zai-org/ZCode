import { modelMessageContentToText, traceContextToLogContext, estimateTokens } from "../deps.js";
import type { ModelInputMessage, ModelToolContract, TraceContext } from "../deps.js";
import type { ContextUsageBreakdownItem } from "@zcode/contracts";
import {
  measureUtf8Bytes,
  findLatestUserMessageFromEnd,
  stringifyForEstimation,
  parseMcpToolName,
} from "../helpers/index.js";
import type { ContextUsageContributor } from "../helpers/context-usage-breakdown.js";
import {
  contextCompositionUsageSource,
  type ContextCompositionCategoryId,
} from "@zcode/shared/zcode-protocol-v4";
import {
  classifyContextComposition,
  projectContextCompositionToUsageSources,
  type ContextCompositionBreakdown,
} from "../context-composition/classifier.js";
import { collectContextCompositionItems } from "../context-composition/items.js";
import { compactContextUsageSnapshot } from "./context-usage-log-compact.js";
import type {
  ActiveTurnSteeringState,
  DrainedPendingInputDiagnostics,
  RunModelTextRequestOptions,
  ContextUsageConfidence,
  ContextUsageMetric,
  ContextUsageCategory,
  ContextUsageToolDetail,
  ContextUsageSkillDetail,
  ContextUsageMessageRoleBreakdown,
} from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";

type ContextUsageBreakdownSource = ContextUsageCategory["source"];

/** buildContextUsageSnapshot 的结果：调试字段保持松散，细类别分解是带类型的。 */
export type ContextUsageSnapshot = Record<string, unknown> & {
  composition: ContextCompositionBreakdown;
};

const CONTEXT_USAGE_CATEGORY_NAMES: Record<ContextUsageBreakdownSource, string> = {
  system_prompt: "System prompt",
  meta_user_context: "Meta user context",
  skills: "Skills",
  tool_prompt: "Tool prompt",
  system_tool_schemas: "System tool schemas",
  mcp_tool_schemas: "MCP tool schemas",
  messages: "Messages",
};

const CONTRIBUTOR_KIND_BY_CATEGORY: Record<
  ContextCompositionCategoryId,
  ContextUsageContributor["kind"]
> = {
  system_prompt: "context_section",
  meta_user_context: "context_section",
  skills: "skill",
  tool_prompt: "context_section",
  system_tool_schemas: "tool_schema",
  mcp_tool_schemas: "tool_schema",
  app_tool_schemas: "tool_schema",
  deferred_tool_schemas: "tool_schema",
  reminders: "context_section",
  compact_summary: "message_role",
  messages: "message_role",
};

const CONTEXT_USAGE_BREAKDOWN_SOURCES = new Set<ContextUsageBreakdownSource>([
  "system_prompt",
  "meta_user_context",
  "skills",
  "tool_prompt",
  "system_tool_schemas",
  "mcp_tool_schemas",
  "messages",
]);

export function logContextUsageSnapshot(
  this: AgentRuntimeInternal,
  options: RunModelTextRequestOptions,
  snapshot: Record<string, unknown> = this.buildContextUsageSnapshot(options),
): void {
  this.logger?.debug("Context usage snapshot", {
    ...traceContextToLogContext(options.traceContext),
    event: "context_usage_snapshot",
    module: "core.runtime",
    status: "completed",
    ...compactContextUsageSnapshot(snapshot),
  });
}

export function logModelRequestSteeringContext(
  this: AgentRuntimeInternal,
  options: {
    activeTurn?: ActiveTurnSteeringState;
    drained?: DrainedPendingInputDiagnostics;
    messages: ModelInputMessage[];
    modelStepCount: number;
    traceContext: TraceContext;
  },
): void {
  if (!options.activeTurn && !options.drained) return;

  const drainedCount = options.drained?.pendingInputIds.length ?? 0;
  const drainedTail = drainedCount > 0 ? options.messages.slice(-drainedCount) : [];
  const drainedInputVisibleAtTail =
    drainedCount > 0 &&
    drainedTail.length === drainedCount &&
    drainedTail.every((message) => message.role === "user");
  const messageTail = this.buildModelMessageTailDiagnostics(options.messages);

  this.logger?.debug("Model request steering context", {
    ...traceContextToLogContext(options.traceContext),
    activeTurnId: options.activeTurn?.turnId,
    activeTurnKind: options.activeTurn?.kind,
    activeTurnQueueLength: options.activeTurn?.pendingInputs.length,
    activeTurnSteerable: options.activeTurn?.steerable,
    drainedInputCount: drainedCount,
    drainedInputVisibleAtTail,
    drainedPendingInputIds: options.drained?.pendingInputIds,
    event: "model.request.steering_context",
    injectedMessageIds: options.drained?.injectedMessageIds,
    latestUserMessageFromEnd: findLatestUserMessageFromEnd(options.messages),
    messageCount: options.messages.length,
    messageTail,
    messageTailRoles: messageTail.map((message) => message.role),
    modelStepCount: options.modelStepCount,
    module: "core.runtime",
    status: "completed",
  });
}

export function buildModelMessageTailDiagnostics(
  this: AgentRuntimeInternal,
  messages: ModelInputMessage[],
  limit = 8,
): Array<Record<string, unknown>> {
  const tail = messages.slice(-limit);
  const startIndex = messages.length - tail.length;
  return tail.map((message, index) => ({
    contentBytes: measureUtf8Bytes(modelMessageContentToText(message.content)),
    contentBlockCount: Array.isArray(message.content) ? message.content.length : undefined,
    hasToolCalls: (message.toolCalls?.length ?? 0) > 0,
    index: startIndex + index,
    role: message.role,
    toolCallCount: message.toolCalls?.length ?? 0,
    toolCallId: message.toolCallId,
    toolName: message.toolName,
  }));
}

export function buildContextUsageSnapshot(
  this: AgentRuntimeInternal,
  options: RunModelTextRequestOptions,
): ContextUsageSnapshot {
  const contextSections = this.latestContextBuildResult?.sections ?? [];
  const systemPromptSections = contextSections.map((section) => ({
    name: section.name,
    source: section.source,
    injectionTarget: section.injectionTarget,
    cacheHint: section.cacheHint,
    ...this.estimatedMetricFromKnown(section.chars, section.tokens, "medium"),
  }));
  const toolDetails = options.tools.map((tool) => this.buildToolUsageDetail(tool));
  const systemTools = toolDetails.filter((tool) => tool.source === "system_tool");
  const mcpTools = toolDetails.filter((tool) => tool.source === "mcp_tool");
  const skillDetails = this.buildSkillUsageDetails();
  const messageBreakdown = this.buildMessageRoleBreakdown(options.messages);
  // 一份分解：细类别由分类纯函数产出，圆环的 7 个粗类别只由它投影（spec §3.1）。
  // 修复原因：旧实现按 `<system-reminder>` 外形排除消息、按 builder section 估算指令与技能，
  // 提醒、页面工具、延迟加载工具和 compact summary 的归类都不对。
  const composition = classifyContextComposition({
    sections: contextSections,
    messages: options.messages,
    originEntries: options.originEntries,
    sourceEntries: options.sourceEntries,
    tools: options.tools,
    ...collectContextCompositionItems(this),
  });
  const categories = projectContextCompositionToUsageSources(composition).map((usage) =>
    this.buildContextUsageCategory(
      CONTEXT_USAGE_CATEGORY_NAMES[usage.source],
      usage.source,
      this.estimatedMetricFromKnown(
        usage.chars,
        usage.tokens,
        usage.source === "system_tool_schemas" || usage.source === "mcp_tool_schemas"
          ? "low"
          : "medium",
      ),
    ),
  );
  const totalTokens = categories.reduce((sum, category) => sum + category.tokens, 0);
  const totalChars = categories.reduce((sum, category) => sum + category.chars, 0);
  const categoriesWithPercent = categories.map((category) => ({
    ...category,
    percentTokens: totalTokens > 0 ? category.tokens / totalTokens : 0,
  }));
  const categoryBreakdown = categoriesWithPercent.map((category) => ({
    ...category,
    contributors: compositionContributors(this, composition, category.source),
  }));

  return {
    tokenMethod: "estimated",
    confidence: "low",
    tokenizer: "zcode.estimateTokens.v1",
    totalChars,
    totalTokens,
    model: `${options.model.providerId}/${options.model.modelId}`,
    categories: categoriesWithPercent,
    categoryBreakdown,
    composition,
    systemPromptSections,
    systemTools,
    mcpTools,
    skills: skillDetails,
    messageBreakdown,
    warnings: [
      "当前 token 来自本地估算，不是 provider count；tool schema 的真实 token 取决于 provider 序列化。",
      "system 消息按 context sections 统计；其余消息按请求里的真实文本和来源归类，不重复计算。",
    ],
  };
}

/** 调试日志的贡献者：细类别条目按所属粗类别分组。只进 debug 日志，不是稳定 API。 */
function compositionContributors(
  runtime: AgentRuntimeInternal,
  composition: ContextCompositionBreakdown,
  source: ContextUsageCategory["source"],
): ContextUsageContributor[] {
  return composition.categories.flatMap((category) =>
    category.items
      .filter((item) => contextCompositionUsageSource(category.id, item.toolOrigin) === source)
      .map((item) => ({
        ...runtime.estimatedMetricFromKnown(item.chars, item.tokens, "medium"),
        kind: CONTRIBUTOR_KIND_BY_CATEGORY[category.id],
        categorySource: source,
        label: item.name,
        name: item.name,
        ...(category.id === "messages" ? { role: item.name, count: item.count } : {}),
      })),
  );
}

export function buildContextUsageBreakdownFromSnapshot(
  snapshot: Record<string, unknown>,
): ContextUsageBreakdownItem[] {
  const categories = Array.isArray(snapshot.categories) ? snapshot.categories : [];
  const breakdown: ContextUsageBreakdownItem[] = [];

  for (const category of categories) {
    if (!isRecord(category)) {
      continue;
    }
    const source = contextUsageBreakdownSource(category.source);
    const chars = nonNegativeInteger(category.chars);
    if (!source || chars === undefined || chars <= 0) {
      continue;
    }
    breakdown.push({ source, chars });
  }

  return breakdown;
}

export function buildContextUsageCategory(
  this: AgentRuntimeInternal,
  name: ContextUsageCategory["name"],
  source: ContextUsageCategory["source"],
  metric: ContextUsageMetric,
): ContextUsageCategory {
  return {
    name,
    source,
    ...metric,
    percentTokens: 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contextUsageBreakdownSource(value: unknown): ContextUsageBreakdownSource | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return CONTEXT_USAGE_BREAKDOWN_SOURCES.has(value as ContextUsageBreakdownSource)
    ? (value as ContextUsageBreakdownSource)
    : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.trunc(value);
}

export function buildToolUsageDetail(
  this: AgentRuntimeInternal,
  tool: ModelToolContract,
): ContextUsageToolDetail {
  const content = stringifyForEstimation({
    name: tool.name,
    description: tool.description,
    capability: tool.capability,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    readOnly: tool.readOnly,
    destructive: tool.destructive,
    sideEffectScope: tool.sideEffectScope,
    permission: tool.permission,
    resultBudget: tool.resultBudget,
  });
  const mcp = parseMcpToolName(tool.name);
  return {
    name: tool.name,
    source: mcp ? "mcp_tool" : "system_tool",
    serverName: mcp?.serverName,
    readOnly: tool.readOnly,
    sideEffectScope: tool.sideEffectScope,
    ...this.estimatedMetric(content, "low"),
  };
}

export function buildSkillUsageDetails(this: AgentRuntimeInternal): ContextUsageSkillDetail[] {
  return (this.skillLoadOutcome?.skills ?? []).map((skill) => {
    const content = [
      skill.name,
      skill.description,
      skill.whenToUse,
      skill.source,
      skill.scope,
      skill.path,
    ]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join("\n");
    return {
      name: skill.name,
      source: skill.source,
      scope: skill.scope,
      path: skill.path,
      ...this.estimatedMetric(content, "medium"),
    };
  });
}

export function buildMessageRoleBreakdown(
  this: AgentRuntimeInternal,
  messages: RunModelTextRequestOptions["messages"],
): ContextUsageMessageRoleBreakdown[] {
  const byRole = new Map<string, { chars: number; count: number; tokens: number }>();
  for (const message of messages) {
    const content = stringifyForEstimation({
      role: message.role,
      content: message.content,
      toolCalls: message.toolCalls,
      toolCallId: message.toolCallId,
      toolName: message.toolName,
    });
    const current = byRole.get(message.role) ?? { chars: 0, count: 0, tokens: 0 };
    current.chars += content.length;
    current.count += 1;
    current.tokens += estimateTokens(content);
    byRole.set(message.role, current);
  }

  return [...byRole.entries()].map(([role, value]) => ({
    role,
    count: value.count,
    ...this.estimatedMetricFromKnown(value.chars, value.tokens, "medium"),
  }));
}

export function estimatedMetric(
  this: AgentRuntimeInternal,
  content: string,
  confidence: ContextUsageConfidence,
): ContextUsageMetric {
  return this.estimatedMetricFromKnown(content.length, estimateTokens(content), confidence);
}

export function estimatedMetricFromKnown(
  this: AgentRuntimeInternal,
  chars: number,
  tokens: number,
  confidence: ContextUsageConfidence,
): ContextUsageMetric {
  return {
    chars,
    tokens,
    tokenMethod: "estimated",
    confidence,
    tokenizer: "zcode.estimateTokens.v1",
  };
}

export function sumMetrics(
  this: AgentRuntimeInternal,
  values: Array<Pick<ContextUsageMetric, "chars" | "tokens">>,
  confidence: ContextUsageConfidence,
): ContextUsageMetric {
  return {
    chars: values.reduce((sum, value) => sum + value.chars, 0),
    tokens: values.reduce((sum, value) => sum + value.tokens, 0),
    tokenMethod: "estimated",
    confidence,
    tokenizer: "zcode.estimateTokens.v1",
  };
}
