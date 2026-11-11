import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CoreErrorType,
  HookEventName,
  ModelErrorCode,
  SessionEventType,
  createRootTraceContext,
  createSessionId,
  type MessageId,
  type ModelRequest,
  type ModelResult,
  type SessionId,
} from "@zcode/contracts";
import { createSqliteSessionStore } from "../../adapters/src/storage/session-store/sqlite-session-store.js";
import { activeSessionMessages } from "../src/agent/session-history-hydrator.js";
import { createInMemoryHookRunner } from "../src/hooks/index.js";
import {
  buildLifecycleHookContextEntry,
  runCompactSessionStartHooks,
} from "../src/runtime/methods/hooks.js";
import { forkConversationFromMessage } from "../src/runtime/methods/session-fork.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

// 生命周期 Hook（SessionStart / UserPromptSubmit / Stop）的上下文先写库再进历史，
// 冷恢复按原位置回放；见 docs/design/v2/hooks.md「生命周期 Hook 上下文的持久化」。

type Store = Awaited<ReturnType<typeof createSqliteSessionStore>>;
type Runtime = ReturnType<typeof createTestAgentRuntime>;

const SUMMARY_PROMPT = "create a detailed summary";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

interface HarnessOptions {
  root: string;
  dbName?: string;
  mcs?: boolean;
  compact?: boolean;
  /** SessionStart 返回的上下文；返回 undefined 表示不返回。默认 `SS:<source>`。 */
  sessionStartContext?: (source: string) => string | undefined;
  /** Stop hook 只在第一次结束时阻止一次。 */
  stopOnce?: boolean;
  /** 返回 undefined 时用默认回复 `R<序号>`。 */
  respond?: (request: ModelRequest, ordinal: number) => ModelResult | undefined;
  /** 注册一个直接返回 `echoed` 的 Echo 工具。 */
  echoTool?: boolean;
}

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "zcode-lifecycle-hook-context-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function createHarness(options: HarnessOptions) {
  const dbPath = join(options.root, options.dbName ?? "session.sqlite");
  // 记录每次整组提交（compaction 用 commitMessageBundle 一次写入边界、摘要和附件）。
  const bundles: Array<Array<{ kind?: string; source?: string; text: string }>> = [];
  const openStore = async (): Promise<Store> => {
    const opened = await createSqliteSessionStore({ dbPath });
    const commit = opened.commitMessageBundle.bind(opened);
    opened.commitMessageBundle = async (bundle) => {
      bundles.push(
        bundle.messages.map(({ info, parts }) => ({
          kind: info.semantics?.kind,
          source: info.semantics?.source,
          text: parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
        })),
      );
      return commit(bundle);
    };
    return opened;
  };
  let store: Store = await openStore();
  const eventStores: Array<ReturnType<typeof createTestSessionEventStore>> = [];
  const requests: ModelRequest[] = [];
  const sessionStartSources: string[] = [];
  let summaryCount = 0;
  let stopBlocked = false;
  const runtimes: Runtime[] = [];
  cleanups.push(async () => {
    for (const runtime of runtimes) await runtime.closeBrowserSession();
    store.close();
  });

  const hookRunner = createInMemoryHookRunner({
    hooks: [
      {
        event: HookEventName.SessionStart,
        callback: async (input) => {
          const source = "source" in input ? String(input.source) : "";
          sessionStartSources.push(source);
          const additionalContext = options.sessionStartContext
            ? options.sessionStartContext(source)
            : `SS:${source}`;
          if (additionalContext === undefined) return undefined;
          return {
            hookSpecificOutput: {
              hookEventName: HookEventName.SessionStart,
              additionalContext,
            },
          };
        },
      },
      {
        event: HookEventName.UserPromptSubmit,
        callback: async (input) => ({
          hookSpecificOutput: {
            hookEventName: HookEventName.UserPromptSubmit,
            additionalContext: `UPS:${"prompt" in input ? input.prompt : ""}`,
          },
        }),
      },
      {
        event: HookEventName.Stop,
        callback: async () => {
          if (!options.stopOnce || stopBlocked) return undefined;
          stopBlocked = true;
          return { decision: "block", reason: "STOP:once" };
        },
      },
    ],
  });
  const modelFactory = createTestModelFactory({
    properties: { supportsMidConversationSystem: options.mcs ?? true },
    generateText: async (request: ModelRequest) => {
      if (JSON.stringify(request.messages).includes(SUMMARY_PROMPT)) {
        summaryCount++;
        return { finishReason: "stop", text: "<summary>COMPACT_SUMMARY</summary>", usage: {} };
      }
      requests.push(structuredClone(request));
      return (
        options.respond?.(request, requests.length) ?? {
          finishReason: "stop",
          text: `R${requests.length}`,
          usage: {},
        }
      );
    },
  });

  const createRuntime = (sessionId: SessionId): Runtime => {
    const eventStore = createTestSessionEventStore();
    eventStores.push(eventStore);
    // runtime 会把内置工具注册进传入的 registry，每个 runtime 用自己的一份。
    const toolRegistry = createToolRegistry();
    if (options.echoTool) {
      toolRegistry.register({
        inputSchema: {},
        metadata: {
          name: "Echo",
          concurrentSafe: true,
          destructive: false,
          needsApproval: false,
          readOnly: true,
          riskLevel: "low",
          sideEffectScope: "none",
        },
        handler: async () => "echoed",
      });
    }
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "yolo",
        compact: { enabled: options.compact ?? false },
        titleGeneration: { enabled: false },
        workingDirectory: options.root,
        workspacePath: options.root,
        currentDate: "2026-11-06",
        // 每次输入附件收集都会写一条 output_style，用来确认 UPS 排在本轮附件末尾。
        outputStyle: { name: "Learning", prompt: "Explain tradeoffs." },
      } as never,
      {
        eventStore,
        hookRunner,
        modelFactory,
        sessionStore: store,
        toolRegistry,
        getAgentDefinitions: () => ({ activeAgents: [] }),
      } as never,
    );
    runtimes.push(runtime);
    return runtime;
  };

  return {
    bundles,
    requests,
    sessionStartSources,
    get summaryCount() {
      return summaryCount;
    },
    get store() {
      return store;
    },
    createRuntime,
    /** 本 harness 所有 runtime 发出的 compaction 边界事件。 */
    async compactBoundaries(sessionId: SessionId): Promise<Array<Record<string, unknown>>> {
      const events = (
        await Promise.all(eventStores.map((eventStore) => eventStore.getEvents(sessionId)))
      ).flat();
      return events
        .filter((event) => event.type === SessionEventType.CompactBoundary)
        .map((event) => event.payload as Record<string, unknown>);
    },
    /** 模拟进程重启：关掉旧 runtime 与数据库连接，重新打开并从库里恢复。 */
    async reopen(sessionId: SessionId): Promise<Runtime> {
      for (const runtime of runtimes.splice(0)) await runtime.closeBrowserSession();
      store.close();
      store = await openStore();
      const runtime = createRuntime(sessionId);
      await runtime.resumeFromStore();
      return runtime;
    },
    /** 送一条后台任务通知，等它触发的通知轮跑完。 */
    async notify(runtime: Runtime, sessionId: SessionId, text: string): Promise<void> {
      const internal = runtime as unknown as {
        drainRuntimeCommandQueue(): Promise<void>;
        enqueueBackgroundTaskNotification(notification: {
          text: string;
          traceContext: ReturnType<typeof createRootTraceContext>;
        }): void;
        runtimeCommandDrainActive: boolean;
      };
      // 先占住排空标记，入队时自动发起的排空直接返回；再由这里排空，才能等到这一轮结束。
      internal.runtimeCommandDrainActive = true;
      internal.enqueueBackgroundTaskNotification({
        text,
        traceContext: createRootTraceContext({ sessionId }),
      });
      internal.runtimeCommandDrainActive = false;
      await internal.drainRuntimeCommandQueue();
    },
  };
}

