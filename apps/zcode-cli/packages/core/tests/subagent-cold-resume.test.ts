import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createSessionId,
  createTraceId,
  createTurnId,
  type Logger,
  type SessionId,
} from "@zcode/contracts";
import {
  createExploreSubagentPort,
  readSubagentRunMetadata,
  type ExploreSubagentPortOptions,
  type ExploreSubagentRuntimeRequest,
} from "../src/subagent/runner.js";
import { createRecordingSubagentSessionStore } from "./subagent-test-store.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

// 回归 2026-11-10：registry 只在进程内存里，App 重启、进程崩溃或 session 闲置被关闭后再打开，之前的
// 子代理都不在 registry 里，SendMessage 原来直接返回找不到。新 port 模拟冷恢复后的新 runtime，
// 两个 port 只共用输出目录（metadata.json）；新 port 只能从 transcript 记下的输出文件找到它。

const PARENT_SESSION = createSessionId("parent_cold_resume");

function requestBase(name: string, sessionId: SessionId = PARENT_SESSION) {
  const turnId = createTurnId(`turn_${name}`);
  return {
    sessionId,
    trace: { traceId: createTraceId(), sessionId, turnId },
    turnId,
    workingDirectory: "/tmp",
    workspaceRoot: "/tmp",
  };
}

function sendRequest(agentId: string, sessionId: SessionId = PARENT_SESSION) {
  return {
    ...requestBase(`send_${agentId}`, sessionId),
    message: "Continue the review.",
    parentToolCallId: `call_send_${agentId}`,
    to: agentId,
  };
}

// 上一代 runtime 留下一个子代理；running 表示进程崩溃时它还在跑，metadata.json 停在 running。
// 返回它的输出文件：真实运行里结算把它写进父 transcript 的 Agent part。
async function leaveAgent(kind: "completed" | "failed" | "stopped" | "running", agentId: string) {
  const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-subagent-cold-resume-"));
  const runExploreAgent: ExploreSubagentPortOptions["runExploreAgent"] = async (request, opts) => {
    await request.onSessionReady?.();
    if (kind === "failed") throw new Error("Provider rate limited the request (HTTP 429)");
    if (kind === "completed") return { events: [], response: "Done.", traceId: "trace_done" };
    // stopped 等到被停止；running 一直不结束。
    return new Promise((_, reject) =>
      opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
    );
  };
  const port = createExploreSubagentPort({
    createAgentId: () => agentId,
    emitParentEvent: async () => {},
    enqueueParentTaskNotification: () => {},
    outputRootDir,
    runExploreAgent,
  });
  const run = {
    ...requestBase(`run_${agentId}`),
    agentType: "general-purpose",
    description: `Review for ${agentId}`,
    parentToolCallId: `call_agent_${agentId}`,
    prompt: "Review the module.",
  };
  if (kind === "completed" || kind === "failed") {
    await port.run(run).catch(() => undefined);
  } else {
    await port.start?.(run);
    if (kind === "stopped") await port.stopTask?.(agentId, { initiator: "user" });
  }
  return { agentId, outputFile: join(outputRootDir, PARENT_SESSION, agentId, "output.txt") };
}

// 冷恢复后的新 runtime：registry 是空的；父会话 resume 时从 transcript 建好的 agentId → outputFile 索引
// 这里直接给出（inTranscript=false 表示 transcript 里没有它）。child session 的最后写入时间由 session store
// 给出，"missing" 表示没有这个 child session。新 port 用另一个输出根目录：路径只能来自索引，不按配置推算。
function nextPort(
  previous: { agentId: string; outputFile: string },
  childUpdatedAt: number | "missing",
  { inTranscript = true }: { inTranscript?: boolean } = {},
) {
  const resumed: ExploreSubagentRuntimeRequest[] = [];
  const info = vi.fn();
  const port = createExploreSubagentPort({
    emitParentEvent: async () => {},
    enqueueParentTaskNotification: () => {},
    findTranscriptAgentOutputFile: (agentId) =>
      inTranscript && agentId === previous.agentId ? previous.outputFile : undefined,
    logger: { debug() {}, info, warn() {}, error() {} } as unknown as Logger,
    outputRootDir: join(tmpdir(), `zcode-subagent-cold-resume-other-${crypto.randomUUID()}`),
    readChildSessionUpdatedAt: async () =>
      childUpdatedAt === "missing" ? undefined : childUpdatedAt,
    runExploreAgent: async (request) => {
      resumed.push(request);
      await request.onSessionReady?.();
      return { events: [], response: "Resumed findings.", traceId: "trace_cold_resumed" };
    },
  });
  // 找回结果只看 cold_restore 这一条 info 日志。
  const coldRestoreLogs = () =>
    info.mock.calls
      .map(([, context]) => context as Record<string, unknown>)
      .filter((context) => context?.event === "subagent.send_message.cold_restore");
  return { coldRestoreLogs, port, resumed };
}

