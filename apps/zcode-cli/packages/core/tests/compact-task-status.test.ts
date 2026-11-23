import { describe, expect, it } from "vitest";
import type { RuntimeAttachmentEntry } from "../src/agent/message-history.js";
import { buildCompactTaskStatusEntries } from "../src/runtime/helpers/compact-task-status.js";
import {
  InMemoryRuntimeTaskRegistry,
  type RuntimeTaskSnapshot,
} from "../src/runtime-task/registry.js";
import { registerRuntimeBackgroundTask } from "../src/tool/executor/background-task-registry.js";

const NOW = new Date("2026-11-13T00:00:30.000Z");

function agent(overrides: Partial<RuntimeTaskSnapshot> = {}): RuntimeTaskSnapshot {
  return {
    agentId: "agent_1",
    agentType: "general-purpose",
    branchGeneration: 0,
    description: "Audit child",
    isBackgrounded: true,
    outputFile: "/tmp/agent_1.output",
    startedAt: new Date("2026-11-13T00:00:00.000Z"),
    status: "running",
    taskId: "agent_1",
    taskType: "local_agent",
    type: "local_agent",
    ...overrides,
  };
}

function shell(overrides: Partial<RuntimeTaskSnapshot> = {}): RuntimeTaskSnapshot {
  return agent({
    agentId: "b1",
    agentType: "local_bash",
    command: "sleep 30",
    description: "Audit sleep",
    outputFile: "/tmp/b1.output",
    taskId: "b1",
    taskType: "local_bash",
    type: "local_bash",
    ...overrides,
  });
}

function build(
  tasks: RuntimeTaskSnapshot[],
  options: { canContinueAgent?: boolean; canReadOutputFile?: boolean } = {},
): string[] {
  return buildCompactTaskStatusEntries({
    branchGeneration: 0,
    canContinueAgent: options.canContinueAgent ?? true,
    canReadOutputFile: options.canReadOutputFile ?? true,
    now: NOW,
    tasks,
  }).map((entry: RuntimeAttachmentEntry) => {
    expect(entry.metadata.source).toBe("task_status");
    return entry.content;
  });
}

describe("compaction task status", () => {
  it("restates running agents and background shells, agents first", () => {
    expect(build([shell(), agent()])).toEqual([
      'Background agent "Audit child" (agent_1) is still running. Do NOT spawn a duplicate. You will be notified when it completes. Send it a message with SendMessage if you need a progress report before then.',
      'Background shell b1 ("Audit sleep") is still running (command, shown on one line: `sleep 30`). Do not start it again; to restart it, stop it with TaskStop first. You can read its output at /tmp/b1.output.',
    ]);
  });

  // 结束不到 30 秒的 agent 仍在列表里；超过 30 秒的不补回。
  it("restates agents that ended less than 30 seconds ago", () => {
    const ended = (seconds: number, status: RuntimeTaskSnapshot["status"], extra = {}) =>
      agent({
        completedAt: new Date(NOW.getTime() - seconds * 1000),
        status,
        ...extra,
      });
    expect(
      build([
        ended(29, "completed", { taskId: "agent_done", description: "Done child" }),
        ended(29, "failed", { taskId: "agent_failed", error: "boom" }),
        ended(10, "killed", { taskId: "agent_stopped" }),
        ended(31, "completed", { taskId: "agent_old" }),
      ]),
    ).toEqual([
      "Task agent_done (type: local_agent) (status: completed) (description: Done child) Send it a message with SendMessage to retrieve its result.",
      "Task agent_failed (type: local_agent) (status: failed) (description: Audit child) Delta: boom Send it a message with SendMessage to retrieve its result.",
      'Task "Audit child" (agent_stopped) was stopped.',
    ]);
  });

  it("restates foreground agents like background ones", () => {
    expect(
      build([agent({ isBackgrounded: false, status: "completed", completedAt: NOW })]),
    ).toEqual([
      "Task agent_1 (type: local_agent) (status: completed) (description: Audit child) Send it a message with SendMessage to retrieve its result.",
    ]);
  });

  it("drops the SendMessage sentence without the tool and the output path without Read or Bash", () => {
    expect(
      build(
        [agent(), agent({ taskId: "agent_2", status: "completed", completedAt: NOW }), shell()],
        {
          canContinueAgent: false,
          canReadOutputFile: false,
        },
      ),
    ).toEqual([
      'Background agent "Audit child" (agent_1) is still running. Do NOT spawn a duplicate. You will be notified when it completes.',
      "Task agent_2 (type: local_agent) (status: completed) (description: Audit child)",
      'Background shell b1 ("Audit sleep") is still running (command, shown on one line: `sleep 30`). Do not start it again; to restart it, stop it with TaskStop first.',
    ]);
  });

  it("skips ended shells, workflows, tasks of other branches and shells without a command part", () => {
    expect(
      build([
        shell({ status: "completed", completedAt: NOW, taskId: "b_done" }),
        shell({ isBackgrounded: false, taskId: "b_fg" }),
        agent({ taskId: "wf", taskType: "local_dynamic_workflow", type: "local_dynamic_workflow" }),
        agent({ taskId: "agent_old_branch", branchGeneration: 1 }),
        shell({ command: undefined, outputFile: undefined, taskId: "b_plain" }),
      ]),
    ).toEqual([
      'Background shell b_plain ("Audit sleep") is still running. Do not start it again; to restart it, stop it with TaskStop first.',
    ]);
  });

  // 描述和命令压成一行再截断；agent 文字里的 & < > 写成实体。
  it("puts shell text on one line, cuts it and escapes agent text", () => {
    const [shellText] = build([
      shell({
        command: `printf 'a\n\tb'  ${"x".repeat(600)}`,
        description: `line one\nline two ${"d".repeat(250)}`,
      }),
    ]);
    const command = `printf 'a b' ${"x".repeat(600)}`;
    const description = `line one line two ${"d".repeat(250)}`;
    expect(shellText).toContain(
      `("${description.slice(0, 200)}\u2026 [+${description.length - 200} chars]")`,
    );
    expect(shellText).toContain(
      `\`${command.slice(0, 500)}\u2026 [+${command.length - 500} chars]\``,
    );
    expect(build([agent({ description: "fix <a> & b\u0007" })])[0]).toContain(
      '"fix &lt;a&gt; &amp; b&#7;"',
    );
  });

  // 不可见字符和控制字符一样去掉：零宽连接符、私用区、双向控制、格式字符、未分配码位、不成对的代理码位、BOM。
  it("drops invisible characters from shell text", () => {
    const [shellText] = build([
      shell({
        command: "echo a\u200Db\uE000c\u202Ed\u0600e\u0378f\uD800g",
        description: "x\uFEFFy\u{E0001}z",
      }),
    ]);
    expect(shellText).toContain('("xyz")');
    expect(shellText).toContain("`echo abcdefg`");
  });
});

describe("background shell registration", () => {
  it("stores the command so compaction can restate the running shell", () => {
    const runtimeTaskRegistry = new InMemoryRuntimeTaskRegistry();
    registerRuntimeBackgroundTask(
      { runtimeTaskRegistry } as never,
      {
        id: "toolu_bg",
        input: { command: "sleep 30", description: "Audit sleep", run_in_background: true },
        name: "Bash",
      } as never,
      "b1",
      { backgroundTaskId: "b1" },
    );

    expect(runtimeTaskRegistry.get("b1")).toMatchObject({
      command: "sleep 30",
      description: "Audit sleep",
      status: "running",
      type: "local_bash",
    });
  });
});
