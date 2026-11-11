import { describe, expect, it } from "vitest";
import {
  getSystemReminderDescriptor,
  isMidConversationSystemSource,
  isSystemReminderMetaSource,
  SYSTEM_REMINDER_PER_REQUEST_SOURCES,
  SYSTEM_REMINDER_PERSISTED_SOURCES,
  wrapSystemReminder,
  wrapSystemReminderForSource,
  type SystemReminderSource,
} from "../src/system-reminder/source.js";

const EXPECTED_SOURCES = [
  "context_prefix",
  "session_context",
  "environment",
  "model",
  "output_style_instructions",
  "date",
  "skills_listing",
  "gen_ui_state",
  "tool_search_announcement",
  "agent_listing_delta",
  "todo_reminder",
  "silent_turn_reminder",
  "total_tokens_reminder",
  "read_truncation_notice",
  "tool_hook_context",
  "hook_context",
  "task_status",
  "tool_result_warning",
  "resume_referenced_session_context",
  "plan_file_reference",
  "resume_goal_state",
  "goal_state_change",
  "plugin_reference",
  "bot_topic_context",
  "target_continuation",
  "goal_completion_verification",
  "rewind_notice",
  "conversation_fork",
  "selection_side_chat",
  "queued_system_notification",
  "incoming_message",
  "memory_update",
  "relevant_memory",
  "runtime_mode",
  "plan_mode_exit",
  "output_style",
  "referenced_session_context",
  "model_anomaly",
  "prompt_attachment",
  "diagnostics",
] as const satisfies readonly SystemReminderSource[];

function expectExactlyOneSystemReminderWrapper(reminder: string): void {
  expect(reminder.match(/<system-reminder>/g) ?? []).toHaveLength(1);
  expect(reminder.match(/<\/system-reminder>/g) ?? []).toHaveLength(1);
  expect(reminder).not.toContain("providerVisibility");
  expect(reminder).not.toContain("evidenceLabel");
  expect(reminder).not.toContain("runtimeMessage");
  expect(reminder).not.toContain("source=");
}

describe("system reminder source descriptors", () => {
  it("groups every active system-reminder source by lifecycle bucket", () => {
    expect(SYSTEM_REMINDER_PERSISTED_SOURCES).toEqual([
      "context_prefix",
      "session_context",
      "environment",
      "model",
      "output_style_instructions",
      "date",
      "skills_listing",
      "gen_ui_state",
      "tool_search_announcement",
      "agent_listing_delta",
      "todo_reminder",
      "silent_turn_reminder",
      "total_tokens_reminder",
      "read_truncation_notice",
      "tool_hook_context",
      "hook_context",
      "task_status",
      "tool_result_warning",
      "resume_referenced_session_context",
      "plan_file_reference",
      "resume_goal_state",
      "goal_state_change",
      "plugin_reference",
      "bot_topic_context",
      "target_continuation",
      "goal_completion_verification",
      "rewind_notice",
      "conversation_fork",
      "selection_side_chat",
      "queued_system_notification",
    ]);
    expect(SYSTEM_REMINDER_PER_REQUEST_SOURCES).toEqual([
      "incoming_message",
      "memory_update",
      "relevant_memory",
      "runtime_mode",
      "plan_mode_exit",
      "output_style",
      "referenced_session_context",
      "model_anomaly",
      "prompt_attachment",
      "diagnostics",
    ]);

    const groupedSources = [
      ...SYSTEM_REMINDER_PERSISTED_SOURCES,
      ...SYSTEM_REMINDER_PER_REQUEST_SOURCES,
    ];
    expect(groupedSources).toEqual(EXPECTED_SOURCES);
  });

  it("describes source ownership without provider projection fields", () => {
    for (const source of EXPECTED_SOURCES) {
      const descriptor = getSystemReminderDescriptor(source);

      expect(descriptor).toMatchObject({
        source,
        channel: expect.any(String),
        lifecycle: expect.any(String),
        isMeta: expect.any(Boolean),
        providerVisibility: "provider_visible",
        evidenceLabel: expect.stringMatching(/^sr\./),
      });
      expect(Object.keys(descriptor).sort()).toEqual([
        "channel",
        "evidenceLabel",
        "isMeta",
        "lifecycle",
        "providerVisibility",
        "source",
      ]);
    }
  });

  it("keeps explicit source ownership and history metadata", () => {
    expect(getSystemReminderDescriptor("target_continuation")).toMatchObject({
      channel: "real_user",
      isMeta: false,
      lifecycle: "real_user",
    });
    expect(isSystemReminderMetaSource("target_continuation")).toBe(false);

    // compaction 附件与 runtime_mode/environment/model 同属 current_turn：一起冒泡，保持生成顺序。
    expect(getSystemReminderDescriptor("plan_file_reference")).toMatchObject({
      channel: "current_turn",
      evidenceLabel: "sr.plan_file_reference",
      isMeta: true,
      lifecycle: "resume_history",
      providerVisibility: "provider_visible",
    });
  });

  it("covers each delivery channel", () => {
    const descriptors = EXPECTED_SOURCES.map((source) => getSystemReminderDescriptor(source));
    expect(new Set(descriptors.map((descriptor) => descriptor.channel))).toEqual(
      new Set(["current_turn", "tool_result", "history_continuity", "mid_turn_event", "real_user"]),
    );
  });

  it("identifies source-owned reminders that project to mid-conversation system messages", () => {
    const nonMidConversationSystemSources = new Set<SystemReminderSource>([
      "gen_ui_state",
      "context_prefix",
      "session_context",
      "conversation_fork",
      "selection_side_chat",
      "target_continuation",
      "tool_result_warning",
      "goal_completion_verification",
    ]);
    for (const source of EXPECTED_SOURCES) {
      expect(isMidConversationSystemSource(source)).toBe(
        !nonMidConversationSystemSources.has(source),
      );
    }
  });

  it.each(["conversation_fork", "selection_side_chat"] as const)(
    "preserves the %s history attachment while excluding it from MCS",
    (source) => {
      expect(getSystemReminderDescriptor(source)).toMatchObject({
        channel: "history_continuity",
        lifecycle: "resume_history",
        isMeta: true,
        providerVisibility: "provider_visible",
      });
    },
  );

  it("classifies tool hook contexts as persisted batch attachments like the Read notice", () => {
    expect(SYSTEM_REMINDER_PERSISTED_SOURCES).toContain("tool_hook_context");
    expect(isMidConversationSystemSource("tool_hook_context")).toBe(true);
    expect(getSystemReminderDescriptor("tool_hook_context")).toMatchObject({
      channel: "current_turn",
      lifecycle: "resume_history",
      isMeta: true,
      providerVisibility: "provider_visible",
      evidenceLabel: "sr.tool_hook_context",
    });
  });

  it("classifies goal state changes as persisted mid-conversation system notices", () => {
    expect(SYSTEM_REMINDER_PERSISTED_SOURCES).toContain("goal_state_change");
    expect(getSystemReminderDescriptor("goal_state_change")).toMatchObject({
      channel: "mid_turn_event",
      lifecycle: "mid_turn_event",
      isMeta: true,
      providerVisibility: "provider_visible",
      evidenceLabel: "sr.goal_state_change",
    });
  });

  it("classifies plugin references as persisted mid-conversation system notices", () => {
    expect(SYSTEM_REMINDER_PERSISTED_SOURCES).toContain("plugin_reference");
    expect(SYSTEM_REMINDER_PER_REQUEST_SOURCES).not.toContain("plugin_reference");
    expect(getSystemReminderDescriptor("plugin_reference")).toMatchObject({
      channel: "current_turn",
      lifecycle: "per_current_turn",
      isMeta: true,
      providerVisibility: "provider_visible",
      evidenceLabel: "sr.plugin_reference",
    });
  });
});