/** 按库里的顺序列出当前分支的对话行与 hook 上下文；其他隐藏提醒记为 `reminder <source>`。 */
async function transcript(store: Store, sessionId: SessionId): Promise<string[]> {
  const [messages, session] = await Promise.all([
    store.messages({ sessionID: sessionId }),
    store.getSession(sessionId),
  ]);
  const revert = session?.revert;
  const active = activeSessionMessages(messages, {
    branchCutAfterMessageId: revert?.branchCutAfterMessageID,
    rewindCreatedMessageId: revert?.createdMessageID,
    rewindKeptMessageIds: revert?.keptMessageIDs,
    rewindTargetMessageId: revert?.targetMessageID,
  });
  return active.flatMap(({ info, parts }) => {
    const text = parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
    if (info.semantics?.source === "hook_context") {
      return [`hook ${text.match(/(?:SS|UPS|STOP):[^\n]*/)?.[0] ?? text}`];
    }
    if (info.semantics?.kind === "system_reminder") return [`reminder ${info.semantics.source}`];
    if (info.role === "assistant") return /^R\d+$/.test(text) ? [`assistant ${text}`] : [];
    if (info.role !== "user" || info.source === "fork") return [];
    if (info.summary) return ["summary"];
    return [`user ${text}`];
  });
}

