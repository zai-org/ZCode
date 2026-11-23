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
  /**
   * 新 part：part.metadata 带 Agent 工具结算写下的结构化字段（agentId、childSessionId、outputFile、background）。
   * 缺省是升级前写下的旧 part，只有启动回执文本。
   */
  structured?: boolean;
  /** 直接写进 part.metadata 的字段，覆盖 structured 生成的值（如去掉 background、只记 childSessionId）。 */
  partMetadata?: Record<string, unknown>;
  /** child session id；缺省按 runner 的命名 `sess_subagent_<agentId>`。 */
  childSessionId?: string;
  /** 启动回执 output_file 行指向的目录；缺省与 outputDir 相同。 */
  ackOutputDir?: string;
  /** 写进 part.state.metadata 的字段（旧版本可能把 childSessionId 记在这里）。 */
  stateMetadata?: Record<string, unknown>;
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
    const childId = seed.childSessionId ?? createSessionId(`subagent_${agentId}`);
    const partMetadata = {
      ...(seed.structured
        ? {
            agentId,
            childSessionId: childId,
            background: true,
            outputFile: join(outputDir, "output.txt"),
          }
        : {}),
      ...seed.partMetadata,
    };
    await store.savePart({
      id: `part-${agentId}`,
      sessionID: PARENT_ID,
      messageID: "assistant-1",
      type: "tool",
      callID: `call-${agentId}`,
      tool: "Agent",
      ...(Object.keys(partMetadata).length > 0 ? { metadata: partMetadata } : {}),
      state: {
        status: "completed",
        input: { description, prompt: description, run_in_background: true },
        output: launchAck(
          agentId,
          (seed.ackOutputFile ?? true) ? (seed.ackOutputDir ?? outputDir) : undefined,
        ),
        title: description,
        metadata: { ...seed.stateMetadata },
        time: { start: launchedAt, end: launchedAt + 1 },
      },
    });
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

  it("finds an old part's child through the childSessionId recorded in its state metadata", async () => {
    // 原来的逻辑合并 part.metadata 与 part.state.metadata 取 childSessionId，都没有才按 runner 的命名。
    const childSessionId = createSessionId("child_recorded_in_state_metadata");
    const text = await firstTurnAfterResume([
      interrupted({ childSessionId, stateMetadata: { childSessionId } }),
    ]);
    expect(text).toContain(NOTICE_HEADLINE);
    expect(text).toContain("<task-id>agent_under_test</task-id>");
  });
});