// child 在本进程启动前就不再写入：running 是被进程退出中断的。
const BEFORE_THIS_PROCESS = performance.timeOrigin - 1_000;

describe("SendMessage after a cold resume", () => {
  it.each([
    ["completed", "completed", 0],
    ["failed", "failed", 0],
    ["stopped", "killed", 0],
    ["running", "failed", BEFORE_THIS_PROCESS],
  ] as const)(
    "resumes a %s agent of the previous runtime from its metadata",
    async (kind, status, childUpdatedAt) => {
      const agentId = `agent_cold_${kind}`;
      const previous = await leaveAgent(kind, agentId);
      const { coldRestoreLogs, port, resumed } = nextPort(previous, childUpdatedAt);

      const result = await port.sendMessage!(sendRequest(agentId));

      expect(result).toMatchObject({ status: "success", delivery: "resumed_background" });
      expect(coldRestoreLogs()).toEqual([
        expect.objectContaining({
          agentId,
          metadataStatus: kind,
          outcome: "snapshot_rebuilt",
          restoredStatus: status,
        }),
      ]);
      expect(result.message).toContain(`was stopped (${status})`);
      expect(resumed).toHaveLength(1);
      expect(resumed[0]).toMatchObject({
        prompt: "Continue the review.",
        resumeFromStore: true,
        sessionId: createSessionId(`subagent_${agentId}`),
      });
      expect((await port.waitForTask?.(agentId))?.status).toBe("completed");
      // 恢复的运行写回原来的输出目录：下次冷恢复按 transcript 记下的同一个路径读到最新状态。
      expect(await readFile(previous.outputFile, "utf8")).toContain("Resumed findings.");
      expect(await readSubagentRunMetadata(previous)).toMatchObject({ status: "completed" });
    },
  );

  it.each([
    [
      "that the transcript does not record",
      "completed",
      PARENT_SESSION,
      0,
      false,
      { outcome: "not_in_transcript" },
    ],
    // 路径来自 transcript，不随请求的会话变：metadata.json 里的 parentSessionId 对不上就不恢复。
    [
      "of another parent session",
      "completed",
      createSessionId("other"),
      0,
      true,
      { mismatch: ["parentSessionId"], outcome: "metadata_mismatch" },
    ],
    [
      "without a child session",
      "completed",
      PARENT_SESSION,
      "missing",
      true,
      { outcome: "child_session_missing" },
    ],
    // child 在本进程启动后还有写入：可能另一个进程正在运行它。
    [
      "still written after this process started",
      "running",
      PARENT_SESSION,
      Date.now(),
      true,
      { outcome: "may_be_running_elsewhere" },
    ],
  ] as const)(
    "does not find an agent %s",
    async (_case, kind, sessionId, childUpdatedAt, inTranscript, expectedLog) => {
      const { coldRestoreLogs, port, resumed } = nextPort(
        await leaveAgent(kind, "agent_cold_lookup"),
        childUpdatedAt,
        { inTranscript },
      );

      const result = await port.sendMessage!(sendRequest("agent_cold_lookup", sessionId));

      expect(result).toMatchObject({ status: "failed" });
      expect(result.error).toBe(
        "No agent named 'agent_cold_lookup' is reachable.\nUse the agentId returned in the Agent result to message a local agent.",
      );
      expect(resumed).toHaveLength(0);
      expect(coldRestoreLogs()).toEqual([
        expect.objectContaining({ agentId: "agent_cold_lookup", ...expectedLog }),
      ]);
    },
  );

  it("does not find an agent whose metadata.json is gone", async () => {
    const previous = await leaveAgent("completed", "agent_cold_cleaned");
    await rm(join(dirname(previous.outputFile), "metadata.json"));
    const { coldRestoreLogs, port, resumed } = nextPort(previous, 0);

    const result = await port.sendMessage!(sendRequest(previous.agentId));

    expect(result.error).toBe(
      `No agent named '${previous.agentId}' is reachable.\nUse the agentId returned in the Agent result to message a local agent.`,
    );
    expect(resumed).toHaveLength(0);
    expect(coldRestoreLogs()).toEqual([expect.objectContaining({ outcome: "no_metadata" })]);
  });

  it("starts one runtime when two SendMessage calls race for the same cold agent", async () => {
    const { port, resumed } = nextPort(await leaveAgent("completed", "agent_cold_race"), 0);

    const results = await Promise.all([
      port.sendMessage!(sendRequest("agent_cold_race")),
      port.sendMessage!(sendRequest("agent_cold_race")),
    ]);

    expect(resumed).toHaveLength(1);
    expect(results.map((result) => result.status)).toEqual(["success", "success"]);
    expect(results.filter((result) => result.delivery === "resumed_background")).toHaveLength(1);
  });

  it("continues the child history after the parent runtime is closed and opened again", async () => {
    // 两个 runtime 只共用 session store 与输出目录：第一个关闭后（App 重启、session 闲置被关闭），
    // 第二个的 registry 是空的，event store 也是新的。
    const sessionId = createSessionId(`runtime-cold-resume-${crypto.randomUUID()}`);
    const sessionStore = createRecordingSubagentSessionStore();
    const config = {
      mode: "build" as const,
      workingDirectory: "/workspace/project",
      subagents: { outputRootDir: await mkdtemp(join(tmpdir(), "zcode-subagent-cold-runtime-")) },
    };
    const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
    let parentCalls = 0;
    const first = createTestAgentRuntime(sessionId, config, {
      eventStore: createTestSessionEventStore(),
      sessionStore,
      modelFactory: createTestModelFactory({
        async generateText(_request: unknown, observation: any) {
          if (observation.invocationContext?.metadata?.querySource === "subagent") {
            return { finishReason: "stop", text: "Findings: module A is fine.", usage };
          }
          parentCalls++;
          if (parentCalls > 1) return { finishReason: "stop", text: "parent done", usage };
          const input = { description: "Review", prompt: "Review.", subagent_type: "Explore" };
          return {
            finishReason: "tool-calls",
            text: "",
            toolCalls: [{ id: "call_cold_explore", name: "Agent", input }],
            usage,
          };
        },
      } as never),
    });
    await first.executeTurn("Use an explore agent to review the module");
    // Agent 在 compact 之前派生：resume 后 active 分支从 compact 处开始，索引用全部消息才找得到它。
    await first.executeTurn("/compact");
    const [agentId] = Object.keys(
      (first as unknown as { runtimeTaskRegistry: { all(): object } }).runtimeTaskRegistry.all(),
    );
    await first.close();

    const resumedChildMessages: string[] = [];
    const second = createTestAgentRuntime(sessionId, config, {
      eventStore: createTestSessionEventStore(),
      sessionStore,
      modelFactory: createTestModelFactory({
        async generateText(request: { messages: unknown }) {
          resumedChildMessages.push(JSON.stringify(request.messages));
          return { finishReason: "stop", text: "Final review report.", usage };
        },
      } as never),
    });
    // 冷恢复的索引在 resume 时从父 transcript 建：之后才能按 agentId 找到上一代的子代理。
    await second.resumeFromStore();
    const subagentPort = (second as unknown as { subagentPort: any }).subagentPort;

    const result = await subagentPort.sendMessage(sendRequest(agentId!, sessionId));

    expect(result).toMatchObject({ status: "success", delivery: "resumed_background" });
    expect(await subagentPort.waitForTask(agentId)).toMatchObject({ status: "completed" });
    expect(resumedChildMessages[0]).toContain("Findings: module A is fine.");
    expect(resumedChildMessages[0]).toContain("Continue the review.");
    await second.close();
  });
});