const conversation = (rows: readonly string[]) => rows.filter((row) => !row.startsWith("reminder"));

function requestText(request: ModelRequest): string {
  return JSON.stringify(request.messages);
}

function countOf(text: string, marker: string): number {
  return text.split(marker).length - 1;
}

/** provider 请求里的消息，去掉缓存标记，只比较角色与正文。 */
function comparable(request: ModelRequest) {
  return request.messages.map((message) => ({ role: message.role, content: message.content }));
}

async function assistantIdAfter(
  store: Store,
  sessionId: SessionId,
  userText: string,
): Promise<MessageId> {
  const messages = await store.messages({ sessionID: sessionId });
  const userIndex = messages.findLastIndex(
    ({ info, parts }) =>
      info.role === "user" && parts.some((part) => part.type === "text" && part.text === userText),
  );
  const assistant = messages.slice(userIndex).find(({ info }) => info.role === "assistant");
  return assistant!.info.id;
}

type CompactionTrigger = "manual" | "auto" | "reactive";

/**
 * 让 `first`、`second` 之后的第三轮触发 compaction：auto 由第二次回复的超大 usage 触发；
 * reactive 由含 `third` 的第一次请求超限触发；manual 由调用方发 `/compact`。
 */
function compactionResponder(trigger: CompactionTrigger): HarnessOptions["respond"] {
  let overflowThrown = false;
  return (request, ordinal) => {
    if (trigger === "auto" && ordinal === 2) {
      return {
        finishReason: "stop",
        text: `R${ordinal}`,
        usage: { inputTokens: 1_000_000, outputTokens: 1, totalTokens: 1_000_001 },
      };
    }
    if (trigger === "reactive" && !overflowThrown && requestText(request).includes("third")) {
      overflowThrown = true;
      throw Object.assign(new Error("provider context window exceeded"), {
        code: ModelErrorCode.ModelContextExceeded,
      });
    }
    return undefined;
  };
}

const thirdTurnInput = (trigger: CompactionTrigger) =>
  trigger === "manual" ? "/compact" : "third";

describe.each([true, false])("lifecycle hook context persistence (MCS=%s)", (mcs) => {
  // 两种 SessionStart：只有 startup 返回；每个来源都返回同一段静态文本（内置 design 插件，没有 matcher）。
  // 冷恢复后的请求都应与一直在线的请求逐字相同。
  it.each([
    {
      name: "startup only",
      label: "SS:startup",
      sessionStartContext: (source: string) => (source === "startup" ? "SS:startup" : undefined),
    },
    { name: "static on every source", label: "SS:static", sessionStartContext: () => "SS:static" },
  ])(
    "replays SessionStart ($name), UserPromptSubmit and Stop context unchanged after a cold restart",
    async ({ label, sessionStartContext }) => {
      const root = await createRoot();
      const sessionId = createSessionId(`lifecycle-hook-cold-${mcs}`);
      const options = { root, mcs, stopOnce: true, sessionStartContext };
      const hot = await createHarness({ ...options, dbName: "hot.sqlite" });
      const cold = await createHarness({ ...options, dbName: "cold.sqlite" });

      const hotRuntime = hot.createRuntime(sessionId);
      await hotRuntime.executeTurn("first");
      await hotRuntime.executeTurn("second");
      await cold.createRuntime(sessionId).executeTurn("first");
      await (await cold.reopen(sessionId)).executeTurn("second");

      expect(hot.requests).toHaveLength(3);
      expect(cold.requests).toHaveLength(3);
      expect(cold.requests.map(comparable)).toEqual(hot.requests.map(comparable));
      expect(conversation(await transcript(cold.store, sessionId))).toEqual([
        `hook ${label}`,
        "user first",
        "hook UPS:first",
        "assistant R1",
        "hook STOP:once",
        "assistant R2",
        "user second",
        "hook UPS:second",
        "assistant R3",
      ]);
    },
  );

  // 静态文本（内置 design 插件）：compaction 前的那份已被摘要替换，compact 必须写回一份，
  // 压缩后的请求里只有这一份；冷恢复后 resume 与它相同，不再写，请求逐字不变。
  it.each(["manual", "auto", "reactive"] as const)(
    "keeps a static SessionStart context after %s compaction, unchanged after a cold restart",
    async (trigger) => {
      const root = await createRoot();
      const sessionId = createSessionId(`lifecycle-hook-compact-cold-${trigger}-${mcs}`);
      const run = async (dbName: string, coldRestart: boolean) => {
        const harness = await createHarness({
          root,
          dbName,
          mcs,
          compact: true,
          sessionStartContext: () => "SS:static",
          respond: compactionResponder(trigger),
        });
        const runtime = harness.createRuntime(sessionId);
        await runtime.executeTurn("first");
        await runtime.executeTurn("second");
        await runtime.executeTurn(thirdTurnInput(trigger));
        await (coldRestart ? await harness.reopen(sessionId) : runtime).executeTurn("fourth");
        return harness;
      };
      const hot = await run("hot.sqlite", false);
      const cold = await run("cold.sqlite", true);

      expect(hot.summaryCount).toBe(1);
      const afterCompact = requestText(hot.requests.at(-1)!);
      expect(afterCompact).toContain("COMPACT_SUMMARY");
      expect(countOf(afterCompact, "SS:static")).toBe(1);
      expect(cold.requests.map(comparable)).toEqual(hot.requests.map(comparable));
    },
  );
});

