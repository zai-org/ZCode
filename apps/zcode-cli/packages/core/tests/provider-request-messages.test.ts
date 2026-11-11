import { describe, expect, it } from "vitest";
import type { ModelInputMessage, RuntimeMessageEntry } from "../src/agent/message-history.js";
import {
  realUserRuntimeMetadata,
  systemReminderRuntimeMetadata,
} from "../src/agent/message-history.js";
import { buildProviderRequestMessages } from "../src/runtime/helpers/provider-request-messages.js";
import { buildRuntimeProviderRequestMessages } from "../src/runtime/helpers/runtime-provider-request-messages.js";
import { createTestRuntimeModel } from "./test-runtime-model.js";

function entry(
  message: ModelInputMessage,
  source?: RuntimeMessageEntry["metadata"]["source"],
): RuntimeMessageEntry {
  return {
    message,
    metadata: source ? { source } : undefined,
  };
}

function attachment(
  source: RuntimeMessageEntry["metadata"]["source"],
  content: string,
): RuntimeMessageEntry {
  return {
    kind: "attachment",
    content,
    metadata: { source },
  };
}

function user(content: ModelInputMessage["content"]): ModelInputMessage {
  return { role: "user", content };
}

function assistant(content = "assistant"): ModelInputMessage {
  return { role: "assistant", content };
}

function toolResultUser(content = "tool result"): ModelInputMessage {
  return {
    role: "user",
    content: [{ type: "text", text: content }],
    toolCallId: "tool-1",
    toolName: "Read",
  };
}

function toolResult(
  content = "tool result",
  toolCallId = "tool-1",
  toolName = "Read",
): ModelInputMessage {
  return {
    role: "tool",
    content,
    toolCallId,
    toolName,
  };
}

// 折叠只在 Anthropic Messages 协议打开，由模型请求能力决定。
const FOLD = { foldRemindersIntoToolResults: true } as const;

function providerText(message: ModelInputMessage): string {
  return typeof message.content === "string"
    ? message.content
    : message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}