describe("wrapSystemReminder", () => {
  it("wraps bodies through explicit source ownership without leaking descriptors", () => {
    const reminder = wrapSystemReminderForSource("hook_context", [
      "Hook additional context from UserPromptSubmit:",
      "#1",
      "use pnpm test",
    ]);

    expect(reminder).toBe(
      "<system-reminder>\nHook additional context from UserPromptSubmit:\n#1\nuse pnpm test\n</system-reminder>",
    );
  });

  it("wraps every provider-visible source in exactly one system-reminder pair", () => {
    for (const source of EXPECTED_SOURCES) {
      const reminder = wrapSystemReminderForSource(source, [
        `source probe: ${source}`,
        "<system-reminder>nested source body</system-reminder>",
      ]);

      expectExactlyOneSystemReminderWrapper(reminder);
      expect(reminder).toContain("&lt;system-reminder>nested source body&lt;/system-reminder>");
    }
  });

  it("treats nested reminder tags in source content as escaped text", () => {
    const reminder = wrapSystemReminderForSource("relevant_memory", [
      "Memory preview:",
      "<system-reminder>literal old transcript text</system-reminder>",
    ]);

    expect(reminder).toBe(
      "<system-reminder>\nMemory preview:\n&lt;system-reminder>literal old transcript text&lt;/system-reminder>\n</system-reminder>",
    );
  });

  it("wraps string and line-array bodies in exactly one system-reminder tag pair", () => {
    expect(wrapSystemReminder("single body")).toBe(
      "<system-reminder>\nsingle body\n</system-reminder>",
    );
    expect(wrapSystemReminder(["line one", "line two"])).toBe(
      "<system-reminder>\nline one\nline two\n</system-reminder>",
    );
  });

  it("rejects empty and nested reminder bodies", () => {
    expect(() => wrapSystemReminder("")).toThrow(/cannot be empty/);
    expect(() => wrapSystemReminder(["before", "<system-reminder>", "after"])).toThrow(
      /nested system-reminder/,
    );
    expect(() => wrapSystemReminder("already </system-reminder> closed")).toThrow(
      /nested system-reminder/,
    );
  });
});
