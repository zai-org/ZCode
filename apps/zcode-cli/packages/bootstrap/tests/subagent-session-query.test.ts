import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSessionId,
  SessionEventType,
  STREAM_RECOVERY_DISCARDED_ERROR_NAME,
  STREAM_RECOVERY_DISCARDED_FINISH,
  type MessageWithParts,
  type SessionEvent,
  type SessionInfo,
  type SessionProjection,
  type ToolPart,
} from "@zcode/contracts";
import type { SubagentRunMetadata } from "@zcode/core";
import { createSubagentObservation } from "../src/app/subagent-observation.js";
import { listSessionSubagents } from "../src/zcode-protocol/server-operations.js";
import {
  loadPreviousRuntimeRunMetadata,
  paginateEndedSubagents,
  projectSessionSubagents,
} from "../src/zcode-protocol/subagent-session-query.js";

function session(id: string, taskType: SessionInfo["taskType"] = "subagent_child"): SessionInfo {
  return {
    id: id as SessionInfo["id"],
    projectID: "project" as SessionInfo["projectID"],
    taskType,
    slug: id,
    directory: "/workspace",
    title: id,
    version: "test",
    time: { created: 1, updated: 100 },
  };
}

function toolMessage(input: {
  childSessionId?: string;
  id: string;
  output?: Record<string, unknown> | string;
  runInBackground?: boolean;
  state?: "completed" | "error" | "running";
  tool?: string;
}): MessageWithParts {
  const state = input.state ?? "completed";
  const common = {
    input: {
      description: `Description ${input.id}`,
      subagent_type: "Explore",
      ...(input.runInBackground ? { run_in_background: true } : {}),
    },
    metadata: input.childSessionId ? { childSessionId: input.childSessionId } : {},
    time: state === "running" ? { start: 10 } : { start: 10, end: 20 },
  };
  const part: ToolPart = {
    id: `part-${input.id}` as ToolPart["id"],
    sessionID: "parent" as ToolPart["sessionID"],
    messageID: input.id as ToolPart["messageID"],
    type: "tool",
    callID: `call-${input.id}`,
    tool: input.tool ?? "Agent",
    state:
      state === "running"
        ? { ...common, status: "running" }
        : state === "error"
          ? { ...common, status: "error", error: "Provider failed" }
          : {
              ...common,
              status: "completed",
              output:
                typeof input.output === "string"
                  ? input.output
                  : JSON.stringify(input.output ?? { result: `Summary ${input.id}` }),
              title: `Description ${input.id}`,
            },
  };
  return {
    info: {
      id: input.id as never,
      sessionID: "parent" as never,
      role: "assistant",
      time: { created: 10, completed: 20 },
      parentID: "user" as never,
      modelID: "model" as never,
      providerID: "provider" as never,
      mode: "build",
      agent: "zcode",
      path: { cwd: "/workspace", root: "/workspace" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [part],
  };
}

function projection(status: SessionProjection["status"]): SessionProjection {
  return {
    id: "child" as never,
    createdAt: new Date(1),
    updatedAt: new Date(2),
    mode: "build",
    status,
    turnCount: 1,
    totalTokenCount: 0,
    contextUsed: 0,
    contextWindow: 1,
    pendingPermissions: [],
    pendingSteerInputs: [],
    activeToolCalls: [],
    streamingToolLedger: [],
    backgroundTasks: [],
    targetCompletionVerifications: [],
    targetCompletionVerificationTimeline: [],
  };
}

function subagentEvent(
  type: typeof SessionEventType.SubagentSpawned | typeof SessionEventType.SubagentStopped,
  payload: Record<string, unknown>,
): SessionEvent {
  return {
    id: "event" as never,
    sessionId: "parent" as never,
    type,
    timestamp: new Date(15),
    traceId: "trace" as never,
    sequenceNumber: 1,
    payload,
  };
}

describe("subagent session query", () => {
  it("projects Agent and legacy Task refs but omits non-persisted children", () => {
    const result = projectSessionSubagents({
      revision: 3,
      parentSession: session("parent", "interactive"),
      messages: [
        toolMessage({ childSessionId: "child-agent", id: "m1" }),
        toolMessage({ childSessionId: "child-task", id: "m2", tool: "Task" }),
        toolMessage({ childSessionId: "missing", id: "m3" }),
      ],
      childSessionsById: new Map([
        ["child-agent", session("child-agent")],
        ["child-task", session("child-task")],
      ]),
      childMessagesById: new Map(),
      childProjectionsById: new Map(),
    });

    expect(result.running).toEqual([]);
    expect(result.ended.map((item) => item.childSessionId)).toEqual(["child-task", "child-agent"]);
    expect(result.ended[0]).toMatchObject({
      status: "success",
      subagentType: "Explore",
      summary: "Summary m2",
    });
  });

  it("uses live child and background state without duplicating the persisted ref", () => {
    const parentProjection = projection("running");
    parentProjection.backgroundTasks = [
      {
        taskId: "agent-1",
        taskKind: "subagent",
        childSessionId: "child-1",
        blocked: true,
        status: "running",
        startedAt: new Date(10),
      },
    ];
    const result = projectSessionSubagents({
      revision: 4,
      parentSession: session("parent", "interactive"),
      messages: [toolMessage({ childSessionId: "child-1", id: "m1", state: "running" })],
      childSessionsById: new Map([["child-1", session("child-1")]]),
      childMessagesById: new Map(),
      childProjectionsById: new Map([["child-1", projection("waiting")]]),
      parentProjection,
    });

    expect(result.ended).toEqual([]);
    expect(result.running).toEqual([
      expect.objectContaining({ childSessionId: "child-1", status: "blocked" }),
    ]);
  });

  it("uses live spawn events for foreground children before the Agent result is persisted", () => {
    const parentProjection = projection("running");
    parentProjection.backgroundTasks = [
      {
        taskId: "agent-live",
        taskKind: "subagent",
        childSessionId: "child-live",
        status: "running",
        startedAt: new Date(10),
      },
    ];
    const result = projectSessionSubagents({
      revision: 5,
      parentSession: session("parent", "interactive"),
      messages: [toolMessage({ id: "m1", state: "running" })],
      childSessionsById: new Map([["child-live", session("child-live")]]),
      childMessagesById: new Map(),
      childProjectionsById: new Map(),
      parentEvents: [
        subagentEvent(SessionEventType.SubagentSpawned, {
          agentId: "agent-live",
          agentType: "Explore",
          childSessionId: "child-live",
          parentToolCallId: "call-m1",
          description: "Live foreground Agent",
        }),
      ],
      parentProjection,
    });

    expect(result.running).toEqual([
      expect.objectContaining({ childSessionId: "child-live", status: "running" }),
    ]);
  });

  it("keeps a launched background child running when a partial projection omits its task", () => {
    const childSessionId = "sess_subagent_agent-keepalive";
    const result = projectSessionSubagents({
      revision: 6,
      parentSession: session("parent", "interactive"),
      messages: [
        toolMessage({
          childSessionId,
          id: "m1",
          output:
            "Async agent launched successfully.\nagentId: agent-keepalive\nThe agent is working in the background.",
          runInBackground: true,
        }),
      ],
      childSessionsById: new Map([[childSessionId, session(childSessionId)]]),
      childMessagesById: new Map([[childSessionId, []]]),
      childProjectionsById: new Map(),
    });

    expect(result.ended).toEqual([]);
    expect(result.running).toEqual([
      expect.objectContaining({ childSessionId, status: "running" }),
    ]);
  });

  it("does not treat a completed child tool-call model step as a terminal child outcome", () => {
    const childSessionId = "sess_subagent_agent-child-tool";
    const childToolStep = toolMessage({
      id: "child-tool-step",
      state: "running",
      tool: "Bash",
    });
    childToolStep.info.time.completed = 30;
    childToolStep.info.finish = "tool-calls";

    const result = projectSessionSubagents({
      revision: 7,
      parentSession: session("parent", "interactive"),
      messages: [
        toolMessage({
          childSessionId,
          id: "m1",
          output:
            "Async agent launched successfully.\nagentId: agent-child-tool\nThe agent is working in the background.",
          runInBackground: true,
        }),
      ],
      childSessionsById: new Map([[childSessionId, session(childSessionId)]]),
      childMessagesById: new Map([[childSessionId, [childToolStep]]]),
      childProjectionsById: new Map(),
      parentEvents: [
        subagentEvent(SessionEventType.SubagentSpawned, {
          agentId: "agent-child-tool",
          childSessionId,
          parentToolCallId: "call-m1",
          description: "Child tool Agent",
        }),
      ],
    });

    expect(result.ended).toEqual([]);
    expect(result.running).toEqual([
      expect.objectContaining({ childSessionId, status: "running" }),
    ]);
  });

  it("does not treat a stream recovery discarded child step as a failed child outcome", () => {
    const childSessionId = "sess_subagent_agent-child-discarded";
    const discardedStep = toolMessage({ id: "child-discarded", state: "running", tool: "Bash" });
    discardedStep.parts = [];
    discardedStep.info.time.completed = 30;
    discardedStep.info.finish = STREAM_RECOVERY_DISCARDED_FINISH;
    discardedStep.info.error = {
      name: STREAM_RECOVERY_DISCARDED_ERROR_NAME,
      data: { message: "Partial assistant output was discarded before a streaming retry." },
    };

    const result = projectSessionSubagents({
      revision: 8,
      parentSession: session("parent", "interactive"),
      messages: [
        toolMessage({
          childSessionId,
          id: "m1",
          output:
            "Async agent launched successfully.\nagentId: agent-child-discarded\nThe agent is working in the background.",
          runInBackground: true,
        }),
      ],
      childSessionsById: new Map([[childSessionId, session(childSessionId)]]),
      childMessagesById: new Map([[childSessionId, [discardedStep]]]),
      childProjectionsById: new Map(),
      parentEvents: [
        subagentEvent(SessionEventType.SubagentSpawned, {
          agentId: "agent-child-discarded",
          childSessionId,
          parentToolCallId: "call-m1",
          description: "Child discarded Agent",
        }),
      ],
    });

    expect(result.ended).toEqual([]);
    expect(result.running).toEqual([
      expect.objectContaining({ childSessionId, status: "running" }),
    ]);
  });

  describe("leftovers of a previous runtime process", () => {
    // 样本时间：父会话里的 Agent 在 t=10 启动，child 最后一步在 t=30、会话最后更新在 t=100，
    // 新进程在 t=1000 启动。
    const RUNTIME_STARTED_AT = 1_000;
    const launchAck = (agentId: string) =>
      `Async agent launched successfully.\nagentId: ${agentId}\nThe agent is working in the background.`;

    it("ends a background child launched before this process with no live fact as lost", () => {
      const childSessionId = "sess_subagent_agent-orphan";
      const childToolStep = toolMessage({ id: "child-step", state: "running", tool: "Bash" });
      childToolStep.info.time.completed = 30;
      childToolStep.info.finish = "tool-calls";

      const result = projectSessionSubagents({
        revision: 9,
        parentSession: session("parent", "interactive"),
        messages: [
          toolMessage({
            childSessionId,
            id: "m1",
            output: launchAck("agent-orphan"),
            runInBackground: true,
          }),
        ],
        childSessionsById: new Map([[childSessionId, session(childSessionId)]]),
        childMessagesById: new Map([[childSessionId, [childToolStep]]]),
        childProjectionsById: new Map(),
        parentProjection: projection("idle"),
        runtimeStartedAt: RUNTIME_STARTED_AT,
      });

      expect(result.running).toEqual([]);
      expect(result.ended).toEqual([
        expect.objectContaining({ childSessionId, status: "lost", endedAt: 30 }),
      ]);
    });

    it("ends a foreground Agent part left running by the previous process as lost", () => {
      const result = projectSessionSubagents({
        revision: 10,
        parentSession: session("parent", "interactive"),
        messages: [toolMessage({ childSessionId: "child-fg", id: "m1", state: "running" })],
        childSessionsById: new Map([["child-fg", session("child-fg")]]),
        childMessagesById: new Map(),
        childProjectionsById: new Map(),
        parentProjection: projection("idle"),
        runtimeStartedAt: RUNTIME_STARTED_AT,
      });

      expect(result.running).toEqual([]);
      expect(result.ended).toEqual([
        expect.objectContaining({ childSessionId: "child-fg", status: "lost" }),
      ]);
    });

    it("keeps a child running when its session was updated after this process started", () => {
      // 另一个进程（例如终端 TUI）仍在运行它：本进程没有活事实，但 child 仍在落盘。
      const childSessionId = "sess_subagent_agent-elsewhere";
      const child = session(childSessionId);
      child.time.updated = RUNTIME_STARTED_AT + 5;

      const result = projectSessionSubagents({
        revision: 11,
        parentSession: session("parent", "interactive"),
        messages: [
          toolMessage({
            childSessionId,
            id: "m1",
            output: launchAck("agent-elsewhere"),
            runInBackground: true,
          }),
        ],
        childSessionsById: new Map([[childSessionId, child]]),
        childMessagesById: new Map([[childSessionId, []]]),
        childProjectionsById: new Map(),
        runtimeStartedAt: RUNTIME_STARTED_AT,
      });

      expect(result.ended).toEqual([]);
      expect(result.running).toEqual([
        expect.objectContaining({ childSessionId, status: "running" }),
      ]);
    });

    it("keeps a child resumed in this process running", () => {
      const childSessionId = "sess_subagent_agent-resumed";
      const resumed = subagentEvent(SessionEventType.SubagentSpawned, {
        agentId: "agent-resumed",
        childSessionId,
        parentToolCallId: "call-m1",
        description: "Resumed Agent",
      });
      resumed.timestamp = new Date(RUNTIME_STARTED_AT + 10);

      const result = projectSessionSubagents({
        revision: 12,
        parentSession: session("parent", "interactive"),
        messages: [
          toolMessage({
            childSessionId,
            id: "m1",
            output: launchAck("agent-resumed"),
            runInBackground: true,
          }),
        ],
        childSessionsById: new Map([[childSessionId, session(childSessionId)]]),
        childMessagesById: new Map([[childSessionId, []]]),
        childProjectionsById: new Map(),
        parentEvents: [resumed],
        runtimeStartedAt: RUNTIME_STARTED_AT,
      });

      expect(result.ended).toEqual([]);
      expect(result.running).toEqual([
        expect.objectContaining({ childSessionId, status: "running" }),
      ]);
    });

    it("keeps a known stop of a previous-process Agent instead of relabeling it lost", () => {
      // 旧进程正常关闭时停止了它（SubagentStopped(stopped)），child 停在工具调用、没有错误：
      // 已知终态优先，不能被「上一代遗留」改写成 lost，结束时间也取 stoppedAt（!3562 评审 SG-01）。
      const childSessionId = "sess_subagent_agent-stopped";
      const childToolStep = toolMessage({ id: "child-step", state: "running", tool: "Bash" });
      childToolStep.info.time.completed = 30;
      childToolStep.info.finish = "tool-calls";
      const spawned = subagentEvent(SessionEventType.SubagentSpawned, {
        agentId: "agent-stopped",
        childSessionId,
        parentToolCallId: "call-m1",
        description: "Stopped Agent",
      });
      spawned.timestamp = new Date(12);
      const stopped = subagentEvent(SessionEventType.SubagentStopped, {
        agentId: "agent-stopped",
        childSessionId,
        parentToolCallId: "call-m1",
        status: "stopped",
      });
      stopped.timestamp = new Date(40);

      const result = projectSessionSubagents({
        revision: 13,
        parentSession: session("parent", "interactive"),
        messages: [
          toolMessage({
            childSessionId,
            id: "m1",
            output: launchAck("agent-stopped"),
            runInBackground: true,
          }),
        ],
        childSessionsById: new Map([[childSessionId, session(childSessionId)]]),
        childMessagesById: new Map([[childSessionId, [childToolStep]]]),
        childProjectionsById: new Map(),
        parentEvents: [spawned, stopped],
        parentProjection: projection("idle"),
        runtimeStartedAt: RUNTIME_STARTED_AT,
      });

      expect(result.running).toEqual([]);
      expect(result.ended).toEqual([
        expect.objectContaining({ childSessionId, status: "cancelled", endedAt: 40 }),
      ]);
    });
  });

  it("derives the persisted foreground child id from the completed Agent output agentId", () => {
    const result = projectSessionSubagents({
      revision: 6,
      parentSession: session("parent", "interactive"),
      messages: [
        toolMessage({
          id: "m1",
          output: { agentId: "agent-foreground", result: "Finished foreground work" },
        }),
      ],
      childSessionsById: new Map([
        ["sess_subagent_agent-foreground", session("sess_subagent_agent-foreground")],
      ]),
      childMessagesById: new Map(),
      childProjectionsById: new Map(),
    });

    expect(result.ended).toEqual([
      expect.objectContaining({
        childSessionId: "sess_subagent_agent-foreground",
        summary: "Finished foreground work",
        status: "success",
      }),
    ]);
  });

  it("paginates ended children newest-first with an opaque cursor", () => {
    const ended = Array.from({ length: 25 }, (_, index) => ({
      childSessionId: `child-${index}`,
      subagentType: "Explore",
      title: `Child ${index}`,
      status: "success" as const,
      endedAt: 100 - index,
    }));
    const first = paginateEndedSubagents(ended, { limit: 20 });
    const second = paginateEndedSubagents(ended, { cursor: first.nextCursor, limit: 20 });

    expect(first.items).toHaveLength(20);
    expect(first.nextCursor).toBeTruthy();
    expect(second.items.map((item) => item.childSessionId)).toEqual([
      "child-20",
      "child-21",
      "child-22",
      "child-23",
      "child-24",
    ]);
    expect(second.nextCursor).toBeUndefined();
  });
});

// 上一代 runtime 写下的终态只在子代理输出目录的 metadata.json 里跨进程保留；冷查询读不到旧进程内存里的
// SubagentStopped（!3562 评审第二轮 CR-01）。样本时间：Agent 在 t=10 启动、child 最后一步 t=30、
// 会话最后更新 t=100；新进程在 t=1000 启动。
describe("previous runtime terminal facts from metadata.json", () => {
  const RUNTIME_STARTED_AT = 1_000;
  const PARENT_ID = "parent";
  let outputRoot = "";
  beforeEach(async () => {
    outputRoot = await mkdtemp(join(tmpdir(), "zcode-subagent-metadata-"));
  });
  afterEach(async () => {
    await rm(outputRoot, { recursive: true, force: true });
  });

  const launchAck = (agentId: string, outputDir?: string) =>
    [
      "Async agent launched successfully. (This tool result is internal metadata.)",
      `agentId: ${agentId} (internal ID - do not mention to user.)`,
      "The agent is working in the background.",
      ...(outputDir ? [`output_file: ${join(outputDir, "output.txt")}`] : []),
    ].join("\n");

  function childStuckInTool(): MessageWithParts {
    const step = toolMessage({ id: "child-step", state: "running", tool: "Bash" });
    step.info.time.completed = 30;
    step.info.finish = "tool-calls";
    return step;
  }

  function childFailed(): MessageWithParts {
    const step = toolMessage({ id: "child-failed", state: "running", tool: "Bash" });
    step.parts = [];
    step.info.error = { name: "APIError", data: { message: "provider returned 500" } };
    return step;
  }

  function coldInput(agentId: string, runMetadata?: SubagentRunMetadata) {
    const childSessionId = createSessionId(`subagent_${agentId}`);
    return {
      childSessionId,
      input: {
        revision: 20,
        parentSession: session(PARENT_ID, "interactive"),
        messages: [
          toolMessage({
            childSessionId,
            id: "m1",
            output: launchAck(agentId),
            runInBackground: true,
          }),
        ],
        childSessionsById: new Map([[childSessionId, session(childSessionId)]]),
        childMessagesById: new Map([[childSessionId, [childStuckInTool()]]]),
        childProjectionsById: new Map(),
        runtimeStartedAt: RUNTIME_STARTED_AT,
        ...(runMetadata
          ? { previousRuntimeRunMetadata: new Map([[childSessionId, runMetadata]]) }
          : {}),
      },
    };
  }

  it.each([
    ["stopped", "cancelled"],
    ["failed", "failed"],
    ["completed", "success"],
  ] as const)(
    "projects metadata.json %s of a previous-process Agent without parent events as %s",
    (metadataStatus, status) => {
      // 正常关闭时 owner 统一 stopTask：metadata.json 写 stopped，child 停在工具调用、没有错误。
      const { childSessionId, input } = coldInput("agent-meta", {
        status: metadataStatus,
        completedAt: 50,
      });
      const result = projectSessionSubagents(input);
      expect(result.running).toEqual([]);
      expect(result.ended).toEqual([
        expect.objectContaining({ childSessionId, status, endedAt: 50 }),
      ]);
    },
  );

  it("keeps lost when metadata.json is still running or missing", () => {
    for (const runMetadata of [{ status: "running" } as const, undefined]) {
      const { childSessionId, input } = coldInput("agent-meta", runMetadata);
      expect(projectSessionSubagents(input).ended).toEqual([
        expect.objectContaining({ childSessionId, status: "lost", endedAt: 30 }),
      ]);
    }
  });

  it("ends a cold background Agent whose child failed as failed, not success", () => {
    // 修复前按 launch ACK 的 completed 判 success（与是否上一代无关的原有问题）。
    const { childSessionId, input } = coldInput("agent-child-failed");
    const result = projectSessionSubagents({
      ...input,
      childMessagesById: new Map([[childSessionId, [childFailed()]]]),
      runtimeStartedAt: undefined,
    });
    expect(result.ended).toEqual([expect.objectContaining({ childSessionId, status: "failed" })]);
  });

  async function writeMetadata(outputDir: string, agentId: string, status: string) {
    await mkdir(outputDir, { recursive: true });
    await writeFile(
      join(outputDir, "metadata.json"),
      JSON.stringify({ agentId, status, completedAt: new Date(50).toISOString() }),
    );
  }

  it("preloads metadata.json from output_file or the configured output root", async () => {
    const fromAck = join(outputRoot, "User With Space", "agent-ack");
    await writeMetadata(fromAck, "agent-ack", "stopped");
    await writeMetadata(join(outputRoot, PARENT_ID, "agent-root"), "agent-root", "failed");
    await writeMetadata(join(outputRoot, PARENT_ID, "agent-new"), "agent-new", "stopped");
    const launchedNow = toolMessage({
      childSessionId: createSessionId("subagent_agent-new"),
      id: "m3",
      output: launchAck("agent-new"),
      runInBackground: true,
    });
    const newPart = launchedNow.parts[0] as ToolPart;
    if ("time" in newPart.state) newPart.state.time.start = RUNTIME_STARTED_AT + 5;
    let rootResolutions = 0;

    const metadata = await loadPreviousRuntimeRunMetadata({
      parentSession: session(PARENT_ID, "interactive"),
      messages: [
        toolMessage({ id: "m1", output: launchAck("agent-ack", fromAck), runInBackground: true }),
        toolMessage({ id: "m2", output: launchAck("agent-root"), runInBackground: true }),
        launchedNow,
      ],
      runtimeStartedAt: RUNTIME_STARTED_AT,
      resolveOutputRootDir: () => {
        rootResolutions += 1;
        return outputRoot;
      },
    });

    expect(metadata.get(createSessionId("subagent_agent-ack"))).toMatchObject({
      status: "stopped",
    });
    expect(metadata.get(createSessionId("subagent_agent-root"))).toMatchObject({
      status: "failed",
      completedAt: 50,
    });
    // 本进程启动的 Agent 不是遗留候选，不读。
    expect(metadata.has(createSessionId("subagent_agent-new"))).toBe(false);
    expect(rootResolutions).toBe(1);
  });

  function coldStore(agentId: string, outputDir: string | undefined) {
    const childSessionId = createSessionId(`subagent_${agentId}`);
    const parent = session(PARENT_ID, "interactive");
    const child = { ...session(childSessionId), parentID: PARENT_ID as SessionInfo["id"] };
    const messages = new Map<string, MessageWithParts[]>([
      [
        PARENT_ID,
        [
          toolMessage({
            childSessionId,
            id: "m1",
            output: launchAck(agentId, outputDir),
            runInBackground: true,
          }),
        ],
      ],
      [childSessionId, [childStuckInTool()]],
    ]);
    const sessions = new Map<string, SessionInfo>([
      [PARENT_ID, parent],
      [childSessionId, child],
    ]);
    return {
      childSessionId,
      store: {
        async getSession(id: string) {
          return sessions.get(id);
        },
        async messages(input: { sessionID: string }) {
          return messages.get(input.sessionID) ?? [];
        },
      },
    };
  }

  it("projects a normally stopped previous-process Agent as cancelled in the V4 cold query", async () => {
    // 真实冷查询：没有 live parent，parentEvents 为空，终态只能从 metadata.json 读。
    const outputDir = join(outputRoot, PARENT_ID, "agent-cold");
    await writeMetadata(outputDir, "agent-cold", "stopped");
    const { childSessionId, store } = coldStore("agent-cold", outputDir);
    const result = await listSessionSubagents(
      { deps: { sessionStore: store }, sessions: new Map() } as never,
      { sessionId: PARENT_ID },
    );
    expect(result.running).toEqual([]);
    expect(result.ended.items).toEqual([
      expect.objectContaining({ childSessionId, status: "cancelled", endedAt: 50 }),
    ]);
  });

  it("projects a normally stopped previous-process Agent as cancelled in the TUI observation", async () => {
    // launch ACK 不带 output_file：按配置的存储目录 <storage>/cli/agents/<父会话>/<agentId> 找。
    const cliRoot = join(outputRoot, "cli");
    await writeMetadata(join(cliRoot, "agents", PARENT_ID, "agent-tui"), "agent-tui", "stopped");
    const { childSessionId, store } = coldStore("agent-tui", undefined);
    const observation = createSubagentObservation({
      sessionId: PARENT_ID as never,
      sessionStore: store as never,
      runtime: {
        getSessionEventStore: () => ({
          getEvents: async () => [],
          getLatestSequenceNumber: async () => 0,
        }),
        getProjection: async () => undefined,
      } as never,
      configResult: { config: { storage: { dir: cliRoot } } } as never,
    });
    const result = await observation.readSubagents();
    expect(result.running).toEqual([]);
    expect(result.ended.items).toEqual([
      expect.objectContaining({ childSessionId, status: "cancelled", endedAt: 50 }),
    ]);
  });
});
