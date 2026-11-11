import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSessionId,
  modelMessageContentToText,
  type ModelInputMessage,
  type SessionStorePort,
} from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { createRecordingMessageStore } from "./runtime-output-token-continuation-test-helpers.js";
import { InMemoryRuntimeTaskRegistry } from "../src/runtime-task/index.js";
import type { SubagentRunMetadataStatus } from "../src/subagent/runner.js";

// 上一代 runtime 进程（如因系统内存耗尽）崩溃后，恢复父会话时对账仍在后台运行的 Agent。
// 样本时间都远早于本测试进程的 performance.timeOrigin，即「上一代进程」留下的记录。
const PARENT_ID = createSessionId("previous-runtime-parent");
const OLD = { created: 1_000, launched: 1_500, childUpdated: 1_600 };

// 每个用例一个临时 Agent 输出根目录，metadata.json 按 runner 的布局放在 <root>/<父会话>/<agentId>/ 下。
let outputRoot = "";
beforeEach(async () => {
  outputRoot = await mkdtemp(join(tmpdir(), "zcode-previous-runtime-"));
});
afterEach(async () => {
  await rm(outputRoot, { recursive: true, force: true });
});

const agentOutputDir = (agentId: string) => join(outputRoot, PARENT_ID, agentId);

function launchAck(agentId: string, outputDir: string | undefined): string {
  return [
    "Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)",
    `agentId: ${agentId} (internal ID - do not mention to user. Use SendMessage with to: '${agentId}', summary: '<5-10 word recap>' to continue this agent.)`,
    "The agent is working in the background. You will be notified automatically when it completes.",
    ...(outputDir ? [`output_file: ${join(outputDir, "output.txt")}`] : []),
  ].join("\n");
}

interface AgentSeed {
  agentId: string;
  description: string;
  /** child 最后一条 assistant：tool 停在工具调用（崩溃时的样子），text 不含工具的完成回复，error 带错误。 */
  child: "tool" | "text" | "error";
  /** 输出目录 metadata.json 的 status；缺省不写这个文件（旧版本或目录被清理）。 */
  metadata?: SubagentRunMetadataStatus;
  /** metadata.json 的 resumedAt（毫秒）：SendMessage 恢复同一个 agentId 的时间。 */
  resumedAt?: number;
  /** launch ACK 是否带 output_file；不带时按 runtime 配置的输出根目录找 metadata.json。 */
  ackOutputFile?: boolean;
  /** 输出目录（ACK 的 output_file 与 metadata.json 所在处）；缺省按 runner 布局放在输出根目录下。 */
  outputDir?: string;
  launchedAt?: number;
  childUpdatedAt?: number;
}

const DEFAULT_AGENTS: AgentSeed[] = [
  { agentId: "agent_interrupted", description: "Run the long simulation", child: "tool" },
  { agentId: "agent_finished", description: "Collect the results", child: "text" },
  { agentId: "agent_notified", description: "Lint the project", child: "tool" },
];