describe("buildProviderRequestMessages", () => {
  it("keeps committed assistant entry ownership separate from provider messages", () => {
    const assistant = {
      message: { role: "assistant" as const, content: "answer" },
      tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 }, total: 120 },
    } satisfies RuntimeMessageEntry;
    const entries = [entry(user("prompt"), "real_user"), assistant] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({ entries });

    expect(result.messages).toEqual([
      { role: "user", content: "prompt" },
      { role: "assistant", content: "answer" },
    ]);
    expect(result.sourceEntries).toEqual([entries[0], assistant]);
  });

  it("keeps a query-only Continue provider-visible without moving the latest real user", () => {
    const entries = [
      entry(user("real prompt"), "real_user"),
      entry(assistant("partial")),
      {
        message: user("continue locally"),
        queryScope: "output_token_continuation",
      },
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({ entries });

    expect(result.messages).toEqual([
      user("real prompt"),
      assistant("partial"),
      user("continue locally"),
    ]);
    expect(result.diagnostics.latestRealUserMessageIndex).toBe(0);
  });

  it("projects structured system reminder attachments using raw body content", () => {
    const entries = [
      entry(user("real prompt"), "real_user"),
      attachment("output_style", "style body"),
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({ entries, applyCacheControl: true });

    expect(result.messages).toEqual([
      { role: "user", content: "real prompt", cacheControl: { type: "ephemeral" } },
      { role: "system", content: "style body" },
    ]);
  });

  it("projects structured prompt attachments as mid-conversation system messages", () => {
    const entries = [
      entry(user("Summarize notes."), "real_user"),
      attachment(
        "prompt_attachment",
        'Called the Read tool with the following input: {"file_path":"notes.md"}',
      ),
      attachment("prompt_attachment", "Result of calling the Read tool:\n1\t# Notes"),
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({ entries });

    expect(result.messages).toEqual([
      { role: "user", content: "Summarize notes." },
      {
        role: "system",
        content:
          'Called the Read tool with the following input: {"file_path":"notes.md"}\n\nResult of calling the Read tool:\n1\t# Notes',
      },
    ]);
  });

  it("projects MCS-capable attachments as system messages when MCS is explicitly enabled", () => {
    const entries = [
      entry(user("Summarize notes."), "real_user"),
      attachment("prompt_attachment", "Called the Read tool with the following input: {}"),
      attachment("output_style", "Terse output style is active."),
    ] satisfies RuntimeMessageEntry[];

    expect(
      buildProviderRequestMessages({
        entries,
        useMidConversationSystem: true,
      }).messages,
    ).toEqual([
      { role: "user", content: "Summarize notes." },
      {
        role: "system",
        content:
          "Called the Read tool with the following input: {}\n\nTerse output style is active.",
      },
    ]);
  });

  it("projects goal state changes as mid-conversation system messages when MCS is enabled", () => {
    const entries = [
      entry(user("Continue"), "real_user"),
      attachment(
        "goal_state_change",
        "The active session goal is paused. Do not continue pursuing it unless the user resumes or replaces the goal.",
      ),
    ] satisfies RuntimeMessageEntry[];

    expect(
      buildProviderRequestMessages({
        entries,
        useMidConversationSystem: true,
      }).messages,
    ).toEqual([
      { role: "user", content: "Continue" },
      {
        role: "system",
        content:
          "The active session goal is paused. Do not continue pursuing it unless the user resumes or replaces the goal.",
      },
    ]);
  });

  it("falls back goal state changes to user system reminders when MCS is disabled", () => {
    const entries = [
      entry(user("Continue"), "real_user"),
      attachment(
        "goal_state_change",
        "The session goal has been cleared. Do not continue pursuing any previous goal unless the user sets a new goal.",
      ),
    ] satisfies RuntimeMessageEntry[];

    expect(
      buildProviderRequestMessages({
        entries,
        useMidConversationSystem: false,
      }).messages,
    ).toEqual([
      { role: "user", content: "Continue" },
      {
        role: "user",
        content:
          "<system-reminder>\nThe session goal has been cleared. Do not continue pursuing any previous goal unless the user sets a new goal.\n</system-reminder>",
      },
    ]);
  });

  it("does not bubble a goal state change before an older target continuation", () => {
    const pauseReminder =
      "The active session goal is paused. Do not continue pursuing it unless the user resumes or replaces the goal.";
    const entries = [
      entry(user("Original goal"), "real_user"),
      entry(user("Continue working toward the active session goal."), "target_continuation"),
      attachment("goal_state_change", pauseReminder),
      entry(user("Follow-up after Stop"), "real_user"),
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({
      entries,
      useMidConversationSystem: false,
    });

    expect(result.messages).toEqual([
      { role: "user", content: "Original goal" },
      { role: "user", content: "Continue working toward the active session goal." },
      {
        role: "user",
        content: `<system-reminder>\n${pauseReminder}\n</system-reminder>`,
      },
      { role: "user", content: "Follow-up after Stop" },
    ]);
    expect(result.diagnostics.bubbledAttachmentEntryCount).toBe(0);
  });

  it("renders MCS-capable attachments as legacy user system reminders when MCS is disabled", () => {
    const entries = [
      entry(user("Summarize notes."), "real_user"),
      attachment("prompt_attachment", "Called the Read tool with the following input: {}"),
    ] satisfies RuntimeMessageEntry[];

    expect(
      buildProviderRequestMessages({
        entries,
        useMidConversationSystem: false,
      }).messages,
    ).toEqual([
      {
        role: "user",
        content:
          "<system-reminder>\nCalled the Read tool with the following input: {}\n</system-reminder>",
      },
      { role: "user", content: "Summarize notes." },
    ]);
  });

  it("applies attachment bubble ordering before MCS projection", () => {
    const entries = [
      entry(user("Real query"), "real_user"),
      attachment("output_style", "Style body"),
      entry(assistant("Answer")),
    ] satisfies RuntimeMessageEntry[];

    const legacy = buildProviderRequestMessages({
      entries,
      useMidConversationSystem: false,
    }).messages;
    expect(legacy.map((message) => message.role)).toEqual(["user", "user", "assistant"]);
    expect(String(legacy[0]?.content)).toContain("Style body");
    expect(legacy[1]?.content).toBe("Real query");

    const mcs = buildProviderRequestMessages({
      entries,
      useMidConversationSystem: true,
    });
    expect(mcs.messages.map((message) => message.role)).toEqual(["user", "system", "assistant"]);
    expect(mcs.messages[0]?.content).toBe("Real query");
    expect(mcs.messages[1]?.content).toBe("Style body");
    expect(mcs.diagnostics.bubbledAttachmentEntryCount).toBe(1);
  });

  it("keeps target verifier prompts as plain user messages while projecting history attachments", () => {
    const entries = [
      entry(user("original goal turn"), "real_user"),
      attachment("output_style", "Use verifier style."),
      entry(user("Verify whether the active goal is complete.")),
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({ entries, applyCacheControl: true });

    expect(result.messages).toEqual([
      { role: "user", content: "original goal turn" },
      {
        role: "user",
        content: "Verify whether the active goal is complete.",
        cacheControl: { type: "ephemeral" },
      },
      {
        role: "system",
        content: "Use verifier style.",
      },
    ]);
  });

  it("does not project legacy message entries just because their source is eligible", () => {
    const entries = [
      entry(user("real prompt"), "real_user"),
      entry(user("style body"), "output_style"),
      entry(user("<system-reminder>\ntodo\n</system-reminder>"), "todo_reminder"),
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({ entries });

    expect(result.messages).toEqual([
      { role: "user", content: "real prompt" },
      { role: "user", content: "style body" },
      { role: "user", content: "<system-reminder>\ntodo\n</system-reminder>" },
    ]);
  });

  it("moves skills listing after the first real user as a system message", () => {
    const entries = [
      entry({ role: "system", content: "prefix" }),
      attachment("skills_listing", "skills"),
      attachment("context_prefix", "# currentDate\nToday"),
      entry(user("real prompt"), "real_user"),
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({ entries, applyCacheControl: true });

    expect(result.messages).toEqual([
      { role: "system", content: "prefix" },
      {
        role: "user",
        content: "<system-reminder>\n# currentDate\nToday\n</system-reminder>",
      },
      {
        role: "user",
        content: "real prompt",
        cacheControl: { type: "ephemeral" },
      },
      { role: "system", content: "skills" },
    ]);
    expect(result.diagnostics.cacheControlIndex).toBe(2);
    expect(result.diagnostics.latestRealUserMessageIndex).toBe(2);
  });

  it("ends the user text right before a real user input with a newline", () => {
    const entries = [
      attachment("context_prefix", "instructions"),
      attachment("session_context", "git"),
      entry(user("real prompt"), "real_user"),
      entry(assistant("answer")),
      entry(toolResultUser("tool output")),
      entry(user("next prompt"), "real_user"),
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({
      entries,
      useMidConversationSystem: false,
      ...FOLD,
    });

    expect(result.messages.map((message) => message.content)).toEqual([
      "<system-reminder>\ninstructions\n</system-reminder>",
      "<system-reminder>\ngit\n</system-reminder>\n",
      "real prompt",
      "answer",
      [{ type: "text", text: "tool output" }],
      "next prompt",
    ]);
  });

  it("ends the user text right before a compact summary with a newline", () => {
    const summary: RuntimeMessageEntry = {
      message: user("This session is being continued from a previous conversation."),
      metadata: { source: "legacy_synthetic", compactBoundary: { boundaryId: "b1" } },
    };
    const entries = [
      attachment("context_prefix", "instructions"),
      attachment("session_context", "git"),
      summary,
      entry(assistant("kept answer")),
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({
      entries,
      useMidConversationSystem: false,
      ...FOLD,
    });

    // summary 与真实输入一样，前一条 user 文本以换行结尾。
    expect(result.messages[1]?.content).toBe("<system-reminder>\ngit\n</system-reminder>\n");
    expect(result.messages[2]?.content).toBe(
      "This session is being continued from a previous conversation.",
    );
  });

  it("adds no newline when the protocol does not merge adjacent user content", () => {
    const summary: RuntimeMessageEntry = {
      message: user("This session is being continued from a previous conversation."),
      metadata: { source: "legacy_synthetic", compactBoundary: { boundaryId: "b1" } },
    };
    const entries = [
      attachment("session_context", "git"),
      summary,
      entry(user("turn two"), "real_user"),
      entry(user("[Request interrupted by user]"), "interrupt_marker"),
      entry(user("next prompt"), "real_user"),
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({ entries, useMidConversationSystem: false });

    // OpenAI 兼容协议不合并 user：上一次请求的最后一块（例如 "turn two"）保持原字节。
    expect(result.messages.map((message) => message.content)).toEqual([
      "<system-reminder>\ngit\n</system-reminder>",
      "This session is being continued from a previous conversation.",
      "turn two",
      "[Request interrupted by user]",
      "next prompt",
    ]);
  });

  it.each([true, false])(
    "keeps the interrupt marker as plain user text that attachments pass (MCS=%s)",
    (useMidConversationSystem) => {
      const entries = [
        entry(user("first prompt"), "real_user"),
        entry(assistant("partial")),
        entry(user("[Request interrupted by user]"), "interrupt_marker"),
        attachment("runtime_mode", "mode"),
        entry(user("next prompt"), "real_user"),
      ] satisfies RuntimeMessageEntry[];

      const result = buildProviderRequestMessages({ entries, useMidConversationSystem, ...FOLD });
      const texts = result.messages.map((message) => [message.role, providerText(message)]);

      // 标记不冒泡、不进 system；后面的输入前以换行结尾。
      expect(texts).toContainEqual(["user", "[Request interrupted by user]\n"]);
      const markerIndex = texts.findIndex(([, text]) => text.startsWith("[Request interrupted"));
      expect(texts[markerIndex - 1]?.[0]).toBe(useMidConversationSystem ? "assistant" : "user");
      expect(texts.at(-1)).toEqual(
        useMidConversationSystem
          ? ["system", expect.stringContaining("mode")]
          : ["user", "next prompt"],
      );
    },
  );

  it("projects non-context meta reminders to system without moving context prefix", () => {
    const entries = [
      entry(user("follow up"), "real_user"),
      attachment("runtime_mode", "mode"),
      attachment("todo_reminder", "todo"),
      attachment("output_style", "style"),
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({ entries, applyCacheControl: true });

    expect(result.messages).toEqual([
      { role: "user", content: "follow up", cacheControl: { type: "ephemeral" } },
      { role: "system", content: "mode\n\ntodo\n\nstyle" },
    ]);
    expect(result.diagnostics.bubbledAttachmentEntryCount).toBe(3);
    expect(result.diagnostics.cacheControlIndex).toBe(0);
    expect(result.diagnostics.latestRealUserMessageIndex).toBe(0);
  });

  it("keeps the same real user anchor open for prefix and current-turn system projections", () => {
    const entries = [
      attachment("skills_listing", "skills"),
      entry(user("real prompt"), "real_user"),
      attachment("output_style", "style"),
      entry(assistant("assistant response")),
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({ entries });

    expect(result.messages).toEqual([
      { role: "user", content: "real prompt" },
      { role: "system", content: "skills\n\nstyle" },
      { role: "assistant", content: "assistant response" },
    ]);
  });

  it("projects current-turn attachment reminders to system without crossing assistant boundaries", () => {
    const entries = [
      entry(assistant("previous response")),
      entry(user("follow-up prompt"), "real_user"),
      attachment("relevant_memory", "memory reminder"),
      attachment("runtime_mode", "runtime mode reminder"),
      entry(assistant("next response")),
      entry(user("later prompt"), "real_user"),
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({ entries });

    expect(result.messages).toEqual([
      { role: "assistant", content: "previous response" },
      { role: "user", content: "follow-up prompt" },
      { role: "system", content: "memory reminder\n\nruntime mode reminder" },
      { role: "assistant", content: "next response" },
      { role: "user", content: "later prompt" },
    ]);
    expect(result.diagnostics.bubbledAttachmentEntryCount).toBe(2);
  });

  it("places cache-control on the latest non-system message after projection", () => {
    const entries = [
      entry(user("inspect the repo"), "real_user"),
      entry(assistant("used Read")),
      entry(toolResult("read result")),
      entry(user("output style reminder"), "output_style"),
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({ entries, applyCacheControl: true });

    expect(result.messages).toEqual([
      { role: "user", content: "inspect the repo" },
      { role: "assistant", content: "used Read" },
      {
        role: "tool",
        content: "read result",
        toolCallId: "tool-1",
        toolName: "Read",
      },
      {
        role: "user",
        content: "output style reminder",
        cacheControl: { type: "ephemeral" },
      },
    ]);
    expect(result.diagnostics.cacheControlIndex).toBe(3);
    expect(result.diagnostics.latestRealUserMessageIndex).toBe(0);
  });

  it("keeps plugin reference after the user while placing cache-control on that user", () => {
    const entries = [
      entry(user("use the plugin"), "real_user"),
      attachment("plugin_reference", "<plugin_reference>demo</plugin_reference>"),
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({ entries, applyCacheControl: true });

    expect(result.messages).toEqual([
      {
        role: "user",
        content: "use the plugin",
        cacheControl: { type: "ephemeral" },
      },
      {
        role: "system",
        content: "<plugin_reference>demo</plugin_reference>",
      },
    ]);
    expect(result.diagnostics.cacheControlIndex).toBe(0);
    expect(result.diagnostics.latestRealUserMessageIndex).toBe(0);
  });

  it("moves cache-control before the latest message when cache write is skipped", () => {
    const entries = [
      entry(user("inspect the repo"), "real_user"),
      entry(assistant("summarizable response")),
      entry(user("compact prompt")),
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({
      entries,
      applyCacheControl: true,
      skipCacheWrite: true,
    });

    expect(result.messages).toEqual([
      { role: "user", content: "inspect the repo" },
      {
        role: "assistant",
        content: "summarizable response",
        cacheControl: { type: "ephemeral" },
      },
      { role: "user", content: "compact prompt" },
    ]);
    expect(result.diagnostics.cacheControlIndex).toBe(1);
  });

  it("places cache-control on a tool message when it is the latest non-system message", () => {
    const entries = [
      entry(user("inspect the repo"), "real_user"),
      entry(assistant("used Read")),
      entry(toolResult("read result")),
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({ entries, applyCacheControl: true });

    expect(result.messages).toEqual([
      { role: "user", content: "inspect the repo" },
      { role: "assistant", content: "used Read" },
      {
        role: "tool",
        content: "read result",
        toolCallId: "tool-1",
        toolName: "Read",
        cacheControl: { type: "ephemeral" },
      },
    ]);
    expect(result.diagnostics.cacheControlIndex).toBe(2);
  });

  it("projects a todo reminder after a tool result as mid-conversation system", () => {
    const entries = [
      entry(user("inspect the repo"), "real_user"),
      entry(assistant("used Read")),
      entry(toolResult("read result")),
      attachment("todo_reminder", "todo body"),
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({ entries, applyCacheControl: true });

    expect(result.messages).toEqual([
      { role: "user", content: "inspect the repo" },
      { role: "assistant", content: "used Read" },
      {
        role: "tool",
        content: "read result",
        toolCallId: "tool-1",
        toolName: "Read",
        cacheControl: { type: "ephemeral" },
      },
      { role: "system", content: "todo body" },
    ]);
    expect(result.diagnostics.cacheControlIndex).toBe(2);
  });

  it("delays a pending mid-conversation system reminder until sibling tool results complete", () => {
    const entries = [
      entry(user("inspect the repo"), "real_user"),
      entry(assistant("issued parallel tools")),
      entry(toolResult("read result", "tool-1", "Read")),
      attachment("todo_reminder", "todo body"),
      entry(toolResult("grep result", "tool-2", "Grep")),
      entry(toolResult("glob result", "tool-3", "Glob")),
      entry(assistant("next answer")),
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({ entries });

    expect(result.messages).toEqual([
      { role: "user", content: "inspect the repo" },
      { role: "assistant", content: "issued parallel tools" },
      {
        role: "tool",
        content: "read result",
        toolCallId: "tool-1",
        toolName: "Read",
      },
      {
        role: "tool",
        content: "grep result",
        toolCallId: "tool-2",
        toolName: "Grep",
      },
      {
        role: "tool",
        content: "glob result",
        toolCallId: "tool-3",
        toolName: "Glob",
      },
      { role: "system", content: "todo body" },
      { role: "assistant", content: "next answer" },
    ]);
  });

  it("keeps legacy reminder text after sibling tool results when MCS is disabled", () => {
    const entries = [
      entry(user("inspect the repo"), "real_user"),
      entry(assistant("issued parallel tools")),
      entry(toolResult("read result", "tool-1", "Read")),
      attachment("todo_reminder", "todo body"),
      entry(toolResult("grep result", "tool-2", "Grep")),
      entry(toolResult("glob result", "tool-3", "Glob")),
      entry(assistant("next answer")),
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({
      entries,
      useMidConversationSystem: false,
    });

    expect(result.messages).toEqual([
      { role: "user", content: "inspect the repo" },
      { role: "assistant", content: "issued parallel tools" },
      {
        role: "tool",
        content: "read result",
        toolCallId: "tool-1",
        toolName: "Read",
      },
      {
        role: "tool",
        content: "grep result",
        toolCallId: "tool-2",
        toolName: "Grep",
      },
      {
        role: "tool",
        content: "glob result",
        toolCallId: "tool-3",
        toolName: "Glob",
      },
      {
        role: "user",
        content: "<system-reminder>\ntodo body\n</system-reminder>",
      },
      { role: "assistant", content: "next answer" },
    ]);
  });

  it("trims a string tool result and its reminders when folding them", () => {
    const entries = [
      entry(assistant("used Bash")),
      entry(toolResult("bash output\n", "tool-1", "Bash")),
      attachment("todo_reminder", "todo body"),
      entry(user("  <system-reminder>\nmemory\n</system-reminder>\n"), "relevant_memory"),
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({
      entries,
      useMidConversationSystem: false,
      ...FOLD,
    });

    expect(result.messages).toEqual([
      { role: "assistant", content: "used Bash" },
      {
        role: "tool",
        content:
          "bash output\n\n<system-reminder>\ntodo body\n</system-reminder>\n\n<system-reminder>\nmemory\n</system-reminder>",
        toolCallId: "tool-1",
        toolName: "Bash",
      },
    ]);
  });

  it("appends reminder text blocks to an array tool result without trimming", () => {
    const image = {
      type: "image" as const,
      mediaType: "image/png",
      dataUrl: "data:image/png;base64,abc",
    };
    const entries = [
      entry(assistant("read two files")),
      entry({
        role: "tool",
        content: [{ type: "text", text: "page" }],
        toolCallId: "tool-1",
        toolName: "Read",
      }),
      entry({ role: "tool", content: [image], toolCallId: "tool-2", toolName: "Read" }),
      attachment("todo_reminder", "todo body"),
      attachment("output_style", "style body"),
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({
      entries,
      useMidConversationSystem: false,
      ...FOLD,
    });

    expect(result.messages.slice(1)).toEqual([
      {
        role: "tool",
        content: [{ type: "text", text: "page" }],
        toolCallId: "tool-1",
        toolName: "Read",
      },
      {
        role: "tool",
        content: [
          image,
          { type: "text", text: "<system-reminder>\ntodo body\n</system-reminder>\n" },
          { type: "text", text: "<system-reminder>\nstyle body\n</system-reminder>" },
        ],
        toolCallId: "tool-2",
        toolName: "Read",
      },
    ]);
  });

  it("does not fold reminders into a tool result that holds tool references", () => {
    const entries = [
      entry(assistant("searched tools")),
      entry({
        role: "tool",
        content: [{ type: "tool_reference", toolName: "Write" }],
        toolCallId: "tool-1",
        toolName: "ToolSearch",
      }),
      attachment("todo_reminder", "todo body"),
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({
      entries,
      useMidConversationSystem: false,
      ...FOLD,
    });

    expect(result.messages.slice(1)).toEqual([
      {
        role: "tool",
        content: [{ type: "tool_reference", toolName: "Write" }],
        toolCallId: "tool-1",
        toolName: "ToolSearch",
      },
      { role: "user", content: "<system-reminder>\ntodo body\n</system-reminder>" },
    ]);
  });

  it("folds mid-turn inputs with the other reminders but never folds user inputs", () => {
    const steer: RuntimeMessageEntry = {
      message: user("check the tests too"),
      metadata: { source: "real_user", inputPresentation: "user_steer" },
    };
    const entries = [
      entry(user("inspect"), "real_user"),
      entry(assistant("used Read")),
      entry(toolResult("read result")),
      attachment("todo_reminder", "todo body"),
      steer,
      attachment("output_style", "style body"),
      entry(assistant("used Grep")),
      entry(toolResult("grep result", "tool-2", "Grep")),
      entry(user("next prompt"), "real_user"),
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({
      entries,
      useMidConversationSystem: false,
      ...FOLD,
    });

    const folded = providerText(result.messages[2]!);
    expect(
      folded.startsWith("read result\n\n<system-reminder>\ntodo body\n</system-reminder>\n\n"),
    ).toBe(true);
    expect(folded).toContain("check the tests too");
    expect(folded.endsWith("\n\n<system-reminder>\nstyle body\n</system-reminder>")).toBe(true);
    expect(result.messages.slice(3)).toEqual([
      { role: "assistant", content: "used Grep" },
      { role: "tool", content: "grep result", toolCallId: "tool-2", toolName: "Grep" },
      { role: "user", content: "next prompt" },
    ]);
    expect(result.diagnostics.latestRealUserMessageIndex).toBe(5);
    expect(result.sourceEntries[2]).toBe(entries[2]);
    expect(result.sourceEntries[5]).toBe(entries[8]);
  });

  describe("native ToolSearch Tool loaded notice", () => {
    const searchBatch = [
      entry(assistant("searched tools")),
      entry({
        role: "tool",
        content: [{ type: "tool_reference", toolName: "Write" }],
        toolCallId: "search-1",
        toolName: "ToolSearch",
      }),
      entry(toolResult("out", "bash-1", "Bash")),
    ] satisfies RuntimeMessageEntry[];
    const loaded = { loadedToolCallIds: new Set(["search-1"]) };

    it("keeps reminders after Tool loaded instead of folding them into the batch", () => {
      const result = buildProviderRequestMessages({
        entries: [...searchBatch, attachment("session_context", "ctx")],
        ...loaded,
        ...FOLD,
      });

      // Tool loaded. 在并入之前插入：提醒跟在它后面，Bash 结果保持原样。
      expect(result.messages.slice(1)).toEqual([
        {
          role: "tool",
          content: [{ type: "tool_reference", toolName: "Write" }],
          toolCallId: "search-1",
          toolName: "ToolSearch",
        },
        toolResult("out", "bash-1", "Bash"),
        { role: "user", content: "Tool loaded." },
        { role: "user", content: "<system-reminder>\nctx\n</system-reminder>" },
      ]);
    });

    it("ends Tool loaded with a newline before a following user input", () => {
      const prompt = entry(user("check the tests too"), "real_user");
      const result = buildProviderRequestMessages({
        entries: [...searchBatch, prompt],
        ...loaded,
        ...FOLD,
      });

      expect(result.messages[3]).toEqual({ role: "user", content: "Tool loaded.\n" });
      expect(providerText(result.messages[4]!)).toContain("check the tests too");
    });
  });

  describe("MCS human steer in the run's system message", () => {
    const steer = (content: ModelInputMessage["content"]): RuntimeMessageEntry => ({
      message: user(content),
      metadata: { source: "real_user", inputPresentation: "user_steer" },
    });
    const steerText = (body: string) =>
      `The user sent a new message while you were working:\n${body}\n\nThis is how ZCode surfaces messages the user sends mid-turn — within the running turn, often alongside the next tool result, rather than as a separate conversation turn. Address the message above as you continue this turn.`;

    // guide 是轮内中途消息：MCS 下与其他中途消息一样并入 run 的 system，不带外层标签。
    it("puts a text steer into the run system message, user-side reminders still fold", () => {
      const entries = [
        entry(assistant("used Read")),
        entry(toolResult("read result")),
        steer("check the tests too"),
        attachment("session_context", "git"),
        attachment("todo_reminder", "todo body"),
      ] satisfies RuntimeMessageEntry[];

      const result = buildProviderRequestMessages({ entries, ...FOLD });

      expect(result.messages).toEqual([
        assistant("used Read"),
        toolResult("read result\n\n<system-reminder>\ngit\n</system-reminder>"),
        { role: "system", content: `${steerText("check the tests too")}\n\ntodo body` },
      ]);
    });

    it("keeps several steers in order in one system message before the next assistant", () => {
      const entries = [
        entry(assistant("used Read")),
        entry(toolResult("read result")),
        steer("first"),
        attachment("session_context", "git"),
        steer("second"),
        entry(assistant("next")),
      ] satisfies RuntimeMessageEntry[];

      const result = buildProviderRequestMessages({ entries, ...FOLD });

      expect(result.messages).toEqual([
        assistant("used Read"),
        toolResult("read result\n\n<system-reminder>\ngit\n</system-reminder>"),
        { role: "system", content: `${steerText("first")}\n\n${steerText("second")}` },
        assistant("next"),
      ]);
    });

    // text-only 回复之后没有 user/tool 锚点，system 放不下，整组降级为一条 user reminder。
    it("degrades a steer after a text-only reply to one wrapped user reminder", () => {
      const entries = [
        entry(user("first"), "real_user"),
        entry(assistant("answer")),
        steer("follow up"),
      ] satisfies RuntimeMessageEntry[];

      const result = buildProviderRequestMessages({ entries, ...FOLD });

      expect(result.messages).toEqual([
        user("first"),
        assistant("answer"),
        user(`<system-reminder>\n${steerText("follow up")}\n</system-reminder>`),
      ]);
    });

    // 带图 guide 放不进 system：MCS 开关下都留在 user 侧，文本包装一次放首块，不并入 tool result。
    it.each([true, false])("keeps a steer with media on the user side (MCS=%s)", (mcs) => {
      const image = {
        type: "image" as const,
        mediaType: "image/png",
        dataUrl: "data:image/png;base64,abc",
      };
      const entries = [
        entry(assistant("used Read")),
        entry(toolResult("read result")),
        steer([{ type: "text", text: "look at this" }, image]),
      ] satisfies RuntimeMessageEntry[];

      const result = buildProviderRequestMessages({
        entries,
        useMidConversationSystem: mcs,
        ...FOLD,
      });

      expect(result.messages).toEqual([
        assistant("used Read"),
        toolResult("read result"),
        user([
          {
            type: "text",
            text: `<system-reminder>\n${steerText("look at this")}\n</system-reminder>`,
          },
          image,
        ]),
      ]);
    });
  });

  describe("send-now before the preempted prompt has any output", () => {
    // 历史：B 还没有任何输出就被 send-now 抢占（不写中断标记），C 开新一轮。
    // 现在 C 是普通用户消息；旧版本把 C 存成 user_steer，已存会话照旧投影。
    const entriesWith = (c: RuntimeMessageEntry) =>
      [
        entry(user("first"), "real_user"),
        entry(assistant("answer A")),
        entry(user("prompt B"), "real_user"),
        attachment("output_style", "style for B"),
        c,
        attachment("todo_reminder", "todo after C"),
      ] satisfies RuntimeMessageEntry[];
    const plainC = entry(user("message C"), "real_user");
    const storedSteerC: RuntimeMessageEntry = {
      message: user("message C"),
      metadata: { source: "real_user", inputPresentation: "user_steer" },
    };

    const order = (messages: ModelInputMessage[], ...needles: string[]): number[] =>
      needles.map((needle) =>
        messages.findIndex((message) => providerText(message).includes(needle)),
      );

    // 人类输入按时间顺序：被抢占的 B 在前，新消息 C 在后。
    // MCS 关：公告照常越过普通 user；普通 C 之后的提醒越过 C 和 B，旧 user_steer C 之后的提醒留在 C 之后。
    // MCS 开：run 内的 MCS 文本合成一条 system，放在 run 末尾（C 之后）。
    it.each([
      ["plain C, MCS off", plainC, false, ["style for B", "todo after C", "prompt B", "message C"]],
      ["plain C, MCS on", plainC, true, ["prompt B", "message C", "style for B"]],
      [
        "stored user_steer C, MCS off",
        storedSteerC,
        false,
        ["style for B", "prompt B", "message C", "todo after C"],
      ],
    ])("keeps the new message after the preempted prompt (%s)", (_label, c, mcs, expected) => {
      const result = buildProviderRequestMessages({
        entries: entriesWith(c),
        useMidConversationSystem: mcs,
      });
      const indices = order(result.messages, ...expected);

      expect(indices[0]).toBeGreaterThan(1);
      expect(indices).toEqual([...new Set(indices)].sort((a, b) => a - b));
    });

    // MCS 开时旧 user_steer C 是中途消息，和 run 内的提醒按生成顺序合成 B 之后的一条 system。
    it("keeps a stored user_steer C after the preempted prompt in the run system (MCS on)", () => {
      const result = buildProviderRequestMessages({
        entries: entriesWith(storedSteerC),
        useMidConversationSystem: true,
      });

      expect(result.messages.slice(2).map((message) => message.role)).toEqual(["user", "system"]);
      expect(providerText(result.messages[2]!)).toBe("prompt B");
      const system = providerText(result.messages[3]!);
      expect(order([user(system)], "style for B", "message C", "todo after C")).toEqual([0, 0, 0]);
      expect(system.indexOf("style for B")).toBeLessThan(system.indexOf("message C"));
      expect(system.indexOf("message C")).toBeLessThan(system.indexOf("todo after C"));
    });
  });

  // 被打断时只产出了思考（send now、停止、思考后流失败）或只有空白文字的回复。Anthropic 协议的请求不带它，
  // 删除是投影的第一步：system 按「后面是 assistant」落在它前面，它再被删掉，system 就直接接 user，
  // provider 返回 400，之后整个会话的请求都失败。
  describe("assistant replies the protocol drops", () => {
    const DROP = { dropReasoningOnlyOrBlankAssistants: true } as const;
    const reasoningOnly: ModelInputMessage = {
      role: "assistant",
      content: [{ type: "reasoning", text: "thinking B" }],
    };
    const preempted = (reply: ModelInputMessage, ...rest: RuntimeMessageEntry[]) =>
      [
        entry(user("first"), "real_user"),
        entry(assistant("answer A")),
        entry(user("prompt B"), "real_user"),
        attachment("environment", "env for B"),
        entry(reply),
        entry(user("message C"), "real_user"),
        ...rest,
      ] satisfies RuntimeMessageEntry[];
    const roles = (messages: ModelInputMessage[]) => messages.map((message) => message.role);

    it.each([
      ["reasoning-only", reasoningOnly],
      ["blank", { role: "assistant", content: [{ type: "text", text: "\n\n" }] }],
      ["placeholder", { role: "assistant", content: [{ type: "text", text: "(no content)" }] }],
      [
        "reasoning and blank",
        {
          role: "assistant",
          content: [
            { type: "text", text: "\n\n" },
            { type: "reasoning", text: "thinking B" },
          ],
        },
      ],
    ] satisfies [string, ModelInputMessage][])(
      "puts the run's system after the new input when a %s reply is dropped",
      (_label, reply) => {
        const result = buildProviderRequestMessages({
          entries: preempted(reply),
          useMidConversationSystem: true,
          ...FOLD,
          ...DROP,
        });

        expect(roles(result.messages)).toEqual(["user", "assistant", "user", "user", "system"]);
        expect(providerText(result.messages[2]!)).toBe("prompt B\n");
        expect(providerText(result.messages[3]!)).toBe("message C");
        expect(providerText(result.messages[4]!)).toContain("env for B");
      },
    );

    // MCS 关：被删的回复不再是冒泡停止点，C 之后的提醒越过 C 和 B，落在 A 之后。
    it("bubbles the new turn's reminders past the earlier prompt when MCS is off", () => {
      const result = buildProviderRequestMessages({
        entries: preempted(reasoningOnly, attachment("output_style", "style after C")),
        useMidConversationSystem: false,
        ...FOLD,
        ...DROP,
      });
      const texts = result.messages.map(providerText);
      const indexOf = (needle: string) => texts.findIndex((text) => text.includes(needle));

      expect(roles(result.messages).filter((role) => role === "assistant")).toHaveLength(1);
      expect(JSON.stringify(result.messages)).not.toContain("thinking B");
      expect(indexOf("answer A")).toBeLessThan(indexOf("style after C"));
      expect(indexOf("style after C")).toBeLessThan(indexOf("prompt B"));
      expect(texts[indexOf("prompt B")]).toBe("prompt B\n");
      expect(texts.at(-1)).toBe("message C");
    });

    // 思考用完输出上限：回复只有思考，runtime 追加 Continue 提示；回复删除后提示直接接在 B 后面。
    it("separates the earlier prompt from a Continue prompt after the reply is dropped", () => {
      const result = buildProviderRequestMessages({
        entries: [
          ...preempted(reasoningOnly).slice(0, 4),
          entry(reasoningOnly),
          { message: user("Output token limit hit."), queryScope: "output_token_continuation" },
        ],
        useMidConversationSystem: false,
        ...FOLD,
        ...DROP,
      });

      expect(result.messages.slice(-2).map(providerText)).toEqual([
        "prompt B\n",
        "Output token limit hit.",
      ]);
    });

    // 续写提示不写入历史，下一轮两段回复相邻。按条目判断：只删只有思考的第一段。
    // 产出第二段的请求里第一段已被删除，整段保留会把第一段的思考放回第二段前面。
    it("drops only the reasoning-only entry of two adjacent assistant entries", () => {
      const result = buildProviderRequestMessages({
        entries: [
          ...preempted(reasoningOnly).slice(0, 4),
          entry(reasoningOnly),
          entry({
            role: "assistant",
            content: [
              { type: "reasoning", text: "thinking C" },
              { type: "text", text: "answer C" },
            ],
          }),
          entry(user("message D"), "real_user"),
        ],
        useMidConversationSystem: false,
        ...FOLD,
        ...DROP,
      });
      const assistants = result.messages.filter((message) => message.role === "assistant");

      expect(assistants).toHaveLength(2);
      expect(JSON.stringify(assistants[1])).toContain("thinking C");
      expect(JSON.stringify(result.messages)).not.toContain("thinking B");
    });

    // send now 最常见的形态：工具结果之后、模型还在思考时打断。被删回复前面是 tool result，
    // 提醒按 MCS 落点或并入 tool result，都不能让 system 直接接 user。
    it.each([true, false])(
      "keeps a valid request when a reply after a tool result is dropped (MCS %s)",
      (useMidConversationSystem) => {
        const result = buildProviderRequestMessages({
          entries: [
            entry(user("inspect"), "real_user"),
            entry({
              role: "assistant",
              content: "used Read",
              toolCalls: [{ id: "tool-1", name: "Read", input: {} }],
            }),
            entry(toolResult("read result")),
            attachment("environment", "env after tool"),
            entry(reasoningOnly),
            entry(user("message C"), "real_user"),
          ],
          useMidConversationSystem,
          ...FOLD,
          ...DROP,
        });
        const messages = result.messages;

        messages.forEach((message, index) => {
          if (message.role === "system")
            expect(messages[index + 1]?.role ?? "assistant").toBe("assistant");
        });
        expect(JSON.stringify(messages)).not.toContain("thinking B");
        expect(messages.some((message) => message.role === "tool")).toBe(true);
        expect(JSON.stringify(messages)).toContain("env after tool");
        expect(messages.map(providerText).join("")).toContain("message C");
      },
    );

    it.each([
      [
        "a tool call",
        {
          role: "assistant",
          content: [{ type: "reasoning", text: "thinking B" }],
          toolCalls: [{ id: "call-1", name: "Read", input: {} }],
        },
      ],
      ["visible text", { role: "assistant", content: [{ type: "text", text: "partial" }] }],
      ["legacy string content", { role: "assistant", content: " " }],
      // 留作估算锚点的空回复存成空字符串（上一条）；空数组的 every 恒为真，要单独排除。
      ["empty content", { role: "assistant", content: [] }],
    ] satisfies [string, ModelInputMessage][])("keeps a reply with %s", (_label, reply) => {
      const result = buildProviderRequestMessages({
        entries: preempted(reply),
        useMidConversationSystem: false,
        ...DROP,
      });

      expect(roles(result.messages).filter((role) => role === "assistant")).toHaveLength(2);
    });

    it.each([true, false])("reads the drop switch from the model capability (%s)", (drop) => {
      const model = {
        ...createTestRuntimeModel({
          generateText: async () => ({ text: "" }) as never,
          propertyOverrides: { supportsMidConversationSystem: true },
        }),
        requestCapabilities: { dropReasoningOnlyOrBlankAssistants: drop },
      };
      const result = buildRuntimeProviderRequestMessages(
        { config: {} },
        { model, entries: preempted(reasoningOnly) },
      );

      expect(roles(result.messages)).toEqual(
        drop
          ? ["user", "assistant", "user", "user", "system"]
          : ["user", "assistant", "user", "system", "assistant", "user"],
      );
    });
  });

  it("does not keep a folded steer as the latest real user for the media budget", () => {
    const entries = [
      entry(user("inspect"), "real_user"),
      entry(assistant("used Read")),
      entry(toolResult("read result")),
      {
        message: user("check the tests too"),
        metadata: { source: "real_user", inputPresentation: "user_steer" },
      },
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({
      entries,
      useMidConversationSystem: false,
      ...FOLD,
    });

    expect(result.messages).toHaveLength(3);
    expect(result.diagnostics.latestRealUserMessageIndex).toBe(-1);
  });

  it.each([true, false])("reads the fold switch from the model capability (%s)", (fold) => {
    const model = {
      ...createTestRuntimeModel({
        generateText: async () => ({ text: "" }) as never,
        propertyOverrides: { supportsMidConversationSystem: false },
      }),
      requestCapabilities: { foldRemindersIntoToolResults: fold },
    };
    const result = buildRuntimeProviderRequestMessages(
      { config: {} },
      {
        model,
        entries: [
          entry(assistant("used Read")),
          entry(toolResult("read result")),
          attachment("todo_reminder", "todo body"),
        ],
      },
    );

    expect(result.messages.map((message) => message.role)).toEqual(
      fold ? ["assistant", "tool"] : ["assistant", "tool", "user"],
    );
  });

  it("keeps a todo reminder anchored after its tool result when later tool exchanges are appended", () => {
    const entries = [
      entry(user("inspect the repo"), "real_user"),
      entry(assistant("used Read")),
      entry(toolResult("read result")),
      attachment("todo_reminder", "todo body"),
      entry(assistant("used Grep")),
      {
        message: {
          role: "tool",
          content: "grep result",
          toolCallId: "tool-2",
          toolName: "Grep",
        },
      },
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({ entries, applyCacheControl: true });

    expect(result.messages).toEqual([
      { role: "user", content: "inspect the repo" },
      { role: "assistant", content: "used Read" },
      {
        role: "tool",
        content: "read result",
        toolCallId: "tool-1",
        toolName: "Read",
      },
      { role: "system", content: "todo body" },
      { role: "assistant", content: "used Grep" },
      {
        role: "tool",
        content: "grep result",
        toolCallId: "tool-2",
        toolName: "Grep",
        cacheControl: { type: "ephemeral" },
      },
    ]);
  });

  it("projects a todo reminder after an Anthropic-style tool-result user message", () => {
    const entries = [
      entry(user("inspect the repo"), "real_user"),
      entry(assistant("used Read")),
      entry(toolResultUser("read result")),
      attachment("todo_reminder", "todo body"),
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({ entries, applyCacheControl: true });

    expect(result.messages).toEqual([
      { role: "user", content: "inspect the repo" },
      { role: "assistant", content: "used Read" },
      {
        role: "user",
        content: [{ type: "text", text: "read result" }],
        toolCallId: "tool-1",
        toolName: "Read",
        cacheControl: { type: "ephemeral" },
      },
      { role: "system", content: "todo body" },
    ]);
  });

  it("keeps a pending mid-conversation system reminder after a following user message", () => {
    const entries = [
      entry(user("first prompt"), "real_user"),
      attachment("output_style", "style body"),
      entry(user("second prompt"), "target_continuation"),
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({ entries });

    expect(result.messages).toEqual([
      { role: "user", content: "first prompt" },
      { role: "user", content: "second prompt" },
      { role: "system", content: "style body" },
    ]);
  });

  it("does not treat a mid-conversation system fallback as latest real user", () => {
    const entries = [
      entry(assistant("used Read")),
      entry(toolResult("read result")),
      attachment("output_style", "style body"),
      entry({ role: "system", content: "stable system" }),
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({ entries, applyCacheControl: true });

    expect(result.messages).toEqual([
      { role: "assistant", content: "used Read" },
      {
        role: "tool",
        content: "read result",
        toolCallId: "tool-1",
        toolName: "Read",
      },
      {
        role: "user",
        content: "<system-reminder>\nstyle body\n</system-reminder>",
        cacheControl: { type: "ephemeral" },
      },
      { role: "system", content: "stable system" },
    ]);
    expect(result.diagnostics.latestRealUserMessageIndex).toBeUndefined();
  });

  it("places cache-control on an assistant message when it is the latest non-system message", () => {
    const entries = [
      entry(user("first prompt"), "real_user"),
      entry(assistant("assistant answer")),
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({ entries, applyCacheControl: true });

    expect(result.messages).toEqual([
      { role: "user", content: "first prompt" },
      {
        role: "assistant",
        content: "assistant answer",
        cacheControl: { type: "ephemeral" },
      },
    ]);
    expect(result.diagnostics.cacheControlIndex).toBe(1);
  });

  it("preserves system cache-control and clears stale non-system cache-control", () => {
    const entries = [
      {
        message: {
          role: "system",
          content: "stable system",
          cacheControl: { type: "ephemeral" },
        },
      },
      entry({ ...user("first prompt"), cacheControl: { type: "ephemeral" } }, "real_user"),
      entry({ ...assistant("assistant answer"), cacheControl: { type: "ephemeral" } }),
      entry(toolResult("read result")),
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({ entries, applyCacheControl: true });

    expect(result.messages).toEqual([
      {
        role: "system",
        content: "stable system",
        cacheControl: { type: "ephemeral" },
      },
      { role: "user", content: "first prompt" },
      { role: "assistant", content: "assistant answer" },
      {
        role: "tool",
        content: "read result",
        toolCallId: "tool-1",
        toolName: "Read",
        cacheControl: { type: "ephemeral" },
      },
    ]);
    expect(result.diagnostics.cacheControlIndex).toBe(3);
  });

  it("does not bubble attachment-like reminders across tool-result user boundaries", () => {
    const entries = [
      entry(assistant("assistant used a tool")),
      entry(toolResultUser()),
      entry(user("memory reminder"), "relevant_memory"),
      entry(user("next real prompt"), "real_user"),
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({ entries });

    expect(result.messages).toEqual([
      { role: "assistant", content: "assistant used a tool" },
      {
        role: "user",
        content: [{ type: "text", text: "tool result" }],
        toolCallId: "tool-1",
        toolName: "Read",
      },
      { role: "user", content: "memory reminder" },
      { role: "user", content: "next real prompt" },
    ]);
  });

  it("treats literal system-reminder user text as real input when metadata says real_user", () => {
    const entries = [
      entry(user("<system-reminder>\nthis is user-provided text\n</system-reminder>"), "real_user"),
      entry(user("mode reminder"), "runtime_mode"),
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({ entries });

    expect(result.messages).toEqual([
      {
        role: "user",
        content: "<system-reminder>\nthis is user-provided text\n</system-reminder>",
      },
      { role: "user", content: "mode reminder" },
    ]);
  });

  it("keeps direct pasted image blocks in their original real-user content order", () => {
    const entries = [
      entry(
        user([
          { type: "text", text: "Please inspect this screenshot." },
          { type: "image", mediaType: "image/png", dataUrl: "data:image/png;base64,paste" },
        ]),
        "real_user",
      ),
      entry(user("output style reminder"), "output_style"),
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({ entries });

    expect(result.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Please inspect this screenshot." },
          { type: "image", mediaType: "image/png", dataUrl: "data:image/png;base64,paste" },
        ],
      },
      { role: "user", content: "output style reminder" },
    ]);
  });

  it("is deterministic, idempotent, and does not mutate frozen runtime entries", () => {
    const entries = deepFreeze([
      {
        message: {
          role: "user",
          content: [
            { type: "image", mediaType: "image/png", dataUrl: "data:image/png;base64,abc" },
            { type: "text", text: "image context" },
          ],
        },
        metadata: systemReminderRuntimeMetadata("prompt_attachment"),
      },
      {
        message: {
          role: "user",
          content: "real prompt",
          cacheControl: { type: "ephemeral" },
        },
        metadata: realUserRuntimeMetadata(),
      },
    ] satisfies RuntimeMessageEntry[]);

    const first = buildProviderRequestMessages({ entries, applyCacheControl: true, ...FOLD });
    const second = buildProviderRequestMessages({ entries, applyCacheControl: true, ...FOLD });
    const projectedAgain = buildProviderRequestMessages({
      entries: first.messages.map((message) => ({ message })),
      applyCacheControl: true,
      ...FOLD,
    });

    expect(first).toEqual(second);
    expect(projectedAgain.messages).toEqual(first.messages);
    expect(first.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "image", mediaType: "image/png", dataUrl: "data:image/png;base64,abc" },
          { type: "text", text: "image context\n" },
        ],
      },
      {
        role: "user",
        content: "real prompt",
        cacheControl: { type: "ephemeral" },
      },
    ]);
  });

  it("returns request messages detached from runtime message objects", () => {
    const inputMessage: ModelInputMessage = {
      role: "assistant",
      content: [{ type: "text", text: "original answer" }],
      cacheControl: { type: "ephemeral" },
      toolCalls: [{ id: "tool-1", name: "Read", input: { file_path: "notes.md" } }],
    };
    const entries = [{ message: inputMessage }] satisfies RuntimeMessageEntry[];

    const projectedMessage = buildProviderRequestMessages({ entries }).messages[0]!;

    expect(projectedMessage).not.toBe(inputMessage);
    expect(projectedMessage.content).not.toBe(inputMessage.content);
    expect(projectedMessage.cacheControl).not.toBe(inputMessage.cacheControl);
    expect(projectedMessage.toolCalls).not.toBe(inputMessage.toolCalls);

    if (typeof projectedMessage.content !== "string") {
      const textBlock = projectedMessage.content[0];
      if (textBlock?.type === "text") textBlock.text = "mutated answer";
    }
    projectedMessage.toolCalls![0]!.name = "Write";
    projectedMessage.cacheControl = undefined;

    expect(inputMessage).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "original answer" }],
      cacheControl: { type: "ephemeral" },
      toolCalls: [{ id: "tool-1", name: "Read", input: { file_path: "notes.md" } }],
    });
  });
});
