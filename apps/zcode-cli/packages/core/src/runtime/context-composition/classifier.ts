// Context 组成的分类纯函数：一次请求 → 细类别；细类别 → 圆环的 7 个粗类别；细类别 → 线格式。
// 规格：apps/zcode-cli/docs/design/v2/model/context-composition.md §3.1。
//
// 只有这一处计算。圆环（ModelComplete.contextUsageBreakdown）与 v4 查询都从这里出数，
// 粗类别只由 shared 的 contextCompositionUsageSource 投影，不另算第二套。
import {
  CONTEXT_COMPOSITION_CATEGORY_IDS,
  CONTEXT_COMPOSITION_MAX_ITEMS,
  contextCompositionUsageSource,
  truncateContextCompositionItemName,
  type ContextCompositionCategory,
  type ContextCompositionCategoryId,
  type ContextCompositionToolOrigin,
  type ContextCompositionUsageSource,
} from "@zcode/shared/zcode-protocol-v4";
import {
  isKnownSystemReminderSource,
  isRuntimeAttachmentEntry,
  type ModelInputMessage,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";
import type { ContextSection } from "../../context/types.js";
import { estimateTokens } from "../../context/utils.js";
import type { ModelToolContract } from "../deps.js";
import { isMetaUserContextMessage } from "../helpers/conversation.js";
import { parseMcpToolName, stringifyForEstimation } from "../helpers/tool-result.js";

const APP_TOOL_NAME_PREFIX = "app__";
const SECTION_SOURCE_SKILLS = "skills";
const SECTION_SOURCE_TOOLS = "tools";
const SECTION_TARGET_SYSTEM = "system";
const REMINDER_SOURCE_CONTEXT_PREFIX = "context_prefix";
const REMINDER_SOURCE_SKILLS_LISTING = "skills_listing";
const TASK_NOTIFICATION_PRESENTATION = "task_notification";
const ROLE_SYSTEM = "system";

/** 粗类别的固定顺序（与改前 buildContextUsageSnapshot 的 categories 顺序一致）。 */
export const CONTEXT_USAGE_SOURCE_ORDER: readonly ContextCompositionUsageSource[] = [
  "system_prompt",
  "meta_user_context",
  "skills",
  "tool_prompt",
  "system_tool_schemas",
  "mcp_tool_schemas",
  "messages",
];

export interface ContextCompositionBreakdownItem {
  name: string;
  chars: number;
  tokens: number;
  /** 消息角色条目的条数。 */
  count?: number;
  /** 只在延迟加载工具上：投影到圆环时按它归入内置或 MCP。 */
  toolOrigin?: ContextCompositionToolOrigin;
}

export interface ContextCompositionBreakdownCategory {
  id: ContextCompositionCategoryId;
  chars: number;
  tokens: number;
  items: ContextCompositionBreakdownItem[];
}

/** 一次请求的完整分解；categories 恒为 11 个细类别，按 CONTEXT_COMPOSITION_CATEGORY_IDS 排序，含 0 值。 */
export interface ContextCompositionBreakdown {
  categories: ContextCompositionBreakdownCategory[];
}

export interface ContextCompositionNamedSize {
  name: string;
  chars: number;
  tokens: number;
}

export interface ContextCompositionClassifierInput {
  /** 本次请求所用 context 前缀的 sections；system 消息由它们组成。 */
  sections: readonly Pick<
    ContextSection,
    "name" | "source" | "injectionTarget" | "chars" | "tokens"
  >[];
  /** 实际发给服务商的消息（provider 投影之后）。 */
  messages: readonly ModelInputMessage[];
  /**
   * 与 messages 同索引的全部来源条目（provider 投影的 originEntries）。优先使用：
   * MCS 合并的提醒、并入 tool result 的提醒都只能从这里归因。
   */
  originEntries?: readonly (readonly RuntimeMessageEntry[])[];
  /** 与 messages 同索引的代表条目；没有 originEntries 时使用，再缺失时只看消息形态。 */
  sourceEntries?: readonly (RuntimeMessageEntry | undefined)[];
  /** 实际发给服务商的工具（ToolSearch 曝光之后）。 */
  tools: readonly ModelToolContract[];
  /** 技能条目（名字与元数据大小）；只作 skills 类别的条目，类别大小取公告真实文本。 */
  skillItems?: readonly ContextCompositionNamedSize[];
  /** 指令文件条目；只作 meta_user_context 类别的条目。 */
  instructionItems?: readonly ContextCompositionNamedSize[];
}

interface Accumulator {
  chars: number;
  tokens: number;
  items: Map<string, ContextCompositionBreakdownItem>;
}

export function classifyContextComposition(
  input: ContextCompositionClassifierInput,
): ContextCompositionBreakdown {
  const accumulators = new Map<ContextCompositionCategoryId, Accumulator>(
    CONTEXT_COMPOSITION_CATEGORY_IDS.map((id) => [id, { chars: 0, tokens: 0, items: new Map() }]),
  );
  const add = (
    id: ContextCompositionCategoryId,
    item: ContextCompositionBreakdownItem,
    options: { countsTowardTotal?: boolean } = {},
  ) => {
    const accumulator = accumulators.get(id)!;
    if (options.countsTowardTotal !== false) {
      accumulator.chars += item.chars;
      accumulator.tokens += item.tokens;
    }
    const key = `${item.toolOrigin ?? ""}\0${item.name}`;
    const existing = accumulator.items.get(key);
    if (!existing) {
      accumulator.items.set(key, { ...item });
      return;
    }
    existing.chars += item.chars;
    existing.tokens += item.tokens;
    if (item.count !== undefined) existing.count = (existing.count ?? 0) + item.count;
  };

  for (const section of input.sections) {
    const id = sectionCategory(section);
    if (!id) continue;
    add(id, { name: section.name, chars: section.chars, tokens: section.tokens });
  }

  input.messages.forEach((message, index) => {
    const content = stringifyForEstimation({
      role: message.role,
      content: message.content,
      toolCalls: message.toolCalls,
      toolCallId: message.toolCallId,
      toolName: message.toolName,
    });
    const origins = input.originEntries?.[index];
    const parts =
      origins && origins.length > 0
        ? origins.map((origin) => ({
            placement: entryCategory(origin, entryMessage(origin) ?? message),
            weight: originWeight(origin),
          }))
        : [{ placement: entryCategory(input.sourceEntries?.[index], message), weight: 1 }];
    // 一条消息由多个来源组成时（MCS 合并的提醒、并入 tool result 的提醒），按各来源正文长度分摊大小。
    // 被跳过的部分（context 前缀的 system 消息由 sections 计）仍占自己的份额，不分给其他来源。
    const shares = apportion(
      { chars: content.length, tokens: estimateTokens(content) },
      parts.map((part) => part.weight),
    );
    parts.forEach((part, partIndex) => {
      if (!part.placement) return;
      add(part.placement.id, {
        name: part.placement.itemName,
        ...shares[partIndex]!,
        ...(part.placement.id === "messages" ? { count: 1 } : {}),
      });
    });
  });

  for (const tool of input.tools) {
    const { id, content, toolOrigin } = toolCategory(tool);
    add(id, {
      name: tool.name,
      chars: content.length,
      tokens: estimateTokens(content),
      ...(toolOrigin ? { toolOrigin } : {}),
    });
  }

  // 技能与指令的条目来自各自的元数据，类别大小已按公告真实文本计入；条目不重复累计。
  const skills = accumulators.get("skills")!;
  if (skills.tokens > 0) {
    skills.items.clear();
    for (const item of input.skillItems ?? []) add("skills", item, { countsTowardTotal: false });
  }
  const instructions = accumulators.get("meta_user_context")!;
  if (instructions.tokens > 0 && (input.instructionItems?.length ?? 0) > 0) {
    instructions.items.clear();
    for (const item of input.instructionItems ?? [])
      add("meta_user_context", item, { countsTowardTotal: false });
  }

  return {
    categories: CONTEXT_COMPOSITION_CATEGORY_IDS.map((id) => {
      const accumulator = accumulators.get(id)!;
      return {
        id,
        chars: accumulator.chars,
        tokens: accumulator.tokens,
        items: [...accumulator.items.values()],
      };
    }),
  };
}

/** 细类别 → 圆环 7 个粗类别；只返回非 0 的粗类别，按 CONTEXT_USAGE_SOURCE_ORDER 排序。 */
export function projectContextCompositionToUsageSources(
  breakdown: ContextCompositionBreakdown,
): Array<{ source: ContextCompositionUsageSource; chars: number; tokens: number }> {
  const totals = new Map<ContextCompositionUsageSource, { chars: number; tokens: number }>();
  const add = (source: ContextCompositionUsageSource, chars: number, tokens: number) => {
    const current = totals.get(source) ?? { chars: 0, tokens: 0 };
    current.chars += chars;
    current.tokens += tokens;
    totals.set(source, current);
  };
  for (const category of breakdown.categories) {
    if (category.id === "deferred_tool_schemas") {
      // 延迟加载工具的类别大小等于条目之和，按每个工具的来源分别投影。
      for (const item of category.items)
        add(contextCompositionUsageSource(category.id, item.toolOrigin), item.chars, item.tokens);
      continue;
    }
    add(contextCompositionUsageSource(category.id), category.chars, category.tokens);
  }
  return CONTEXT_USAGE_SOURCE_ORDER.flatMap((source) => {
    const total = totals.get(source);
    return total && total.tokens > 0 ? [{ source, ...total }] : [];
  });
}

/** 细类别 → 线格式：去掉 0 值类别；条目按 token 降序、最多 50 条、名字截断到 200 字符。 */
export function toContextCompositionCategories(
  breakdown: ContextCompositionBreakdown,
): ContextCompositionCategory[] {
  return breakdown.categories
    .filter((category) => category.tokens > 0)
    .map((category) => {
      const items = category.items
        .filter((item) => item.name.length > 0)
        .toSorted((left, right) => right.tokens - left.tokens)
        .slice(0, CONTEXT_COMPOSITION_MAX_ITEMS)
        .map((item) => ({
          name: truncateContextCompositionItemName(item.name),
          tokens: item.tokens,
        }));
      return {
        id: category.id,
        tokens: category.tokens,
        chars: category.chars,
        ...(items.length > 0 ? { items } : {}),
      };
    });
}

function sectionCategory(
  section: ContextCompositionClassifierInput["sections"][number],
): ContextCompositionCategoryId | undefined {
  // meta_user 注入的 section 都已变成历史里的公告，按请求里的真实文本计；这里只计 system 消息的组成。
  if (section.injectionTarget !== SECTION_TARGET_SYSTEM) return undefined;
  if (section.source === SECTION_SOURCE_TOOLS) return "tool_prompt";
  if (section.source === SECTION_SOURCE_SKILLS) return "skills";
  return "system_prompt";
}

function entryMessage(entry: RuntimeMessageEntry): ModelInputMessage | undefined {
  return isRuntimeAttachmentEntry(entry) ? undefined : entry.message;
}

function originWeight(entry: RuntimeMessageEntry): number {
  const content = isRuntimeAttachmentEntry(entry)
    ? entry.content
    : stringifyForEstimation(entry.message.content);
  return Math.max(1, content.length);
}

/** 按权重把整数大小分给各部分；最后一份兜住取整误差，总和不变。 */
function apportion(
  total: { chars: number; tokens: number },
  weights: readonly number[],
): Array<{ chars: number; tokens: number }> {
  if (weights.length === 1) return [total];
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  let charsLeft = total.chars;
  let tokensLeft = total.tokens;
  return weights.map((weight, index) => {
    if (index === weights.length - 1) return { chars: charsLeft, tokens: tokensLeft };
    const chars = Math.round((total.chars * weight) / weightSum);
    const tokens = Math.round((total.tokens * weight) / weightSum);
    charsLeft -= chars;
    tokensLeft -= tokens;
    return { chars, tokens };
  });
}

function entryCategory(
  entry: RuntimeMessageEntry | undefined,
  message: ModelInputMessage,
): { id: ContextCompositionCategoryId; itemName: string } | undefined {
  const metadata = entry?.metadata;
  if (!metadata) {
    // context 前缀的 system 消息由 sections 计入，这里跳过，避免重复。
    if (message.role === ROLE_SYSTEM) return undefined;
    // 没有来源标记的 `<system-reminder>` user 消息是旧版 context 前缀。
    if (isMetaUserContextMessage(message))
      return { id: "meta_user_context", itemName: REMINDER_SOURCE_CONTEXT_PREFIX };
    return { id: "messages", itemName: message.role };
  }
  if (metadata.compactBoundary) return { id: "compact_summary", itemName: "compact_summary" };
  // 修复原因：新轮通知带 wrapper，外形像提醒，但它是要模型处理的输入，按消息计。
  if (metadata.inputPresentation === TASK_NOTIFICATION_PRESENTATION)
    return { id: "messages", itemName: message.role };
  if (metadata.source === REMINDER_SOURCE_CONTEXT_PREFIX)
    return { id: "meta_user_context", itemName: REMINDER_SOURCE_CONTEXT_PREFIX };
  if (metadata.source === REMINDER_SOURCE_SKILLS_LISTING)
    return { id: "skills", itemName: REMINDER_SOURCE_SKILLS_LISTING };
  // 修复原因：提醒以前因 `<system-reminder>` 外形被整体排除（MCS 下是 system 消息，同样被排除），
  // 环境、子代理列表、ToolSearch 公告等在请求里真实存在却漏算。现在按来源计入 reminders。
  if (isKnownSystemReminderSource(metadata.source) || (entry && isRuntimeAttachmentEntry(entry)))
    return { id: "reminders", itemName: metadata.source };
  return { id: "messages", itemName: message.role };
}

function toolCategory(tool: ModelToolContract): {
  id: ContextCompositionCategoryId;
  content: string;
  toolOrigin?: ContextCompositionToolOrigin;
} {
  const mcp = parseMcpToolName(tool.name) !== undefined;
  if (tool.deferLoading === true) {
    // 修复原因：延迟加载工具只把名字与描述放进上下文，按全量 schema 计会高估。
    return {
      id: "deferred_tool_schemas",
      content: stringifyForEstimation({ name: tool.name, description: tool.description }),
      toolOrigin: mcp ? "mcp" : "system",
    };
  }
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
  if (mcp) return { id: "mcp_tool_schemas", content };
  // 修复原因：页面工具（app__）以前只因不是 mcp__ 前缀被算成内置工具。
  if (tool.name.startsWith(APP_TOOL_NAME_PREFIX)) return { id: "app_tool_schemas", content };
  return { id: "system_tool_schemas", content };
}
