import { describe, expect, it } from "vitest";
import { createAgentDefinitionsReader } from "../src/subagent/definitions.js";
import { createTestModelSelection } from "./test-model-selection.js";
import { collectAgentListingAttachment } from "../src/subagent/listing.js";
import { parseAgentListingDelta } from "../src/agent/agent-listing-metadata.js";
import { MessageHistoryImpl, type RuntimeMessageEntry } from "../src/agent/message-history.js";
import type { AgentProfile } from "../src/subagent/profile.js";
import { buildProviderRequestMessages } from "../src/runtime/helpers/provider-request-messages.js";

const profile = (name: string, description = `Description ${name}`): AgentProfile => ({
  name,
  description,
  source: "user",
  systemPrompt: "private instructions",
  tools: ["Read"],
});
const collect = (
  names: string[],
  history: readonly RuntimeMessageEntry[] = [],
  tools = [{ name: "Agent" }],
) =>
  collectAgentListingAttachment({
    definitions: { activeAgents: names.map((name) => profile(name)) },
    entries: history,
    tools,
  });

describe("agent listing attachments", () => {
  it("reads the normalized startup snapshot through the default definitions entry", () => {
    const profiles = [profile("A")];
    const read = createAgentDefinitionsReader(profiles);
    expect(read().activeAgents.map((agent) => agent.name)).toEqual(
      expect.arrayContaining(["A", "Explore", "general-purpose"]),
    );
    profiles.push(profile("B"));
    expect(read()).toBe(read());
    expect(read().activeAgents.some((agent) => agent.name === "B")).toBe(false);
  });
  it("announces the exact supplied directory once, without adding built-ins", () => {
    const entry = collect(["B", "A"])!;
    expect(entry.metadata.agentListingDelta).toEqual({
      addedTypes: ["A", "B"],
      addedLines: ["- A: Description A (Tools: Read)", "- B: Description B (Tools: Read)"],
      removedTypes: [],
      isInitial: true,
      showConcurrencyNote: true,
    });
    expect(entry.content).toContain("Available agent types for the Agent tool:");
    expect(entry.content).not.toContain("private instructions");
    expect(collect(["A", "B"], [entry])).toBeUndefined();
    expect(collect([])).toBeUndefined();
  });

  it("announces additions, removals and renames, and restarts after removing all", () => {
    const initial = collect(["A", "B"])!;
    const delta = collect(["B", "C"], [initial])!;
    expect(delta.metadata.agentListingDelta).toMatchObject({
      addedTypes: ["C"],
      removedTypes: ["A"],
      isInitial: false,
    });
    expect(delta.content).toContain("The following agent types are no longer available:");
    expect(delta.content).toContain("New agent types are now available for the Agent tool:");
    expect(delta.content).toContain("This is ambient context");
    expect(delta.content).not.toContain("When you launch multiple agents");
    const renamed = collect(["a", "B"], [initial])!;
    expect(renamed.metadata.agentListingDelta).toMatchObject({
      addedTypes: ["a"],
      removedTypes: ["A"],
    });
    const removed = collect([], [initial, delta])!;
    expect(removed.metadata.agentListingDelta?.removedTypes).toEqual(["B", "C"]);
    expect(collect(["D"], [initial, delta, removed])?.metadata.agentListingDelta?.isInitial).toBe(
      true,
    );
    expect(collect([], [initial], [])).toBeUndefined();
    expect(collect(["d", "C"], [collect(["a", "B"])!])?.metadata.agentListingDelta).toMatchObject({
      addedTypes: ["C", "d"],
      addedLines: ["- C: Description C (Tools: Read)", "- d: Description d (Tools: Read)"],
      removedTypes: ["B", "a"],
    });
  });

  it("ignores same-name material changes and preserves the original text", () => {
    const initial = collect(["A"])!;
    expect(
      collectAgentListingAttachment({
        definitions: {
          activeAgents: [
            {
              ...profile("A", "changed"),
              tools: ["Bash"],
              modelSelection: createTestModelSelection("test/other"),
            },
          ],
        },
        entries: [initial],
        tools: [{ name: "Agent" }],
      }),
    ).toBeUndefined();
    expect(initial.content).toContain("Description A");
  });

  it("reconstructs only retained history after compact, fork or rewind", () => {
    const initial = collect(["A", "B"])!;
    const added = collect(["A", "B", "C"], [initial])!;
    const repaired = collect(["A", "B", "C"], [added])!;
    expect(repaired.metadata.agentListingDelta?.addedTypes).toEqual(["A", "B"]);
    expect(collect(["A", "B", "C"], [added, repaired])).toBeUndefined();
    expect(collect(["A", "B", "C"], [])?.metadata.agentListingDelta?.addedTypes).toEqual([
      "A",
      "B",
      "C",
    ]);
    expect(collect(["A", "B", "C"], [initial])?.metadata.agentListingDelta?.addedTypes).toEqual([
      "C",
    ]);
  });

  it("does not infer announcements from text or malformed metadata", () => {
    const initial = collect(["A"])!;
    const legacy = { ...initial, metadata: { source: "agent_listing_delta" as const } };
    expect(collect(["A"], [legacy])?.metadata.agentListingDelta?.isInitial).toBe(true);
    for (const value of [
      null,
      [],
      {},
      { ...initial.metadata.agentListingDelta, addedTypes: [1] },
      { ...initial.metadata.agentListingDelta, addedLines: [] },
      { ...initial.metadata.agentListingDelta, addedLines: [1] },
      { ...initial.metadata.agentListingDelta, removedTypes: [1] },
      { ...initial.metadata.agentListingDelta, isInitial: "yes" },
      { ...initial.metadata.agentListingDelta, showConcurrencyNote: "yes" },
      { ...initial.metadata.agentListingDelta, addedTypes: ["A", "A"], addedLines: ["a", "a"] },
      { ...initial.metadata.agentListingDelta, removedTypes: ["B", "B"] },
      { ...initial.metadata.agentListingDelta, removedTypes: ["A"] },
    ]) {
      expect(parseAgentListingDelta(value)).toBeUndefined();
      for (const write of ["addEntries", "replaceMessages"] as const) {
        const history = new MessageHistoryImpl();
        history[write]([
          {
            ...initial,
            metadata: { ...initial.metadata, agentListingDelta: value },
          } as unknown as RuntimeMessageEntry,
        ]);
        expect(
          collect(["A"], history.borrowReadOnlyRuntimeEntries())?.metadata.agentListingDelta
            ?.isInitial,
        ).toBe(true);
      }
    }
  });

  it("defensively clones structured history", () => {
    const history = new MessageHistoryImpl();
    const initial = collect(["A"])!;
    history.addEntries([initial]);
    initial.metadata.agentListingDelta!.addedTypes.push("B");
    initial.metadata.agentListingDelta!.addedLines.push("changed");
    initial.metadata.agentListingDelta!.removedTypes.push("A");
    const copy = history.toRuntimeEntries();
    copy[0]!.metadata!.agentListingDelta!.addedTypes.push("C");
    expect(history.toRuntimeEntries()[0]!.metadata!.agentListingDelta).toEqual(
      collect(["A"])!.metadata.agentListingDelta,
    );
  });

  it("combines listing with other ordinary MCS attachments", () => {
    const entries: RuntimeMessageEntry[] = [
      { message: { role: "user", content: "question" }, metadata: { source: "real_user" } },
      { kind: "attachment", content: "plugin reference", metadata: { source: "plugin_reference" } },
      collect(["A"])!,
    ];
    const { messages } = buildProviderRequestMessages({ entries, useMidConversationSystem: true });
    expect(messages.at(-1)).toEqual({
      role: "system",
      content: `plugin reference\n\n${collect(["A"])!.content}`,
    });
    expect(messages.at(-2)?.role).toBe("user");
  });
  it("uses the existing fallback when no user can anchor the listing", () => {
    const listing = collect(["A"])!;
    const { messages } = buildProviderRequestMessages({
      entries: [{ message: { role: "assistant", content: "previous response" } }, listing],
      useMidConversationSystem: true,
    });
    expect(messages.at(-1)).toEqual({
      role: "user",
      content: `<system-reminder>\n${listing.content}\n</system-reminder>`,
    });
  });
  it("anchors MCS text after a user-side conversation_fork attachment", () => {
    const { messages } = buildProviderRequestMessages({
      entries: [
        { message: { role: "user", content: "question" } },
        {
          kind: "attachment",
          content: "continuity",
          metadata: { source: "conversation_fork" },
        },
        { kind: "attachment", content: "mode", metadata: { source: "runtime_mode" } },
      ],
      useMidConversationSystem: true,
    });
    // 留在 user 侧的 attachment 渲染为 user 消息，MCS 文本可以落在它之后。
    expect(messages.slice(-2)).toEqual([
      { role: "user", content: "<system-reminder>\ncontinuity\n</system-reminder>" },
      { role: "system", content: "mode" },
    ]);
  });

  const compactionAttachments: RuntimeMessageEntry[] = [
    {
      kind: "attachment",
      content: "file",
      metadata: { source: "resume_referenced_session_context" },
    },
    { kind: "attachment", content: "plan", metadata: { source: "plan_file_reference" } },
    { kind: "attachment", content: "mode", metadata: { source: "runtime_mode" } },
    { kind: "attachment", content: "env", metadata: { source: "environment" } },
    { kind: "attachment", content: "model", metadata: { source: "model" } },
  ];

  it("merges compaction attachments into one MCS message in generation order", () => {
    const { messages } = buildProviderRequestMessages({
      entries: [
        { message: { role: "assistant", content: "answer" } },
        { message: { role: "user", content: "question" } },
        ...compactionAttachments,
      ],
      useMidConversationSystem: true,
    });
    // 补回的文件正文留在 user 侧，随附件一起越过 user 输入；其余 compaction 附件按生成顺序合成一条 system。
    expect(messages).toEqual([
      { role: "assistant", content: "answer" },
      { role: "user", content: "<system-reminder>\nfile\n</system-reminder>" },
      { role: "user", content: "question" },
      { role: "system", content: "plan\n\nmode\n\nenv\n\nmodel" },
    ]);
  });

  it("bubbles compaction attachments together in generation order without MCS", () => {
    const { messages } = buildProviderRequestMessages({
      entries: [
        { message: { role: "assistant", content: "answer" } },
        { message: { role: "user", content: "question" } },
        ...compactionAttachments,
      ],
      useMidConversationSystem: false,
    });
    // 附件一起越过 user 输入，停在 assistant 之后；附件之间不互相越过。
    expect(messages).toEqual([
      { role: "assistant", content: "answer" },
      { role: "user", content: "<system-reminder>\nfile\n</system-reminder>" },
      { role: "user", content: "<system-reminder>\nplan\n</system-reminder>" },
      { role: "user", content: "<system-reminder>\nmode\n</system-reminder>" },
      { role: "user", content: "<system-reminder>\nenv\n</system-reminder>" },
      // 不合并相邻 user 的协议不补换行（补换行只在 Anthropic 上）。
      { role: "user", content: "<system-reminder>\nmodel\n</system-reminder>" },
      { role: "user", content: "question" },
    ]);
  });
});
