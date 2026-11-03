import { describe, expect, it } from "vitest";
import { createSessionId, type ModelMessageContent } from "@zcode/contracts";
import {
  RUNTIME_MODE_REMINDER_CONFIG,
  TODO_REMINDER_CONFIG,
  buildDateChangeReminderBody,
  buildPlanModeExitReminderBody,
  buildRuntimeModeReminderBody,
  buildRuntimeOutputStyleReminderBody,
  buildTodoReminderBody,
  buildSilentTurnReminderBody,
  buildProviderRequestMessages,
  buildRepeatedToolCallReminderBody,
  buildToolCallBudgetReminderBody,
  formatConversationForkNoticeBody,
  getTodoReminderTurnCounts,
  runtimeMetadataForSyntheticUserMessageSource,
  shouldBuildTodoReminder,
} from "../src/runtime/helpers/index.js";
import {
  legacySyntheticRuntimeMetadata,
  realUserRuntimeMetadata,
  systemReminderAttachmentEntry,
  type RuntimeMessageEntry,
} from "../src/agent/message-history.js";
import { buildCompactSummaryRequestMessages } from "../src/runtime/methods/compact-active-helpers.js";
import { runtimeInputMetadata } from "../src/agent/runtime-input-presentation.js";

describe("runtime request reminders", () => {
  const silentTurn = (name = "Read"): RuntimeMessageEntry => ({
    message: {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call", name, input: {} }],
    },
  });
  const silentTurns = (count: number) => Array.from({ length: count }, () => silentTurn());
  const silentReminder = () =>
    systemReminderAttachmentEntry("silent_turn_reminder", "previous silence reminder");
  // 历史里作为普通 user 消息的输入都算一个用户轮次，不只真实 prompt。
  const userTurnInputs: RuntimeMessageEntry[] = [
    {
      message: { role: "user", content: "<task-notification>done</task-notification>" },
      metadata: runtimeInputMetadata("task_notification"),
    },
    {
      message: { role: "user", content: "agent reply" },
      metadata: runtimeInputMetadata("subagent_reply"),
    },
    {
      message: { role: "user", content: "[Request interrupted by user]" },
      metadata: { source: "interrupt_marker" },
    },
    {
      message: { role: "user", content: "summary" },
      metadata: { source: "legacy_synthetic", compactBoundary: { boundaryId: "b1" } },
    },
  ];

  it("emits a silent reminder after five responses, not five tool calls", () => {
    const batch = silentTurn();
    if (batch.kind !== "attachment") {
      batch.message.toolCalls = Array.from({ length: 6 }, (_, i) => ({
        id: `call-${i}`,
        name: "Read",
        input: {},
      }));
    }
    expect(buildSilentTurnReminderBody([batch])).toBeNull();
    expect(buildSilentTurnReminderBody(silentTurns(4))).toBeNull();
    expect(buildSilentTurnReminderBody(silentTurns(5))).toBe(
      "The user hasn't heard from you in a while. As you continue, keep them updated when there's something to tell — a finding, a change of plan.",
    );
  });

  it("counts reasoning, empty text and placeholders as silent responses", () => {
    const entries: RuntimeMessageEntry[] = [
      { message: { role: "assistant", content: [{ type: "reasoning", text: "thinking" }] } },
      {
        message: {
          role: "assistant",
          content: [{ type: "reasoning", text: "", providerOptions: { opaque: {} } }],
        },
      },
      { message: { role: "assistant", content: "  " } },
      { message: { role: "assistant", content: "(no content)" } },
      { message: { role: "assistant", content: "No response requested." } },
    ];
    expect(buildSilentTurnReminderBody(entries)).not.toBeNull();
  });

  it.each<RuntimeMessageEntry>([
    { message: { role: "assistant", content: "Found the cause." } },
    {
      message: {
        role: "assistant",
        content: [
          { type: "reasoning", text: "thinking" },
          { type: "text", text: "An update." },
        ],
      },
    },
    {
      message: { role: "user", content: "<system-reminder>User's own text</system-reminder>" },
      metadata: realUserRuntimeMetadata(),
    },
    { message: { role: "user", content: "legacy real input" } },
    ...userTurnInputs,
    silentTurn("AskUserQuestion"),
    silentTurn("ExitPlanMode"),
  ])("ends the silent stretch at effective communication %j", (boundary) => {
    const oldStretch = [silentReminder(), silentReminder(), silentReminder(), ...silentTurns(5)];
    expect(buildSilentTurnReminderBody([...oldStretch, boundary, ...silentTurns(4)])).toBeNull();
    expect(
      buildSilentTurnReminderBody([...oldStretch, boundary, ...silentTurns(5)]),
    ).not.toBeNull();
  });

  it("ignores tool results and synthetic context when counting silent responses", () => {
    const entries: RuntimeMessageEntry[] = silentTurns(5).flatMap((entry) => [
      entry,
      { message: { role: "tool", content: "read result", toolCallId: "call" } },
      { message: { role: "user", content: "legacy tool result", toolCallId: "call" } },
      systemReminderAttachmentEntry("environment", "environment"),
      {
        message: { role: "user", content: "background notice" },
        metadata: legacySyntheticRuntimeMetadata(),
      },
    ]);
    expect(buildSilentTurnReminderBody(entries)).not.toBeNull();
  });

  it("waits five more silent responses and caps a stretch at three reminders", () => {
    const entries = silentTurns(5);
    for (let reminder = 0; reminder < 3; reminder++) {
      expect(buildSilentTurnReminderBody(entries)).not.toBeNull();
      entries.push(silentReminder(), ...silentTurns(4));
      expect(buildSilentTurnReminderBody(entries)).toBeNull();
      entries.push(silentTurn());
    }
    entries.push(...silentTurns(20));
    expect(buildSilentTurnReminderBody(entries)).toBeNull();
  });

  it("does not count mid-turn user steers as plan-mode human turns", () => {
    // 中途输入是附件，不算人类轮次；只有真实的新 prompt 推进计划模式提醒节奏。
    const steer = (index: number): RuntimeMessageEntry => ({
      message: { role: "user", content: `steer ${index}` },
      metadata: runtimeInputMetadata("user_steer"),
    });
    const prompt = (index: number): RuntimeMessageEntry => ({
      message: { role: "user", content: `prompt ${index}` },
      metadata: realUserRuntimeMetadata(),
    });
    const reminder: RuntimeMessageEntry = {
      message: { role: "user", content: "old full plan reminder" },
      metadata: { source: "runtime_mode" },
    };
    const answer: RuntimeMessageEntry = { message: { role: "assistant", content: "answer" } };
    const turns = RUNTIME_MODE_REMINDER_CONFIG.TURNS_BETWEEN_ATTACHMENTS;
    const prompts = Array.from({ length: turns - 1 }, (_, index) => [prompt(index), answer]).flat();
    const steers = Array.from({ length: 3 }, (_, index) => steer(index));
    expect(buildRuntimeModeReminderBody([reminder, ...steers, ...prompts], "plan")).toBeNull();
    expect(
      buildRuntimeModeReminderBody(
        [reminder, ...steers, ...prompts, prompt(turns), answer],
        "plan",
      ),
    ).toContain("Plan mode still active");
  });

  it.each(userTurnInputs)("counts %j as a plan-mode user turn", (turnInput) => {
    const reminder = systemReminderAttachmentEntry("runtime_mode", "old full plan reminder");
    const answer: RuntimeMessageEntry = { message: { role: "assistant", content: "answer" } };
    const turns = RUNTIME_MODE_REMINDER_CONFIG.TURNS_BETWEEN_ATTACHMENTS;
    const history = Array.from({ length: turns }, () => [turnInput, answer]).flat();
    expect(buildRuntimeModeReminderBody([reminder, ...history], "plan")).toContain(
      "Plan mode still active",
    );
  });

  it("counts the current prompt only after the model has responded to it", () => {
    const reminder = systemReminderAttachmentEntry("runtime_mode", "old full plan reminder");
    const prompt = (index: number): RuntimeMessageEntry => ({
      message: { role: "user", content: `prompt ${index}` },
      metadata: realUserRuntimeMetadata(),
    });
    const answer: RuntimeMessageEntry = { message: { role: "assistant", content: "answer" } };
    const turns = RUNTIME_MODE_REMINDER_CONFIG.TURNS_BETWEEN_ATTACHMENTS;
    const answered = Array.from({ length: turns - 1 }, (_, index) => [
      prompt(index),
      answer,
    ]).flat();
    // 间隔满五次的那一轮：轮首请求前还没有回应，本轮 prompt 不计入。
    expect(buildRuntimeModeReminderBody([reminder, ...answered, prompt(turns)], "plan")).toBeNull();
    // 本轮第一个工具批次之后，prompt 已有回应，计入间隔。
    expect(
      buildRuntimeModeReminderBody([reminder, ...answered, prompt(turns), answer], "plan"),
    ).toContain("Plan mode still active");
    // 只跳过最新一条；更早的未回应 prompt（例如请求失败）照常计入。
    expect(
      buildRuntimeModeReminderBody([reminder, ...answered, prompt(9), prompt(turns)], "plan"),
    ).toContain("Plan mode still active");
  });

  it("keeps the silent stretch across a mid-turn user steer", () => {
    // 中途输入是附件，不结束静默段；只有新的用户轮次才结束。
    const steer: RuntimeMessageEntry = {
      message: { role: "user", content: "also check the tests" },
      metadata: runtimeInputMetadata("user_steer"),
    };
    expect(
      buildSilentTurnReminderBody([...silentTurns(3), steer, ...silentTurns(2)]),
    ).not.toBeNull();
  });

  it.each([0, 5])(
    "restarts both plan reminder counters after exit with %s new inputs",
    (newInputs) => {
      const old = Array.from({ length: 3 }, () =>
        systemReminderAttachmentEntry("runtime_mode", "old plan reminder"),
      );
      const entries: RuntimeMessageEntry[] = [
        ...old,
        systemReminderAttachmentEntry("plan_mode_exit", buildPlanModeExitReminderBody()),
        ...Array.from({ length: newInputs }, () => ({
          message: { role: "user" as const, content: "reenter" },
          metadata: realUserRuntimeMetadata(),
        })),
      ];
      const full = buildRuntimeModeReminderBody(entries, "plan");
      expect(full).toContain("## Plan Workflow");
      entries.push(systemReminderAttachmentEntry("runtime_mode", full!));
      expect(buildRuntimeModeReminderBody(entries, "plan")).toBeNull();
      for (let count = 1; count <= 5; count++) {
        entries.push(
          ...Array.from({ length: 5 }, () => [
            {
              message: { role: "user" as const, content: "continue" },
              metadata: realUserRuntimeMetadata(),
            },
            { message: { role: "assistant" as const, content: "answer" } },
          ]).flat(),
        );
        const next = buildRuntimeModeReminderBody(entries, "plan")!;
        expect(next).toContain(count === 5 ? "## Plan Workflow" : "Plan mode still active");
        entries.push(systemReminderAttachmentEntry("runtime_mode", next));
      }
    },
  );

  it("maps a subagent message to direct user-like runtime metadata", () => {
    expect(runtimeMetadataForSyntheticUserMessageSource("subagent_message")).toEqual(
      legacySyntheticRuntimeMetadata(),
    );
  });

  it("maps a persisted plugin reference back to its attachment source", () => {
    expect(runtimeMetadataForSyntheticUserMessageSource("plugin_reference")).toEqual({
      source: "plugin_reference",
    });
  });

  it("builds a one-time plan mode exit reminder", () => {
    const body = buildPlanModeExitReminderBody();

    expect(body).toContain("## Exited Plan Mode");
    expect(body).toContain("You can now make edits");
    expect(body).not.toContain("<system-reminder>");
    expect(body).not.toContain("source=");
  });

  it("counts assistant turns since the latest TodoWrite and todo reminder markers", () => {
    const entries = [
      { message: { role: "user" as const, content: "start" }, metadata: realUserRuntimeMetadata() },
      {
        message: {
          role: "assistant" as const,
          content: "",
          toolCalls: [{ id: "todo-write-1", name: "TodoWrite", input: {} }],
        },
      },
      {
        message: {
          role: "tool" as const,
          content: "ok",
          toolCallId: "todo-write-1",
          toolName: "TodoWrite",
        },
      },
      { message: { role: "assistant" as const, content: "after write 1" } },
      {
        message: { role: "user" as const, content: "todo reminder" },
        metadata: { source: "todo_reminder" as const },
      },
      { message: { role: "assistant" as const, content: "after reminder 1" } },
      { message: { role: "assistant" as const, content: "after reminder 2" } },
    ];

    expect(getTodoReminderTurnCounts(entries)).toEqual({
      turnsSinceLastReminder: 2,
      turnsSinceLastTodoWrite: 3,
    });
  });

  it("stops scanning todo cadence history once both latest markers are found", () => {
    const entries: RuntimeMessageEntry[] = [
      { message: { role: "assistant", content: "old assistant turn" } },
      { message: { role: "assistant", content: "older assistant turn" } },
      {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "todo-write-latest", name: "TodoWrite", input: {} }],
        },
      },
      {
        message: { role: "user", content: "latest todo reminder" },
        metadata: { source: "todo_reminder" },
      },
      { message: { role: "assistant", content: "newer assistant turn" } },
    ];
    const guardedEntries = new Proxy(entries, {
      get(target, property, receiver) {
        if (property === "0" || property === "1") {
          throw new Error("older history should not be read after both todo markers are found");
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(getTodoReminderTurnCounts(guardedEntries)).toEqual({
      turnsSinceLastReminder: 1,
      turnsSinceLastTodoWrite: 1,
    });
  });

  it("treats sessions without TodoWrite or prior todo reminders as counting from the start", () => {
    const entries = Array.from({ length: TODO_REMINDER_CONFIG.TURNS_SINCE_WRITE }, (_, index) => ({
      message: { role: "assistant" as const, content: `assistant turn ${index}` },
    }));

    expect(getTodoReminderTurnCounts(entries)).toEqual({
      turnsSinceLastReminder: TODO_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS,
      turnsSinceLastTodoWrite: TODO_REMINDER_CONFIG.TURNS_SINCE_WRITE,
    });
  });

  it("resets todo cadence when TodoWrite appears in a recent assistant turn", () => {
    const entries = [
      { message: { role: "assistant" as const, content: "old assistant 1" } },
      {
        message: {
          role: "assistant" as const,
          content: "",
          toolCalls: [{ id: "todo-write-recent", name: "TodoWrite", input: {} }],
        },
      },
      {
        message: {
          role: "tool" as const,
          content: "ok",
          toolCallId: "todo-write-recent",
          toolName: "TodoWrite",
        },
      },
      { message: { role: "assistant" as const, content: "recent assistant" } },
    ];

    expect(getTodoReminderTurnCounts(entries)).toMatchObject({
      turnsSinceLastTodoWrite: 1,
    });
  });

  it("allows another todo reminder when the previous marker is old enough", () => {
    const entries = [
      {
        message: { role: "user" as const, content: "old todo reminder" },
        metadata: { source: "todo_reminder" as const },
      },
      ...Array.from({ length: TODO_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS }, (_, index) => ({
        message: { role: "assistant" as const, content: `assistant turn ${index}` },
      })),
    ];

    expect(shouldBuildTodoReminder(entries)).toBe(true);
  });

  it("does not advance todo cadence for reasoning-only history, including opaque reasoning", () => {
    const reasoningContents: ModelMessageContent[] = [
      [{ type: "reasoning", text: "Inspect the constraints first." }],
      [{ type: "reasoning", text: "", providerOptions: { reasoning: { signature: "opaque" } } }],
    ];
    const entries: RuntimeMessageEntry[] = Array.from({ length: 10 }, (_, index) => ({
      message: { role: "assistant", content: reasoningContents[index % 2]! },
    }));
    expect(getTodoReminderTurnCounts(entries)).toEqual({
      turnsSinceLastReminder: 0,
      turnsSinceLastTodoWrite: 0,
    });
    expect(shouldBuildTodoReminder(entries)).toBe(false);

    const visibleTurns: RuntimeMessageEntry[] = Array.from({ length: 9 }, () => ({
      message: { role: "assistant", content: "A visible answer" },
    }));
    expect(shouldBuildTodoReminder([...entries, ...visibleTurns])).toBe(false);
    visibleTurns.push({ message: { role: "assistant", content: "The tenth answer" } });
    expect(shouldBuildTodoReminder([...entries, ...visibleTurns])).toBe(true);
  });

  it("counts mixed reasoning messages and keeps the TodoWrite reset boundary", () => {
    const entries: RuntimeMessageEntry[] = [
      systemReminderAttachmentEntry("todo_reminder", "previous reminder"),
      {
        message: {
          role: "assistant",
          content: [{ type: "reasoning", text: "Update the task list." }],
          toolCalls: [{ id: "todo", name: "TodoWrite", input: {} }],
        },
      },
      { message: { role: "assistant", content: [{ type: "reasoning", text: "Think." }] } },
      {
        message: {
          role: "assistant",
          content: [
            { type: "reasoning", text: "Explain." },
            { type: "text", text: "Answer" },
          ],
        },
      },
      {
        message: {
          role: "assistant",
          content: [{ type: "reasoning", text: "Read." }],
          toolCalls: [{ id: "read", name: "Read", input: { file_path: "/tmp/example.ts" } }],
        },
      },
    ];
    expect(getTodoReminderTurnCounts(entries)).toEqual({
      turnsSinceLastReminder: 3,
      turnsSinceLastTodoWrite: 2,
    });
  });

  it("preserves exact todo paragraph and list separators", () => {
    const paragraph =
      "The TodoWrite tool hasn't been used recently. If you're working on tasks that would benefit from tracking progress, consider using the TodoWrite tool to track progress. Also consider cleaning up the todo list if has become stale and no longer matches what you are working on. Only use it if it's relevant to the current work. This is just a gentle reminder - ignore if not applicable.";
    expect(buildTodoReminderBody([])).toBe(`${paragraph}\n`);
    expect(
      buildTodoReminderBody([{ content: "Review changes", status: "pending", priority: "high" }]),
    ).toBe(
      `${paragraph}\n\n\nHere are the existing contents of your todo list:\n\n[1. [pending] Review changes]`,
    );
  });

  it("omits todo list details when a due reminder has no current todos", () => {
    const body = buildTodoReminderBody([]);
    expect(body).toContain("The TodoWrite tool hasn't been used recently.");
    expect(body).not.toContain("<system-reminder>");
    expect(body).toContain("Only use it if it's relevant to the current work.");
    expect(body).toContain("ignore if not applicable");
    expect(body).not.toContain("Here are the existing contents of your todo list:");
    expect(body).not.toContain("[pending]");
  });

  it("builds an aligned todo reminder without the old authoritative todo_state wording", () => {
    const body = buildTodoReminderBody([
      {
        content: "Review prompt trajectory output",
        priority: "high",
        status: "in_progress",
      },
    ]);
    expect(body).toContain("1. [in_progress] Review prompt trajectory output");
    expect(body).not.toContain("<system-reminder>");
    expect(body).toContain("The TodoWrite tool hasn't been used recently.");
    expect(body).toContain("Only use it if it's relevant to the current work.");
    expect(body).toContain("ignore if not applicable");
    expect(body).toContain("Here are the existing contents of your todo list:");
    expect(body).not.toContain("Current session todo state (authoritative):");
    expect(body).not.toContain("source=");
  });

  it("builds date change reminder with no-user-mention wording", () => {
    const body = buildDateChangeReminderBody("2026-06-04");
    expect(body).toContain("The date has changed. Today's date is now 2026-06-04.");
    expect(body).not.toContain("<system-reminder>");
    expect(body).toContain("No need to announce the new date — the user's own clock shows it.");
    expect(body).not.toContain("from 2026-06-03 to 2026-06-04");
  });

  it("escapes nested system reminder-like text in conversation fork notices", () => {
    const body = formatConversationForkNoticeBody({
      parentSessionId: createSessionId("parent-<system-reminder>") as never,
      targetMessageId: "message-</system-reminder>" as never,
    });
    expect(body).not.toContain("<system-reminder>");
    expect(body).not.toContain("</system-reminder>");

    expect(body).toContain("parentSessionId: sess_parent-&lt;system-reminder>");
    expect(body).toContain("targetMessageId: message-&lt;/system-reminder>");
  });

  it("builds output style reminder only for non-empty active style", () => {
    expect(buildRuntimeOutputStyleReminderBody(undefined)).toBeNull();
    expect(
      buildRuntimeOutputStyleReminderBody({
        name: "Default",
        prompt: "   ",
      }),
    ).toBeNull();

    const body = buildRuntimeOutputStyleReminderBody({
      name: "Learning",
      prompt: "Explain tradeoffs while solving the task.",
    });

    expect(body).toBe(
      "Learning output style is active. Remember to follow the specific guidelines for this style.",
    );
  });

  it("builds plan mode reminders with human-turn cadence and full/sparse cycle", () => {
    const firstBody = buildRuntimeModeReminderBody(
      [{ message: { role: "user", content: "make a plan" }, metadata: realUserRuntimeMetadata() }],
      "plan",
    );
    expect(firstBody).toContain("Plan mode is active");
    expect(firstBody).not.toContain("<system-reminder>");

    expect(firstBody).toContain("MUST NOT make any edits");
    expect(firstBody).toContain("## Plan Workflow");
    expect(firstBody).not.toContain("ExitPlanModeV2");

    const recent = buildRuntimeModeReminderBody(
      [
        {
          message: { role: "user", content: "old full plan reminder" },
          metadata: { source: "runtime_mode" },
        },
        ...Array.from(
          { length: RUNTIME_MODE_REMINDER_CONFIG.TURNS_BETWEEN_ATTACHMENTS - 1 },
          (_, index) => ({
            message: { role: "user" as const, content: `follow up ${index}` },
            metadata: realUserRuntimeMetadata(),
          }),
        ),
      ],
      "plan",
    );
    expect(recent).toBeNull();

    const sparse = buildRuntimeModeReminderBody(
      [
        {
          message: { role: "user", content: "old full plan reminder" },
          metadata: { source: "runtime_mode" },
        },
        ...Array.from(
          { length: RUNTIME_MODE_REMINDER_CONFIG.TURNS_BETWEEN_ATTACHMENTS },
          (_, index) => ({
            message: { role: "user" as const, content: `follow up ${index}` },
            metadata: realUserRuntimeMetadata(),
          }),
        ),
        // 最新 prompt 已有回应才计入间隔。
        { message: { role: "assistant", content: "answer" } },
      ],
      "plan",
    );
    expect(sparse).toContain("Plan mode still active");
    expect(sparse).toContain("Read-only.");
    expect(sparse).toContain("Follow 5-phase workflow.");
    expect(sparse).not.toContain("## Plan Workflow");
    expect(sparse).not.toContain("<system-reminder>");

    const nextFull = buildRuntimeModeReminderBody(
      [
        ...Array.from(
          { length: RUNTIME_MODE_REMINDER_CONFIG.FULL_REMINDER_EVERY_N_ATTACHMENTS },
          (_, index) => ({
            message: { role: "user" as const, content: `prior runtime reminder ${index}` },
            metadata: { source: "runtime_mode" as const },
          }),
        ),
        ...Array.from(
          { length: RUNTIME_MODE_REMINDER_CONFIG.TURNS_BETWEEN_ATTACHMENTS },
          (_, index) => ({
            message: { role: "user" as const, content: `later follow up ${index}` },
            metadata: realUserRuntimeMetadata(),
          }),
        ),
        { message: { role: "assistant", content: "answer" } },
      ],
      "plan",
    );
    expect(nextFull).toContain("Plan mode is active");

    expect(buildRuntimeModeReminderBody([], "build")).toBeNull();
  });

  it("prepares a complete plan argument across five phases without a file-writing exception", () => {
    const body = buildRuntimeModeReminderBody([], "plan")!;
    expect(body.match(/^### Phase \d: .+$/gm)).toEqual([
      "### Phase 1: Initial Understanding",
      "### Phase 2: Design",
      "### Phase 3: Review",
      "### Phase 4: Final Plan",
      "### Phase 5: Call ExitPlanMode",
    ]);
    expect(body).toContain(
      "Provide comprehensive background context from Phase 1 exploration including filenames and code path traces",
    );
    expect(body).toContain("Read the critical files you identified during exploration");
    expect(body).toContain(
      "Prepare your complete final plan for the `plan` parameter of ExitPlanMode.",
    );
    expect(body).toContain("Begin with a **Context** section");
    expect(body).toContain("Include only your recommended approach, not all alternatives");
    expect(body).toContain("describe the pattern once and list a few representative paths");
    expect(body).toContain("Reference existing functions and utilities");
    expect(body).toContain("Include a verification section");
    expect(body).toContain("pass the complete final plan in its `plan` parameter");
    expect(body).not.toMatch(/plan file|Launch Plan|Phase 6/i);
  });

  // 修复原因：子会话继承 Plan 后收到主会话的五阶段提醒，被要求再派生 Explore、以
  // AskUserQuestion 或 ExitPlanMode 收尾，而子会话没有这些工具。
  it("gives subagent children a read-only plan reminder without the main workflow", () => {
    for (const askUserQuestionAvailable of [true, false]) {
      const body = buildRuntimeModeReminderBody([], "build", true, { askUserQuestionAvailable })!;
      expect(body).toContain("Plan mode is active.");
      expect(body).toContain("read-only");
      expect(body).not.toMatch(/### Phase|ExitPlanMode|Explore agents|should only end with/);
      if (askUserQuestionAvailable) expect(body).toContain("AskUserQuestion");
      else expect(body).not.toContain("AskUserQuestion");
    }
    expect(
      buildRuntimeModeReminderBody([], "build", false, { askUserQuestionAvailable: true }),
    ).toBeNull();
    expect(buildRuntimeModeReminderBody([], "plan")).toContain("### Phase 5: Call ExitPlanMode");
  });

  it("builds model anomaly reminder bodies without wrapping", () => {
    const budgetBody = buildToolCallBudgetReminderBody(42);
    const repeatedBody = buildRepeatedToolCallReminderBody("Read", 3);

    expect(budgetBody).toContain("This turn has already made 42 tool calls.");
    expect(repeatedBody).toContain("You have called Read with the same input 3 times in a row.");
    expect(budgetBody).not.toContain("<system-reminder>");
    expect(repeatedBody).not.toContain("<system-reminder>");
  });

  it("uses metadata instead of system-reminder text to find the latest real user", () => {
    const entries: RuntimeMessageEntry[] = [
      { message: { role: "system", content: "system prompt" } },
      {
        message: {
          role: "user",
          content: "<system-reminder>\nuser typed this literal tag\n</system-reminder>",
        },
        metadata: realUserRuntimeMetadata(),
      },
    ];

    const { messages } = buildProviderRequestMessages({ entries, applyCacheControl: true });
    expect(messages.at(-1)).toMatchObject({
      role: "user",
      cacheControl: { type: "ephemeral" },
    });
  });

  it("bubbles legacy synthetic system-reminder text before latest non-system cache-control finalization", () => {
    const entries: RuntimeMessageEntry[] = [
      {
        message: {
          role: "user",
          content: "<system-reminder>\nuser typed this literal tag\n</system-reminder>",
        },
        metadata: realUserRuntimeMetadata(),
      },
      {
        message: {
          role: "user",
          content: "<system-reminder>\nlegacy synthetic reminder\n</system-reminder>",
        },
        metadata: legacySyntheticRuntimeMetadata(),
      },
    ];

    const { messages } = buildProviderRequestMessages({ entries, applyCacheControl: true });

    expect(messages).toEqual([
      {
        role: "user",
        content: "<system-reminder>\nlegacy synthetic reminder\n</system-reminder>",
      },
      {
        role: "user",
        content: "<system-reminder>\nuser typed this literal tag\n</system-reminder>",
        cacheControl: { type: "ephemeral" },
      },
    ]);
  });

  it("keeps a trailing legacy Plan reminder in the provider projection", () => {
    const entries: RuntimeMessageEntry[] = [
      { message: { role: "system", content: "system prompt" } },
      {
        message: { role: "user", content: "compare prompts" },
        metadata: realUserRuntimeMetadata(),
      },
      {
        message: {
          role: "user",
          content: "<system-reminder>\nPlan mode is active\n</system-reminder>",
        },
        metadata: { source: "runtime_mode" },
      },
    ];

    const { messages } = buildProviderRequestMessages({ entries, applyCacheControl: true });
    expect(messages).toHaveLength(3);
    expect(messages[1]).toEqual({
      role: "user",
      content: "compare prompts",
    });
    expect(messages[2]).toMatchObject({
      role: "user",
      cacheControl: { type: "ephemeral" },
    });

    expect(JSON.stringify(messages[2]?.content)).toContain("Plan mode is active");
    const reminderTexts = String(JSON.stringify(messages));
    expect(reminderTexts).toContain("compare prompts");
    expect(JSON.stringify(messages)).not.toContain("projectionPolicy");
  });

  it("projects compact summary requests with attachment ordering and skipped cache write", () => {
    const messages = buildCompactSummaryRequestMessages(
      [
        { message: { role: "system", content: "system prompt" } },
        {
          message: { role: "user", content: "<system-reminder>\nprefix\n</system-reminder>" },
          metadata: { source: "context_prefix" },
        },
        {
          message: { role: "user", content: "summarize this history" },
          metadata: realUserRuntimeMetadata(),
        },
        systemReminderAttachmentEntry("output_style", "Use concise output for this turn."),
      ],
      "Create compact summary.",
    );

    expect(messages).toHaveLength(5);
    // 不传合并能力：不补换行。
    expect(messages[1]).toEqual({
      role: "user",
      content: "<system-reminder>\nprefix\n</system-reminder>",
    });
    expect(messages[2]).toEqual({
      role: "user",
      content: "summarize this history",
      cacheControl: { type: "ephemeral" },
    });
    expect(messages[3]).toMatchObject({
      role: "user",
    });
    expect(messages[3]).not.toHaveProperty("cacheControl");
    expect(messages[4]).toEqual({
      role: "system",
      content: "Use concise output for this turn.",
    });
    expect(JSON.stringify(messages[3]?.content)).toContain("Create compact summary.");
    expect(JSON.stringify(messages)).not.toContain("output_style");
  });

  it("keeps a trailing newline after the request user context system-reminder close tag", () => {
    const { messages } = buildProviderRequestMessages({
      entries: [
        { message: { role: "system", content: "system prompt" } },
        systemReminderAttachmentEntry(
          "context_prefix",
          "As you answer the user's questions, you can use the following context:\n# currentDate\nToday's date is 2026-06-28.",
        ),
        { message: { role: "user", content: "hello" }, metadata: realUserRuntimeMetadata() },
      ],
      // 补换行只在合并相邻 user 内容的协议上（Anthropic）。
      foldRemindersIntoToolResults: true,
    });

    expect(messages[1]).toEqual({
      role: "user",
      content:
        "<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# currentDate\nToday's date is 2026-06-28.\n</system-reminder>\n",
    });
  });
});
