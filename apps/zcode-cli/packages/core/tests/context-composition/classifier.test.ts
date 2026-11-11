// Context 组成分类（spec §4 第 1、2、6 类）：
// apps/zcode-cli/docs/design/v2/model/context-composition.md。
import { describe, expect, it } from "vitest";
import {
  CONTEXT_COMPOSITION_CATEGORY_IDS,
  CONTEXT_COMPOSITION_MAX_ITEMS,
  CONTEXT_COMPOSITION_MAX_ITEM_NAME_CHARS,
  contextCompositionCategorySchema,
  contextCompositionUsageSource,
  type ContextCompositionCategoryId,
} from "@zcode/shared/zcode-protocol-v4";
import { zcodeContextUsageBreakdownSourceSchema } from "@zcode/shared";
import type { ModelToolContract } from "@zcode/contracts";
import {
  systemReminderAttachmentEntry,
  type RuntimeMessageEntry,
} from "../../src/agent/message-history.js";
import { buildProviderRequestMessages } from "../../src/runtime/helpers/provider-request-messages.js";
import {
  classifyContextComposition,
  projectContextCompositionToUsageSources,
  toContextCompositionCategories,
  type ContextCompositionBreakdown,
} from "../../src/runtime/context-composition/index.js";

const SYSTEM_SECTION = {
  name: "Identity",
  source: "identity" as const,
  injectionTarget: "system" as const,
  chars: 120,
  tokens: 40,
};
const TOOL_SECTION = {
  name: "Tool guidance",
  source: "tools" as const,
  injectionTarget: "system" as const,
  chars: 60,
  tokens: 20,
};
// meta_user section 已变成历史里的公告；分类只按请求里的真实文本计，section 本身不能再计一次。
const META_SECTION = {
  name: "Request User Context",
  source: "request_user_context" as const,
  injectionTarget: "meta_user" as const,
  chars: 9_999,
  tokens: 9_999,
};

function tool(name: string, extra: Partial<ModelToolContract> = {}): ModelToolContract {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: "object", properties: { value: { type: "string" } } },
    ...extra,
  };
}

function category(breakdown: ContextCompositionBreakdown, id: ContextCompositionCategoryId) {
  return breakdown.categories.find((item) => item.id === id)!;
}

function classifyEntries(
  entries: RuntimeMessageEntry[],
  mcs: boolean,
  tools: ModelToolContract[] = [],
) {
  const projection = buildProviderRequestMessages({ entries, useMidConversationSystem: mcs });
  return classifyContextComposition({
    sections: [SYSTEM_SECTION, TOOL_SECTION, META_SECTION],
    messages: projection.messages,
    originEntries: projection.originEntries,
    sourceEntries: projection.sourceEntries,
    tools,
  });
}

const baseEntries = (): RuntimeMessageEntry[] => [
  { message: { role: "system", content: "system prefix" } },
  systemReminderAttachmentEntry("context_prefix", "AGENTS.md instructions"),
  systemReminderAttachmentEntry("skills_listing", "- skill-a: does a"),
  systemReminderAttachmentEntry("environment", "Working directory: /Users/dev/project"),
  systemReminderAttachmentEntry("agent_listing_delta", "Available agent types: explorer"),
  systemReminderAttachmentEntry("tool_search_announcement", "Deferred tools: mcp__docs__read"),
  { message: { role: "user", content: "hello" }, metadata: { source: "real_user" } },
  { message: { role: "assistant", content: "hi" } },
];