describe("lifecycle hook context persistence", () => {
  it("writes UserPromptSubmit context after the turn's input attachments", async () => {
    const root = await createRoot();
    const sessionId = createSessionId("lifecycle-hook-ups-position");
    const harness = await createHarness({ root });
    await harness.createRuntime(sessionId).executeTurn("first");

    const rows = await transcript(harness.store, sessionId);
    // 输入附件批次 → UserPromptSubmit 上下文 → 请求前公告（instructions / session_context / date）。
    expect(rows).toEqual([
      "hook SS:startup",
      "user first",
      "reminder environment",
      "reminder model",
      "reminder output_style_instructions",
      "reminder total_tokens_reminder",
      "reminder output_style",
      "hook UPS:first",
      "reminder date",
      "assistant R1",
    ]);
  });

  it("writes UserPromptSubmit context once when the turn runs tools", async () => {
    const root = await createRoot();
    const sessionId = createSessionId("lifecycle-hook-ups-tools");
    const harness = await createHarness({
      root,
      echoTool: true,
      respond: (_request, ordinal) =>
        ordinal === 1
          ? {
              finishReason: "tool-calls",
              text: "",
              toolCalls: [{ id: "echo-1", name: "Echo", input: {} }],
              usage: {},
            }
          : undefined,
    });
    await harness.createRuntime(sessionId).executeTurn("first");

    // 工具结果之后会再收集一次输入附件；UPS 只在第一次收集时写入。
    expect(harness.requests).toHaveLength(2);
    expect(conversation(await transcript(harness.store, sessionId))).toEqual([
      "hook SS:startup",
      "user first",
      "hook UPS:first",
      "assistant R2",
    ]);
    expect(countOf(requestText(harness.requests[1]!), "UPS:first")).toBe(1);
  });

  it("writes pending resume context after the input of a notification turn", async () => {
    const root = await createRoot();
    const sessionId = createSessionId("lifecycle-hook-notification");
    const harness = await createHarness({ root });
    await harness.createRuntime(sessionId).executeTurn("first");

    // 重开后先来一条后台通知：通知在轮开始前已写库，resume 上下文写在它之后；通知轮不运行 UPS。
    await harness.notify(await harness.reopen(sessionId), sessionId, "NOTIFY:done");

    const rows = conversation(await transcript(harness.store, sessionId));
    const notification = rows.findIndex((row) => row.includes("NOTIFY:done"));
    expect(notification).toBeGreaterThan(rows.indexOf("assistant R1"));
    expect(rows.slice(notification + 1)).toEqual(["hook SS:resume", "assistant R2"]);
    expect(countOf(requestText(harness.requests[1]!), "SS:resume")).toBe(1);
  });

  it("writes resume context with the next turn only, once per resume", async () => {
    const root = await createRoot();
    const sessionId = createSessionId("lifecycle-hook-resume");
    const harness = await createHarness({ root });
    await harness.createRuntime(sessionId).executeTurn("first");
    const afterFirst = await transcript(harness.store, sessionId);

    // 只打开会话、不发消息：hook 会运行，但不写库。
    await harness.reopen(sessionId);
    await harness.reopen(sessionId);
    expect(harness.sessionStartSources).toEqual(["startup", "resume", "resume"]);
    expect(await transcript(harness.store, sessionId)).toEqual(afterFirst);

    await (await harness.reopen(sessionId)).executeTurn("second");
    expect(conversation(await transcript(harness.store, sessionId))).toEqual([
      "hook SS:startup",
      "user first",
      "hook UPS:first",
      "assistant R1",
      "hook SS:resume",
      "user second",
      "hook UPS:second",
      "assistant R2",
    ]);
    const second = requestText(harness.requests[1]!);
    expect(countOf(second, "SS:resume")).toBe(1);
    expect(second.indexOf("SS:startup")).toBeLessThan(second.indexOf("SS:resume"));

    // 再次冷恢复：前面写入的上下文原样回放；这次 resume 的正文和最近一份相同，不再写入。
    await (await harness.reopen(sessionId)).executeTurn("third");
    const third = requestText(harness.requests[2]!);
    expect(countOf(third, "SS:startup")).toBe(1);
    expect(countOf(third, "SS:resume")).toBe(1);
    expect(countOf(third, "UPS:second")).toBe(1);
  });

  it("skips SessionStart context identical to the latest copy in history", async () => {
    const root = await createRoot();
    const sessionId = createSessionId("lifecycle-hook-dedup");
    let text = "SS:same";
    const harness = await createHarness({ root, sessionStartContext: () => text });
    await harness.createRuntime(sessionId).executeTurn("first");
    // 正文相同：hook 照常运行，但不写库、不进请求。
    await (await harness.reopen(sessionId)).executeTurn("second");
    // 正文变化：照常写入新的一份；之后再相同又不写。
    text = "SS:changed";
    await (await harness.reopen(sessionId)).executeTurn("third");
    await (await harness.reopen(sessionId)).executeTurn("fourth");

    expect(harness.sessionStartSources).toEqual(["startup", "resume", "resume", "resume"]);
    expect(conversation(await transcript(harness.store, sessionId))).toEqual([
      "hook SS:same",
      "user first",
      "hook UPS:first",
      "assistant R1",
      "user second",
      "hook UPS:second",
      "assistant R2",
      "hook SS:changed",
      "user third",
      "hook UPS:third",
      "assistant R3",
      "user fourth",
      "hook UPS:fourth",
      "assistant R4",
    ]);
    const second = requestText(harness.requests[1]!);
    expect(countOf(second, "SS:same")).toBe(1);
    const fourth = requestText(harness.requests[3]!);
    expect(countOf(fourth, "SS:same")).toBe(1);
    expect(countOf(fourth, "SS:changed")).toBe(1);
  });

  it("compares at commit time, so a rewind that cut the latest copy still writes it", async () => {
    const root = await createRoot();
    const sessionId = createSessionId("lifecycle-hook-dedup-rewind");
    let text = "SS:A";
    const harness = await createHarness({ root, sessionStartContext: () => text });
    await harness.createRuntime(sessionId).executeTurn("first");
    text = "SS:B";
    await (await harness.reopen(sessionId)).executeTurn("second");

    // 重开时历史里最近一份是 B，和这次结果相同；随后编辑首条 prompt，B 被切掉。
    const runtime = await harness.reopen(sessionId);
    await runtime.rewindConversationToMessage({
      events: [],
      targetMessageId: await assistantIdAfter(harness.store, sessionId, "first"),
      traceContext: createRootTraceContext({ sessionId }),
    });
    await runtime.executeTurn("first edited");

    expect(conversation(await transcript(harness.store, sessionId))).toEqual([
      "hook SS:A",
      "hook SS:B",
      "user first edited",
      "hook UPS:first edited",
      "assistant R3",
    ]);
    const edited = requestText(harness.requests[2]!);
    expect(countOf(edited, "SS:A")).toBe(1);
    expect(countOf(edited, "SS:B")).toBe(1);
  });

  it("runs SessionStart with fork once in a forked child, then resume", async () => {
    const root = await createRoot();
    const parentId = createSessionId("lifecycle-hook-fork-parent");
    const harness = await createHarness({ root });
    const parent = harness.createRuntime(parentId);
    await parent.executeTurn("first");
    const fork = await forkConversationFromMessage.call(parent as never, {
      targetMessageId: await assistantIdAfter(harness.store, parentId, "first"),
      traceContext: createRootTraceContext({ sessionId: parentId }),
    });
    const childId = fork.forkedSessionId;

    await (await harness.reopen(childId)).executeTurn("child first");
    await (await harness.reopen(childId)).executeTurn("child second");

    expect(harness.sessionStartSources).toEqual(["startup", "fork", "resume"]);
    expect(conversation(await transcript(harness.store, childId))).toEqual([
      "hook SS:startup",
      "user first",
      "hook UPS:first",
      "assistant R1",
      "hook SS:fork",
      "user child first",
      "hook UPS:child first",
      "assistant R2",
      "hook SS:resume",
      "user child second",
      "hook UPS:child second",
      "assistant R3",
    ]);
  });

  it("does not repeat fork context identical to the copy inherited from the parent", async () => {
    const root = await createRoot();
    const parentId = createSessionId("lifecycle-hook-fork-dedup-parent");
    const harness = await createHarness({ root, sessionStartContext: () => "SS:same" });
    const parent = harness.createRuntime(parentId);
    await parent.executeTurn("first");
    const fork = await forkConversationFromMessage.call(parent as never, {
      targetMessageId: await assistantIdAfter(harness.store, parentId, "first"),
      traceContext: createRootTraceContext({ sessionId: parentId }),
    });

    await (await harness.reopen(fork.forkedSessionId)).executeTurn("child first");

    expect(harness.sessionStartSources).toEqual(["startup", "fork"]);
    expect(conversation(await transcript(harness.store, fork.forkedSessionId))).toEqual([
      "hook SS:same",
      "user first",
      "hook UPS:first",
      "assistant R1",
      "user child first",
      "hook UPS:child first",
      "assistant R2",
    ]);
  });

  it("reruns SessionStart with compact after a manual compaction, after its output", async () => {
    const root = await createRoot();
    const sessionId = createSessionId("lifecycle-hook-manual-compact");
    const harness = await createHarness({ root, compact: true });
    const runtime = harness.createRuntime(sessionId);
    await runtime.executeTurn("first");
    await runtime.executeTurn("second");
    await runtime.executeTurn("/compact");
    await runtime.executeTurn("third");

    expect(harness.summaryCount).toBe(1);
    expect(harness.sessionStartSources).toEqual(["startup", "compact"]);
    const rows = await transcript(harness.store, sessionId);
    // compact 上下文是 compaction 写下的最后一行，在摘要之后、下一轮输入之前。
    expect(rows.slice(rows.indexOf("summary"), rows.indexOf("user third")).at(-1)).toBe(
      "hook SS:compact",
    );
    const third = requestText(harness.requests.at(-1)!);
    expect(countOf(third, "SS:compact")).toBe(1);
    expect(third.indexOf("COMPACT_SUMMARY")).toBeLessThan(third.indexOf("SS:compact"));
  });

  it("commits the compact context with the compaction output and counts its tokens", async () => {
    const root = await createRoot();
    const sessionId = createSessionId("lifecycle-hook-compact-bundle");
    const longContext = `SS:compact ${"x".repeat(8_000)}`;
    const run = async (compactContext: string | undefined, dbName: string) => {
      const harness = await createHarness({
        root,
        dbName,
        compact: true,
        sessionStartContext: (source) => (source === "compact" ? compactContext : `SS:${source}`),
      });
      const runtime = harness.createRuntime(sessionId);
      await runtime.executeTurn("first");
      await runtime.executeTurn("second");
      await runtime.executeTurn("/compact");
      return harness;
    };
    const withContext = await run(longContext, "with.sqlite");
    const withoutContext = await run(undefined, "without.sqlite");

    // 和边界、摘要、附件同一次提交，并且是这次提交的最后一项。
    const bundle = withContext.bundles.find((messages) =>
      messages.some((message) => message.kind === "compact_summary"),
    );
    expect(bundle?.at(-1)).toMatchObject({ source: "hook_context" });
    expect(bundle?.at(-1)?.text).toContain("SS:compact x");
    // 压缩后 token 计入了这段上下文（约 2000 token）。
    const [boundaryWith] = await withContext.compactBoundaries(sessionId);
    const [boundaryWithout] = await withoutContext.compactBoundaries(sessionId);
    const delta =
      Number(boundaryWith?.truePostCompactTokenCount) -
      Number(boundaryWithout?.truePostCompactTokenCount);
    expect(delta).toBeGreaterThan(1_500);
  });

  it("keeps the pending resume context when the compact hook returns nothing", async () => {
    const root = await createRoot();
    const sessionId = createSessionId("lifecycle-hook-compact-empty");
    const harness = await createHarness({
      root,
      compact: true,
      sessionStartContext: (source) => (source === "compact" ? undefined : `SS:${source}`),
    });
    const runtime = harness.createRuntime(sessionId);
    await runtime.executeTurn("first");
    await runtime.executeTurn("second");
    // 重开后先手动 compact：这一轮在提交待写槽之前就返回。
    const reopened = await harness.reopen(sessionId);
    await reopened.executeTurn("/compact");
    await reopened.executeTurn("third");

    expect(harness.summaryCount).toBe(1);
    expect(harness.sessionStartSources).toEqual(["startup", "resume", "compact"]);
    const rows = await transcript(harness.store, sessionId);
    expect(rows.slice(rows.indexOf("summary"))).toEqual(
      expect.arrayContaining(["hook SS:resume", "user third"]),
    );
    expect(rows.indexOf("hook SS:resume")).toBe(rows.indexOf("user third") - 1);
    expect(countOf(requestText(harness.requests.at(-1)!), "SS:resume")).toBe(1);
  });

  it("drops the pending resume context once the compact hook returns a result", async () => {
    const root = await createRoot();
    const sessionId = createSessionId("lifecycle-hook-compact-replaces-pending");
    const harness = await createHarness({ root, compact: true });
    const runtime = harness.createRuntime(sessionId);
    await runtime.executeTurn("first");
    await runtime.executeTurn("second");
    const reopened = await harness.reopen(sessionId);
    await reopened.executeTurn("/compact");
    await reopened.executeTurn("third");

    expect(harness.sessionStartSources).toEqual(["startup", "resume", "compact"]);
    const rows = await transcript(harness.store, sessionId);
    expect(rows).not.toContain("hook SS:resume");
    expect(rows).toContain("hook SS:compact");
    const third = requestText(harness.requests.at(-1)!);
    expect(countOf(third, "SS:resume")).toBe(0);
    expect(countOf(third, "SS:compact")).toBe(1);
  });

  // 手动 compaction 不保留尾部，auto / reactive 在待写槽提交之后才运行，会话里走不到
  // 「compact 结果去重 + 还有待写内容」；直接调用，锁住去重时仍返回 hasContext。
  it("reports a compact context skipped as a duplicate as a result", async () => {
    const root = await createRoot();
    const sessionId = createSessionId("lifecycle-hook-compact-dedup-has-context");
    let compactText: string | undefined = "SS:compact";
    const harness = await createHarness({ root, sessionStartContext: () => compactText });
    const runtime = harness.createRuntime(sessionId) as never;
    const traceContext = createRootTraceContext({ sessionId });
    const copy = buildLifecycleHookContextEntry(HookEventName.SessionStart, ["SS:compact"])!;

    expect(await runCompactSessionStartHooks(runtime, [copy], traceContext)).toEqual({
      hasContext: true,
    });
    expect(await runCompactSessionStartHooks(runtime, [], traceContext)).toEqual({
      entry: copy,
      hasContext: true,
    });
    compactText = undefined;
    expect(await runCompactSessionStartHooks(runtime, [copy], traceContext)).toEqual({
      hasContext: false,
    });
  });

  it("does not bring back a committed startup context after a compaction without compact context", async () => {
    const root = await createRoot();
    const sessionId = createSessionId("lifecycle-hook-committed-not-pending");
    const harness = await createHarness({
      root,
      compact: true,
      sessionStartContext: (source) => (source === "compact" ? undefined : `SS:${source}`),
    });
    const runtime = harness.createRuntime(sessionId);
    await runtime.executeTurn("first");
    await runtime.executeTurn("second");
    await runtime.executeTurn("/compact");
    await runtime.executeTurn("third");

    // startup 上下文首轮已提交，待写槽随之清空；摘要替换它之后，不会再写一份。
    expect(await transcript(harness.store, sessionId)).not.toContain("hook SS:startup");
    expect(countOf(requestText(harness.requests.at(-1)!), "SS:startup")).toBe(0);
  });

  it("cancels the compaction when the turn is stopped while the compact hook runs", async () => {
    const root = await createRoot();
    const sessionId = createSessionId("lifecycle-hook-compact-abort");
    const controller = new AbortController();
    const harness = await createHarness({
      root,
      compact: true,
      sessionStartContext: (source) => {
        if (source === "compact") controller.abort();
        return `SS:${source}`;
      },
    });
    const runtime = harness.createRuntime(sessionId);
    await runtime.executeTurn("first");
    await runtime.executeTurn("second");

    await expect(
      runtime.executeTurn("/compact", undefined, { abortSignal: controller.signal }),
    ).rejects.toMatchObject({ type: CoreErrorType.TurnCancelled });

    expect(harness.summaryCount).toBe(1);
    expect(await harness.compactBoundaries(sessionId)).toEqual([]);
    const rows = await transcript(harness.store, sessionId);
    expect(rows).not.toContain("summary");
    expect(rows).not.toContain("hook SS:compact");
  });

  it("does not write compact context identical to the latest copy in the kept tail", async () => {
    const root = await createRoot();
    const sessionId = createSessionId("lifecycle-hook-compact-dedup");
    let text = "SS:A";
    const harness = await createHarness({
      root,
      compact: true,
      sessionStartContext: () => text,
      respond: compactionResponder("reactive"),
    });
    const runtime = harness.createRuntime(sessionId);
    await runtime.executeTurn("first");
    await runtime.executeTurn("second");
    // 重开后 B 写在 third 之前；third 的第一次请求超限，reactive compaction 保留最后一组，B 在其中。
    text = "SS:B";
    await (await harness.reopen(sessionId)).executeTurn("third");

    expect(harness.summaryCount).toBe(1);
    expect(harness.sessionStartSources).toEqual(["startup", "resume", "compact"]);
    expect(countOf(requestText(harness.requests.at(-1)!), "SS:B")).toBe(1);
    const rows = await transcript(harness.store, sessionId);
    expect(rows.filter((row) => row === "hook SS:B")).toHaveLength(1);
  });

  it.each(["auto", "reactive"] as const)(
    "reruns SessionStart with compact after %s compaction and sends it in the same turn",
    async (trigger) => {
      const root = await createRoot();
      const sessionId = createSessionId(`lifecycle-hook-${trigger}-compact`);
      const harness = await createHarness({
        root,
        compact: true,
        respond: compactionResponder(trigger),
      });
      const runtime = harness.createRuntime(sessionId);
      await runtime.executeTurn("first");
      await runtime.executeTurn("second");
      await runtime.executeTurn("third");

      expect(harness.summaryCount).toBe(1);
      expect(harness.sessionStartSources).toEqual(["startup", "compact"]);
      // 压缩后的那次请求就带上 compact 上下文，位置在摘要之后。
      const afterCompact = requestText(harness.requests.at(-1)!);
      expect(countOf(afterCompact, "SS:compact")).toBe(1);
      expect(afterCompact.indexOf("COMPACT_SUMMARY")).toBeLessThan(
        afterCompact.indexOf("SS:compact"),
      );
      const rows = await transcript(harness.store, sessionId);
      expect(rows.indexOf("summary")).toBeLessThan(rows.indexOf("hook SS:compact"));

      // 冷恢复后原样回放。
      await (await harness.reopen(sessionId)).executeTurn("fourth");
      expect(countOf(requestText(harness.requests.at(-1)!), "SS:compact")).toBe(1);
    },
  );

  it.each([false, true])(
    "keeps a single copy of hook context after retry (cold=%s)",
    async (coldRetry) => {
      const root = await createRoot();
      const sessionId = createSessionId(`lifecycle-hook-retry-${coldRetry}`);
      const harness = await createHarness({ root });
      let runtime = harness.createRuntime(sessionId);
      await runtime.executeTurn("first");
      await runtime.executeTurn("second");
      if (coldRetry) runtime = await harness.reopen(sessionId);

      await runtime.rewindConversationToMessage({
        events: [],
        targetMessageId: await assistantIdAfter(harness.store, sessionId, "second"),
        traceContext: createRootTraceContext({ sessionId }),
      });
      await runtime.executeTurn("second");

      expect(conversation(await transcript(harness.store, sessionId))).toEqual([
        "hook SS:startup",
        "user first",
        "hook UPS:first",
        "assistant R1",
        ...(coldRetry ? ["hook SS:resume"] : []),
        "user second",
        "hook UPS:second",
        "assistant R3",
      ]);
      const retried = requestText(harness.requests.at(-1)!);
      expect(countOf(retried, "UPS:second")).toBe(1);
      expect(countOf(retried, "SS:startup")).toBe(1);
    },
  );
});