// 回归 2026-11-11（!3624）：对账按 part.metadata 判断新旧 part。上面的用例都是升级前的旧 part（只有启动回执
// 文本），按原来的逻辑对账；下面是 Agent 工具结算写下结构化字段的新 part：身份、child、输出文件、后台启动都读
// part.metadata，不解析回执文本。样本的回执没有 output_file 行，输出目录不在默认根目录下，child 也不按 runner
// 的命名：只有按 part 上记下的事实才找得到 metadata.json 与 child，走旧逻辑时这里的区分用例会失败。
describe("previous runtime reconciliation of Agent parts with structured launch facts", () => {
  const recorded = (overrides: Partial<AgentSeed>): AgentSeed => {
    const agentId = overrides.agentId ?? "agent_under_test";
    return {
      agentId,
      description: "Run the long simulation",
      child: "tool",
      metadata: "running",
      structured: true,
      ackOutputFile: false,
      outputDir: join(outputRoot, "moved storage", agentId),
      childSessionId: createSessionId(`recorded_child_${agentId}`),
      ...overrides,
    };
  };

  it("reports an interrupted agent from the identity, child and outputFile recorded on the part", async () => {
    const text = await firstTurnAfterResume([recorded({})]);
    expect(text).toContain(NOTICE_HEADLINE);
    expect(text).toContain("<task-id>agent_under_test</task-id>");
    expect(text).toContain("<tool-use-id>call-agent_under_test</tool-use-id>");
    expect(text).toContain(RUNTIME_EXIT_REASON);
    // 提醒里的输出文件是 part 上记下的路径，回执文本里没有这一行。
    const outputFile = join(outputRoot, "moved storage", "agent_under_test", "output.txt");
    expect(text).toContain(`<output-file>${outputFile}</output-file>`);
  });

  it.each<[string, Partial<AgentSeed>]>([
    ["metadata.json next to the recorded outputFile says stopped", { metadata: "stopped" }],
    ["metadata.json next to the recorded outputFile says completed", { metadata: "completed" }],
    ["the agent already failed", { metadata: "failed", child: "error" }],
    // 前台 Agent 的报告正好以启动回执开头（例如 child 转述了它派出的后台 Agent）：后台启动只看 background。
    [
      "the part has no background flag although its text starts with the launch receipt",
      { partMetadata: { background: undefined } },
    ],
    ["its child session was updated after this runtime started", { childUpdatedAt: Date.now() }],
    ["this runtime launched it", { launchedAt: Date.now(), childUpdatedAt: Date.now() }],
  ])("does not report a recorded agent when %s", async (_condition, overrides) => {
    const text = await firstTurnAfterResume([recorded(overrides)]);
    expect(text).not.toContain(NOTICE_HEADLINE);
    expect(text).not.toContain("<task-id>agent_under_test</task-id>");
  });

  it("falls back to the recorded child session when metadata.json is missing", async () => {
    const text = await firstTurnAfterResume([
      recorded({ agentId: "agent_no_metadata_tool", metadata: undefined }),
      recorded({ agentId: "agent_no_metadata_error", metadata: undefined, child: "error" }),
      recorded({ agentId: "agent_no_metadata_text", metadata: undefined, child: "text" }),
    ]);
    expect(text).toContain("<task-id>agent_no_metadata_tool</task-id>");
    expect(text).not.toContain("<task-id>agent_no_metadata_error</task-id>");
    expect(text).not.toContain("<task-id>agent_no_metadata_text</task-id>");
  });

  it("dedupes a recorded agent by its latest run", async () => {
    // agent_notified 的完成通知写在 OLD.childUpdated：恢复晚于它时，这次运行的中断仍要报；早于它时算已通知。
    const resumedAfter = await firstTurnAfterResume([
      recorded({ agentId: "agent_notified", resumedAt: OLD.childUpdated + 50 }),
    ]);
    expect(resumedAfter.match(/<task-id>agent_notified<\/task-id>/g)).toHaveLength(2);
    const resumedBefore = await firstTurnAfterResume([
      recorded({ agentId: "agent_notified", resumedAt: OLD.childUpdated - 50 }),
    ]);
    expect(resumedBefore).not.toContain(NOTICE_HEADLINE);
  });

  it("does not report a recorded agent that this runtime's registry still tracks", async () => {
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
    const text = await firstTurnAfterResume([recorded({})], registry);
    expect(text).not.toContain(NOTICE_HEADLINE);
  });

  it("treats a part without the recorded outputFile as an old part and reads its receipt", async () => {
    // 判据与子会话目录查询相同：agentId、childSessionId、outputFile 三项都在才是新 part。缺一项就按原来的逻辑
    // 读回执（output_file 行、默认输出根目录），child 仍取 part 上记下的 childSessionId。
    const childSessionId = createSessionId("recorded_child_without_output_file");
    const text = await firstTurnAfterResume([
      {
        agentId: "agent_under_test",
        description: "Run the long simulation",
        child: "tool",
        metadata: "running",
        childSessionId,
        partMetadata: { agentId: "agent_under_test", childSessionId, background: true },
      },
    ]);
    expect(text).toContain("<task-id>agent_under_test</task-id>");
    const outputFile = join(agentOutputDir("agent_under_test"), "output.txt");
    expect(text).toContain(`<output-file>${outputFile}</output-file>`);
  });

  it("reads metadata.json next to the recorded outputFile, not the receipt's output_file line", async () => {
    // 回执的 output_file 行指向另一个目录，那里的 metadata.json 还停在 running；part 上记下的目录里是 stopped。
    // 新 part 只读记下的 outputFile，按 stopped 不报；走旧逻辑会先读回执的目录，误报中断。
    const ackOutputDir = join(outputRoot, "receipt dir", "agent_under_test");
    await mkdir(ackOutputDir, { recursive: true });
    await writeFile(
      join(ackOutputDir, "metadata.json"),
      JSON.stringify({ agentId: "agent_under_test", status: "running" }),
    );
    const text = await firstTurnAfterResume([
      recorded({ metadata: "stopped", ackOutputFile: true, ackOutputDir }),
    ]);
    expect(text).not.toContain(NOTICE_HEADLINE);
    expect(text).not.toContain("<task-id>agent_under_test</task-id>");
  });

  it("reports an old part and a new part interrupted by the same crash", async () => {
    // 升级后第一次打开的会话里，升级前与升级后派出的后台 Agent 可以同时在：各按各的事实对账，提醒都在同一条里。
    const text = await firstTurnAfterResume([
      {
        agentId: "agent_old_part",
        description: "Run the old check",
        child: "tool",
        metadata: "running",
      },
      recorded({ agentId: "agent_new_part" }),
    ]);
    expect(text.match(new RegExp(NOTICE_HEADLINE, "g"))).toHaveLength(1);
    const oldOutputFile = join(agentOutputDir("agent_old_part"), "output.txt");
    const newOutputFile = join(outputRoot, "moved storage", "agent_new_part", "output.txt");
    expect(text).toContain("<task-id>agent_old_part</task-id>");
    expect(text).toContain("<tool-use-id>call-agent_old_part</tool-use-id>");
    expect(text).toContain(`<output-file>${oldOutputFile}</output-file>`);
    expect(text).toContain("<task-id>agent_new_part</task-id>");
    expect(text).toContain(`<output-file>${newOutputFile}</output-file>`);
  });
});