describe("context composition classifier", () => {
  it.each([true, false])("puts every reminder source into reminders, MCS=%s", (mcs) => {
    const breakdown = classifyEntries(baseEntries(), mcs);

    expect(category(breakdown, "system_prompt")).toMatchObject({ tokens: 40, chars: 120 });
    expect(category(breakdown, "tool_prompt")).toMatchObject({ tokens: 20, chars: 60 });
    const reminders = category(breakdown, "reminders");
    expect(reminders.tokens).toBeGreaterThan(0);
    expect(reminders.items.map((item) => item.name).sort()).toEqual([
      "agent_listing_delta",
      "environment",
      "tool_search_announcement",
    ]);
    // 指令与技能按请求里的真实公告文本计，不按 builder section 估算。
    expect(category(breakdown, "meta_user_context").tokens).toBeGreaterThan(0);
    expect(category(breakdown, "meta_user_context").tokens).toBeLessThan(META_SECTION.tokens);
    expect(category(breakdown, "skills").tokens).toBeGreaterThan(0);
    const messages = category(breakdown, "messages");
    expect(messages.items.map((item) => [item.name, item.count])).toEqual([
      ["user", 1],
      ["assistant", 1],
    ]);
  });

  it("puts the compact summary into compact_summary and new-turn notifications into messages", () => {
    const breakdown = classifyEntries(
      [
        {
          message: { role: "user", content: "<summary>older work</summary>" },
          metadata: { source: "legacy_synthetic", compactBoundary: { boundaryId: "b1" } },
        },
        {
          message: { role: "user", content: "<task-notification>done</task-notification>" },
          metadata: { source: "legacy_synthetic", inputPresentation: "task_notification" },
        },
      ],
      false,
    );

    expect(category(breakdown, "compact_summary").tokens).toBeGreaterThan(0);
    expect(category(breakdown, "messages").tokens).toBeGreaterThan(0);
    expect(category(breakdown, "reminders").tokens).toBe(0);
  });

  it("separates app__, mcp__, deferred and built-in tools", () => {
    const schemaHeavy = {
      inputSchema: {
        type: "object",
        properties: { long: { type: "string", description: "x".repeat(500) } },
      },
    };
    const breakdown = classifyEntries([], false, [
      tool("Read"),
      tool("mcp__docs__search"),
      tool("app__page__click"),
      tool("mcp__docs__read", { deferLoading: true, ...schemaHeavy }),
      tool("NotebookEdit", { deferLoading: true, ...schemaHeavy }),
    ]);

    expect(category(breakdown, "system_tool_schemas").items.map((item) => item.name)).toEqual([
      "Read",
    ]);
    expect(category(breakdown, "mcp_tool_schemas").items.map((item) => item.name)).toEqual([
      "mcp__docs__search",
    ]);
    expect(category(breakdown, "app_tool_schemas").items.map((item) => item.name)).toEqual([
      "app__page__click",
    ]);
    const deferred = category(breakdown, "deferred_tool_schemas");
    expect(deferred.items.map((item) => [item.name, item.toolOrigin])).toEqual([
      ["mcp__docs__read", "mcp"],
      ["NotebookEdit", "system"],
    ]);
    // 只计名字与描述：不受 schema 大小影响。
    const nameAndDescription = JSON.stringify({
      name: "NotebookEdit",
      description: "NotebookEdit description",
    });
    expect(deferred.items[1]!.chars).toBe(nameAndDescription.length);
  });

  it("uses metadata items for skills and instructions without counting them twice", () => {
    const projection = buildProviderRequestMessages({
      entries: [
        systemReminderAttachmentEntry("context_prefix", "instructions"),
        systemReminderAttachmentEntry("skills_listing", "- a\n- b"),
      ],
      useMidConversationSystem: false,
    });
    const breakdown = classifyContextComposition({
      sections: [],
      messages: projection.messages,
      originEntries: projection.originEntries,
      sourceEntries: projection.sourceEntries,
      tools: [],
      skillItems: [
        { name: "a", chars: 10, tokens: 5 },
        { name: "b", chars: 10, tokens: 7 },
      ],
      instructionItems: [{ name: "/Users/dev/project/AGENTS.md", chars: 100, tokens: 30 }],
    });
    const skills = category(breakdown, "skills");
    expect(skills.items.map((item) => item.name)).toEqual(["a", "b"]);
    // 类别大小取公告真实文本（按消息口径），条目只作明细，不再累加一次。
    const listing = projection.messages[1]!;
    expect(skills.chars).toBe(
      JSON.stringify({ role: listing.role, content: listing.content }).length,
    );
    const instructions = category(breakdown, "meta_user_context");
    expect(instructions.items).toEqual([
      { name: "/Users/dev/project/AGENTS.md", chars: 100, tokens: 30 },
    ]);
  });

  it("projects every fine category to one of the seven ring sources", () => {
    const expected: Record<ContextCompositionCategoryId, string> = {
      system_prompt: "system_prompt",
      meta_user_context: "meta_user_context",
      skills: "skills",
      tool_prompt: "tool_prompt",
      system_tool_schemas: "system_tool_schemas",
      mcp_tool_schemas: "mcp_tool_schemas",
      app_tool_schemas: "system_tool_schemas",
      deferred_tool_schemas: "system_tool_schemas",
      reminders: "meta_user_context",
      compact_summary: "messages",
      messages: "messages",
    };
    const ringSources = new Set(zcodeContextUsageBreakdownSourceSchema.options);
    expect(ringSources.size).toBe(7);
    for (const id of CONTEXT_COMPOSITION_CATEGORY_IDS) {
      expect(contextCompositionUsageSource(id)).toBe(expected[id]);
      expect(ringSources.has(contextCompositionUsageSource(id))).toBe(true);
    }
    expect(contextCompositionUsageSource("deferred_tool_schemas", "mcp")).toBe("mcp_tool_schemas");

    const breakdown = classifyEntries(
      [
        ...baseEntries(),
        {
          message: { role: "user", content: "<summary>older</summary>" },
          metadata: { source: "legacy_synthetic", compactBoundary: { boundaryId: "b2" } },
        },
      ],
      true,
      [
        tool("Read"),
        tool("mcp__docs__search"),
        tool("app__page__click"),
        tool("mcp__docs__read", { deferLoading: true }),
        tool("NotebookEdit", { deferLoading: true }),
      ],
    );
    const projected = projectContextCompositionToUsageSources(breakdown);
    expect(projected.map((item) => item.source)).toEqual([
      "system_prompt",
      "meta_user_context",
      "skills",
      "tool_prompt",
      "system_tool_schemas",
      "mcp_tool_schemas",
      "messages",
    ]);
    // 投影守恒：粗类别 token 之和等于细类别之和。
    const fineTotal = breakdown.categories.reduce((sum, item) => sum + item.tokens, 0);
    expect(projected.reduce((sum, item) => sum + item.tokens, 0)).toBe(fineTotal);
    const sumOf = (...ids: ContextCompositionCategoryId[]) =>
      ids.reduce((sum, id) => sum + category(breakdown, id).tokens, 0);
    const deferred = category(breakdown, "deferred_tool_schemas").items;
    const deferredOf = (origin: string) =>
      deferred.filter((item) => item.toolOrigin === origin).reduce((s, i) => s + i.tokens, 0);
    expect(projected.find((item) => item.source === "meta_user_context")!.tokens).toBe(
      sumOf("meta_user_context", "reminders"),
    );
    expect(projected.find((item) => item.source === "messages")!.tokens).toBe(
      sumOf("messages", "compact_summary"),
    );
    expect(projected.find((item) => item.source === "system_tool_schemas")!.tokens).toBe(
      sumOf("system_tool_schemas", "app_tool_schemas") + deferredOf("system"),
    );
    expect(projected.find((item) => item.source === "mcp_tool_schemas")!.tokens).toBe(
      sumOf("mcp_tool_schemas") + deferredOf("mcp"),
    );
  });

  it("drops zero categories, keeps the top 50 items and truncates names to 200 chars", () => {
    const longName = `Tool_${"n".repeat(400)}`;
    const tools = Array.from({ length: CONTEXT_COMPOSITION_MAX_ITEMS + 10 }, (_, index) =>
      tool(index === 0 ? longName : `Tool${index}`, {
        description: "d".repeat(index * 10),
      }),
    );
    const categories = toContextCompositionCategories(classifyEntries([], false, tools));

    expect(categories.map((item) => item.id)).toEqual([
      "system_prompt",
      "tool_prompt",
      "system_tool_schemas",
    ]);
    const toolsCategory = categories.find((item) => item.id === "system_tool_schemas")!;
    expect(toolsCategory.items).toHaveLength(CONTEXT_COMPOSITION_MAX_ITEMS);
    const tokens = toolsCategory.items!.map((item) => item.tokens);
    expect(tokens).toEqual([...tokens].sort((left, right) => right - left));
    // 最大的 50 个工具都在，最小的 10 个被丢掉。
    expect(toolsCategory.items!.at(0)!.name).toBe(`Tool${CONTEXT_COMPOSITION_MAX_ITEMS + 9}`);
    expect(toolsCategory.items!.some((item) => item.name === "Tool1")).toBe(false);
    for (const item of categories)
      expect(() => contextCompositionCategorySchema.parse(item)).not.toThrow();

    const withLongName = toContextCompositionCategories({
      categories: [
        {
          id: "system_tool_schemas",
          chars: 10,
          tokens: 5,
          items: [{ name: longName, chars: 10, tokens: 5 }],
        },
      ],
    });
    expect(withLongName[0]!.items![0]!.name).toHaveLength(CONTEXT_COMPOSITION_MAX_ITEM_NAME_CHARS);
    expect(longName.startsWith(withLongName[0]!.items![0]!.name)).toBe(true);
  });
});