function assistantInfo(id: string, sessionID: string, completed?: number) {
  return {
    id,
    sessionID,
    role: "assistant",
    time: { created: OLD.launched, ...(completed ? { completed } : {}) },
    parentID: "user-1",
    modelID: "model",
    providerID: "provider",
    mode: "build",
    agent: "zcode",
    path: { cwd: "/workspace", root: "/workspace" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}

async function seedStore(agents: readonly AgentSeed[] = DEFAULT_AGENTS) {
  const base = createRecordingMessageStore();
  const store = {
    ...base,
    // 父会话与 child 共用一个内存 store：按 sessionID 取各自的消息。
    async messages(input?: { sessionID?: string }) {
      const all = await base.messages();
      return input?.sessionID ? all.filter((m) => m.info.sessionID === input.sessionID) : all;
    },
  };
  await store.createSession({
    id: PARENT_ID,
    projectID: "project",
    directory: "/workspace",
    title: "parent",
    version: "test",
    time: { created: OLD.created, updated: OLD.childUpdated },
  });
  await store.saveMessage({
    id: "user-1",
    sessionID: PARENT_ID,
    role: "user",
    time: { created: OLD.created },
    agent: "zcode",
  });
  await store.savePart({
    id: "user-1-text",
    sessionID: PARENT_ID,
    messageID: "user-1",
    type: "text",
    text: "Run the three checks in the background.",
  });
  await store.saveMessage(assistantInfo("assistant-1", PARENT_ID, OLD.launched));
  for (const seed of agents) {
    const { agentId, description } = seed;
    const launchedAt = seed.launchedAt ?? OLD.launched;
    const outputDir = seed.outputDir ?? agentOutputDir(agentId);
    await store.savePart({
      id: `part-${agentId}`,
      sessionID: PARENT_ID,
      messageID: "assistant-1",
      type: "tool",
      callID: `call-${agentId}`,
      tool: "Agent",
      state: {
        status: "completed",
        input: { description, prompt: description, run_in_background: true },
        output: launchAck(agentId, (seed.ackOutputFile ?? true) ? outputDir : undefined),
        title: description,
        metadata: {},
        time: { start: launchedAt, end: launchedAt + 1 },
      },
    });
    const childId = createSessionId(`subagent_${agentId}`);
    await store.createSession({
      id: childId,
      projectID: "project",
      directory: "/workspace",
      title: description,
      version: "test",
      taskType: "subagent_child",
      parentID: PARENT_ID,
      time: { created: launchedAt, updated: seed.childUpdatedAt ?? OLD.childUpdated },
    });
    if (seed.metadata) {
      await mkdir(outputDir, { recursive: true });
      await writeFile(
        join(outputDir, "metadata.json"),
        JSON.stringify({
          agentId,
          status: seed.metadata,
          description,
          ...(seed.resumedAt !== undefined
            ? { resumedAt: new Date(seed.resumedAt).toISOString() }
            : {}),
        }),
      );
    }
    await store.saveMessage({
      ...assistantInfo(`${agentId}-last`, childId, OLD.childUpdated),
      ...(seed.child === "error"
        ? { error: { name: "APIError", data: { message: "provider returned 500" } } }
        : {}),
    });
    await store.savePart(
      seed.child === "text"
        ? {
            id: `${agentId}-last-text`,
            sessionID: childId,
            messageID: `${agentId}-last`,
            type: "text",
            text: "All results collected.",
          }
        : {
            id: `${agentId}-last-tool`,
            sessionID: childId,
            messageID: `${agentId}-last`,
            type: "tool",
            callID: `${agentId}-bash`,
            tool: "Bash",
            state: { status: "running", input: { command: "sleep 590" }, time: { start: 1_550 } },
          },
    );
  }
  // agent_notified 的终态通知已经送到父会话（例如崩溃前就完成了）。
  await store.saveMessage({
    id: "user-2",
    sessionID: PARENT_ID,
    role: "user",
    time: { created: OLD.childUpdated },
    agent: "zcode",
  });
  await store.savePart({
    id: "user-2-text",
    sessionID: PARENT_ID,
    messageID: "user-2",
    type: "text",
    text: "<task-notification>\n<task-id>agent_notified</task-id>\n<status>completed</status>\n</task-notification>",
  });
  return store;
}

function buildRuntime(
  store: Awaited<ReturnType<typeof seedStore>>,
  requests: ModelInputMessage[][],
  runtimeTaskRegistry = new InMemoryRuntimeTaskRegistry(),
) {
  return createTestAgentRuntime(
    PARENT_ID,
    { titleGeneration: { enabled: false }, subagents: { outputRootDir: outputRoot } },
    {
      eventStore: createTestSessionEventStore(),
      runtimeTaskRegistry,
      sessionStore: store as unknown as SessionStorePort,
      modelFactory: createTestModelFactory({
        async generateText(request: { messages: ModelInputMessage[] }) {
          requests.push(structuredClone(request.messages));
          return {
            text: "ok",
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          };
        },
      } as never),
    },
  );
}

const requestText = (messages: readonly ModelInputMessage[]) =>
  messages.map((message) => modelMessageContentToText(message.content)).join("\n");

const NOTICE_HEADLINE = "The previous ZCode runtime process for this workspace exited unexpectedly";
const RUNTIME_EXIT_REASON = "the ZCode runtime process exited before it finished";

/** 恢复后跑一轮，返回这一轮发给模型的文本。 */
async function firstTurnAfterResume(
  agents: readonly AgentSeed[],
  registry?: InMemoryRuntimeTaskRegistry,
): Promise<string> {
  const store = await seedStore(agents);
  const requests: ModelInputMessage[][] = [];
  const runtime = buildRuntime(store, requests, registry);
  await runtime.resumeFromStore();
  await runtime.executeTurn("What happened to the checks?");
  return requestText(requests[0]!);
}

describe("previous runtime background agent reconciliation", () => {
  it("tells the model on the next turn which background agents the crashed runtime interrupted", async () => {
    const store = await seedStore();
    const requests: ModelInputMessage[][] = [];

    const runtime = buildRuntime(store, requests);
    await runtime.resumeFromStore();
    // 恢复本身不开新轮：打开会话不消耗 token，也不在内存仍紧张时立刻重新派发。
    expect(requests).toHaveLength(0);

    await runtime.executeTurn("What happened to the checks?");
    const text = requestText(requests[0]!);
    expect(text).toContain(
      "The previous ZCode runtime process for this workspace exited unexpectedly",
    );
    expect(text).toContain("<task-id>agent_interrupted</task-id>");
    expect(text).toContain("<tool-use-id>call-agent_interrupted</tool-use-id>");
    expect(text).toContain("<status>failed</status>");
    expect(text).toContain(
      'Agent "Run the long simulation" failed: the ZCode runtime process exited before it finished',
    );
    // 成功结束的 child 与已收到通知的 child 不报。
    expect(text).not.toContain("<task-id>agent_finished</task-id>");
    expect(text.match(/<task-id>agent_notified<\/task-id>/g)).toHaveLength(1);

    // 提醒按隐藏提醒落盘，作为下次恢复时的去重依据。
    const reminderPart = store.savedParts.find(
      (part) =>
        part.metadata?.runtimeMessage?.source === "task_status" &&
        String(part.text).includes("<task-id>agent_interrupted</task-id>"),
    );
    expect(reminderPart).toBeDefined();
    expect(store.savedMessages.find((m) => m.id === reminderPart?.messageID)).toMatchObject({
      semantics: { kind: "system_reminder", uiVisibility: "hidden" },
    });
  });

  it("does not repeat the notice after the next resume", async () => {
    const store = await seedStore();
    const requests: ModelInputMessage[][] = [];

    const first = buildRuntime(store, requests);
    await first.resumeFromStore();
    await first.executeTurn("first turn after crash");

    const second = buildRuntime(store, requests);
    await second.resumeFromStore();
    await second.executeTurn("second turn");

    const text = requestText(requests.at(-1)!);
    expect(text.match(/<task-id>agent_interrupted<\/task-id>/g)).toHaveLength(1);
  });

  // 下面每条只放一个 Agent，除被测条件外都满足「被中断」，断言不发提醒（!3562 评审 CR-01、SG-02）。
  const interrupted = (overrides: Partial<AgentSeed>): AgentSeed => ({
    agentId: "agent_under_test",
    description: "Run the long simulation",
    child: "tool",
    metadata: "running",
    ...overrides,
  });

  it("still reports an agent whose metadata.json was left at running", async () => {
    const text = await firstTurnAfterResume([interrupted({})]);
    expect(text).toContain(NOTICE_HEADLINE);
    expect(text).toContain("<task-id>agent_under_test</task-id>");
  });

  it("finds metadata.json under the configured output root when the ACK has no output_file", async () => {
    // ACK 不带 output_file（父代理没有 Read/Bash）时按 <outputRootDir>/<父会话>/<agentId> 找。
    const stopped = await firstTurnAfterResume([
      interrupted({ ackOutputFile: false, metadata: "stopped" }),
    ]);
    expect(stopped).not.toContain(NOTICE_HEADLINE);
    const running = await firstTurnAfterResume([interrupted({ ackOutputFile: false })]);
    expect(running).toContain("<task-id>agent_under_test</task-id>");
  });

  it("reads metadata.json from an output_file path that contains spaces", async () => {
    // Windows 的用户目录可能带空格；output_file 要取到行尾，且不在默认输出根目录下也要找得到。
    const outputDir = join(outputRoot, "User With Space", "agents", "agent_under_test");
    const text = await firstTurnAfterResume([interrupted({ outputDir, metadata: "stopped" })]);
    expect(text).not.toContain(NOTICE_HEADLINE);
  });

  it("does not report agents the previous runtime stopped on a normal shutdown", async () => {
    // 正常关闭：owner close() 统一 stopTask，metadata.json 改写为 stopped，通知因 shuttingDown 被丢弃。
    const text = await firstTurnAfterResume([interrupted({ metadata: "stopped" })]);
    expect(text).not.toContain(NOTICE_HEADLINE);
    expect(text).not.toContain("<task-id>agent_under_test</task-id>");
  });

  it("does not relabel an agent that already failed as interrupted by the runtime exit", async () => {
    // 已因 provider 错误失败、通知还在内存队列里时进程退出：不能把错误原因改写成 runtime 退出。
    const text = await firstTurnAfterResume([interrupted({ metadata: "failed", child: "error" })]);
    expect(text).not.toContain(RUNTIME_EXIT_REASON);
    expect(text).not.toContain("<task-id>agent_under_test</task-id>");
  });

  it("does not report an agent whose metadata.json says it completed", async () => {
    const text = await firstTurnAfterResume([interrupted({ metadata: "completed" })]);
    expect(text).not.toContain(NOTICE_HEADLINE);
  });

  it("falls back to the child session when metadata.json is missing", async () => {
    // 没有 metadata.json（旧版本、目录被清理）：child 停在工具调用就报，child 已有终态（失败、完成）就不报。
    const text = await firstTurnAfterResume([
      interrupted({ agentId: "agent_no_metadata_tool", metadata: undefined }),
      interrupted({ agentId: "agent_no_metadata_error", metadata: undefined, child: "error" }),
      interrupted({ agentId: "agent_no_metadata_text", metadata: undefined, child: "text" }),
    ]);
    expect(text).toContain("<task-id>agent_no_metadata_tool</task-id>");
    expect(text).not.toContain("<task-id>agent_no_metadata_error</task-id>");
    expect(text).not.toContain("<task-id>agent_no_metadata_text</task-id>");
  });

  // agent_notified 的完成通知写在 OLD.childUpdated（seedStore 里的 user-2）。
  it("reports a crash of a SendMessage-resumed run despite the earlier run's notification", async () => {
    // 先完成并通知，之后被 SendMessage 恢复（同一个 agentId，metadata.json 改回 running），
    // 恢复的运行在进程崩溃时中断：旧通知不能把这次中断挡掉（!3562 评审第二轮 CR-02）。
    const text = await firstTurnAfterResume([
      interrupted({ agentId: "agent_notified", resumedAt: OLD.childUpdated + 50 }),
    ]);
    expect(text).toContain(NOTICE_HEADLINE);
    expect(text.match(/<task-id>agent_notified<\/task-id>/g)).toHaveLength(2);
    expect(text).toContain(RUNTIME_EXIT_REASON);
  });

  it("still reports an agent that only received a no-progress report before the crash", async () => {
    // 无进展提醒（<background-agent-stall>）也带 <task-id>，但它不是终态通知：崩溃前卡住、收到过
    // 提醒的 Agent，恢复后仍要报中断（与 !3563 的停滞提醒同时存在时）。
    const store = await seedStore([interrupted({})]);
    await store.saveMessage({
      id: "user-stall",
      sessionID: PARENT_ID,
      role: "user",
      time: { created: OLD.childUpdated },
      agent: "zcode",
    });
    await store.savePart({
      id: "user-stall-text",
      sessionID: PARENT_ID,
      messageID: "user-stall",
      type: "text",
      text: [
        "[SYSTEM NOTIFICATION - NOT USER INPUT]",
        "<background-agent-stall>",
        "  <task-id>agent_under_test</task-id>",
        "  <no-progress-for-ms>900000</no-progress-for-ms>",
        "</background-agent-stall>",
      ].join("\n"),
    });
    const requests: ModelInputMessage[][] = [];
    const runtime = buildRuntime(store, requests);
    await runtime.resumeFromStore();
    await runtime.executeTurn("What happened to the checks?");
    const text = requestText(requests[0]!);
    expect(text).toContain(NOTICE_HEADLINE);
    expect(text).toContain(RUNTIME_EXIT_REASON);
  });

  it("still treats a notification written after the latest resume as delivered", async () => {
    const text = await firstTurnAfterResume([
      interrupted({ agentId: "agent_notified", resumedAt: OLD.childUpdated - 50 }),
    ]);
    expect(text).not.toContain(NOTICE_HEADLINE);
  });

  it("does not report an agent that this runtime's registry still tracks", async () => {
    // 例如在本进程里被 SendMessage 恢复、正在运行。
    const registry = new InMemoryRuntimeTaskRegistry();
    registry.register({
      agentId: "agent_under_test",
      agentType: "general-purpose",
      description: "Run the long simulation",
      isBackgrounded: true,
      startedAt: new Date(),
      status: "running",
      taskId: "agent_under_test",
      type: "local_agent",
    } as never);
    const text = await firstTurnAfterResume([interrupted({})], registry);
    expect(text).not.toContain(NOTICE_HEADLINE);
  });

  it("does not report an agent whose child session was updated after this runtime started", async () => {
    // 另一个进程（如终端 TUI）正在运行同一会话，child 持续落盘。
    const text = await firstTurnAfterResume([interrupted({ childUpdatedAt: Date.now() })]);
    expect(text).not.toContain(NOTICE_HEADLINE);
  });

  it("does not report an agent launched by this runtime", async () => {
    const now = Date.now();
    const text = await firstTurnAfterResume([
      interrupted({ launchedAt: now, childUpdatedAt: now }),
    ]);
    expect(text).not.toContain(NOTICE_HEADLINE);
  });
});
