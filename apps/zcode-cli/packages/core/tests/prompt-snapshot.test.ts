import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SESSION_ENTRY_PROMPT_SNAPSHOT,
  createRootTraceContext,
  createSessionId,
  type ModelRequest,
  type ModelResult,
  type SessionEntryInfo,
} from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestModelSelection } from "./test-model-selection.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { createRecordingMessageStore } from "./runtime-output-token-continuation-test-helpers.js";
import type { ToolEntry } from "../src/tool/types.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import type { AgentRuntimeConfig, AgentRuntimeDeps } from "../src/runtime/types.js";
import type { RuntimeMessageEntry } from "../src/agent/message-history.js";
import { rebuildContextPrefix } from "../src/runtime/methods/context-refresh.js";
import { createTurnModel } from "../src/runtime/methods/turn-model.js";
import {
  buildForkedPromptSnapshotEntry,
  recordPromptSnapshot,
  type PromptSnapshot,
} from "../src/runtime/helpers/prompt-snapshot.js";

const done: ModelResult = {
  finishReason: "stop",
  text: "Done.",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
};
let sessionId: ReturnType<typeof createSessionId>;
let store: ReturnType<typeof createStore>;
let requests: ModelRequest[];
const respond = vi.fn<(request: ModelRequest) => Promise<ModelResult>>();

/** 录制 store 加上 session entry 的读写；rewind 的分支信息用 updateSession 承接。 */
function createStore() {
  const recording = createRecordingMessageStore();
  const entries = new Map<string, SessionEntryInfo>();
  return Object.assign(recording, {
    entries,
    async saveSessionEntry(entry: SessionEntryInfo) {
      entries.set(entry.id, structuredClone(entry));
    },
    async sessionEntries(input: { sessionID: string; type?: string }) {
      return [...entries.values()].filter(
        (entry) =>
          entry.sessionID === input.sessionID && (!input.type || entry.type === input.type),
      );
    },
    async setRevert(input: { sessionID: string; revert: unknown }) {
      await recording.updateSession({ id: input.sessionID, revert: input.revert } as never);
    },
  });
}

function createRuntime(
  config: Partial<AgentRuntimeConfig> = {},
  deps: Partial<AgentRuntimeDeps> = {},
  sessionStore: ReturnType<typeof createStore> = store,
) {
  return createTestAgentRuntime(
    sessionId,
    {
      mode: "yolo",
      compact: { enabled: false },
      titleGeneration: { enabled: false },
      systemPrompt: "Rules v1",
      ...config,
    },
    {
      eventStore: createTestSessionEventStore(),
      sessionStore: sessionStore as never,
      modelFactory: createTestModelFactory({
        generateText: async (request) => {
          requests.push(structuredClone({ ...request, abortSignal: undefined }));
          return respond(request);
        },
      }),
      ...deps,
    },
  );
}

function probeTool(name: string, description: string): ToolEntry {
  return {
    inputSchema: { type: "object", properties: { value: { type: "string" } } },
    metadata: {
      name,
      description,
      concurrentSafe: true,
      destructive: false,
      needsApproval: false,
      readOnly: true,
      riskLevel: "low",
      sideEffectScope: "none",
    },
    handler: async () => "probed",
  } as ToolEntry;
}

/** 冷恢复：新 store 复制已保存的消息与 entry，新 runtime 从中恢复。 */
async function resume(
  config: Partial<AgentRuntimeConfig> = {},
  tools: ToolEntry[] = [],
  prepare?: (cold: ReturnType<typeof createStore>) => void,
) {
  const cold = createStore();
  await cold.createSession(await store.getSession(sessionId));
  cold.savedMessages.push(...structuredClone(store.savedMessages));
  cold.savedParts.push(...structuredClone(store.savedParts));
  for (const [id, entry] of store.entries) cold.entries.set(id, structuredClone(entry));
  prepare?.(cold);
  const runtime = createRuntime(config, {}, cold);
  for (const tool of tools) runtime.getToolRegistry().register(tool);
  await runtime.resumeFromStore();
  return { runtime, cold };
}

const systemTexts = (request: ModelRequest | undefined) =>
  (request?.messages ?? [])
    .filter((message) => message.role === "system")
    .map((message) => String(message.content));
const toolShape = (request: ModelRequest | undefined) =>
  (request?.tools ?? []).map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
const snapshotOf = (value: ReturnType<typeof createStore>) =>
  [...value.entries.values()].find((entry) => entry.type === SESSION_ENTRY_PROMPT_SNAPSHOT)
    ?.data as (PromptSnapshot & { cleared?: true }) | undefined;
const recordedSystem = (value: ReturnType<typeof createStore>) =>
  (snapshotOf(value)?.system ?? []).map((message) => String(message.content)).join("");
const prefixSystem = (entries: readonly RuntimeMessageEntry[]) =>
  entries
    .flatMap((entry) =>
      entry.kind !== "attachment" && entry.message.role === "system"
        ? [String(entry.message.content)]
        : [],
    )
    .join("");
const trace = () => createRootTraceContext({ sessionId });

beforeEach(() => {
  sessionId = createSessionId();
  store = createStore();
  requests = [];
  respond.mockReset().mockResolvedValue(done);
});

describe("prompt snapshot", () => {
  it("records the first request and resends its system after an upgrade, with the current tools", async () => {
    const runtime = createRuntime();
    runtime.getToolRegistry().register(probeTool("Probe", "Probe v1"));
    await runtime.executeTurn("first");
    const first = requests.at(-1);
    const recorded = snapshotOf(store);
    expect(recorded?.model).toEqual({
      providerId: expect.any(String),
      modelId: expect.any(String),
    });
    expect(recorded?.system.map((message) => String(message.content)).join("")).toContain(
      "Rules v1",
    );
    // 只记录 system：MCP 工具在会话中途会变，记录的工具列表无法保持不变。
    expect(recorded).not.toHaveProperty("tools");

    // 新版本改了 system 文本和工具描述：恢复后的请求仍发送记录的 system，工具按当前注册表。
    const { runtime: cold } = await resume({ systemPrompt: "Rules v2" }, [
      probeTool("Probe", "Probe v2"),
    ]);
    await cold.executeTurn("resumed");
    const resumed = requests.at(-1);
    expect(systemTexts(resumed)).toEqual(systemTexts(first));
    expect(systemTexts(resumed).join("")).not.toContain("Rules v2");
    expect(toolShape(first).find((tool) => tool.name === "Probe")?.description).toBe("Probe v1");
    expect(toolShape(resumed).find((tool) => tool.name === "Probe")?.description).toBe("Probe v2");
  });

  it("re-records for a new session model and leaves it alone for a temporary model", async () => {
    const runtime = createRuntime();
    await runtime.executeTurn("first");
    const recordedModel = snapshotOf(store)?.model;

    const { runtime: cold, cold: coldStore } = await resume({ systemPrompt: "Rules v2" });
    const internal = cold as unknown as AgentRuntimeInternal;
    internal.setSessionModelSelection(createTestModelSelection("test/other-model"));
    await cold.executeTurn("resumed");
    // 会话模型变了：按当前代码组装，并为新模型记录。
    expect(systemTexts(requests.at(-1)).join("")).toContain("Rules v2");
    expect(snapshotOf(coldStore)?.model).toEqual({ providerId: "test", modelId: "other-model" });
    expect(snapshotOf(coldStore)?.model).not.toEqual(recordedModel);

    // 固定执行模型（例如闲时执行）不写快照，也不改已有的快照。
    const before = structuredClone(snapshotOf(coldStore));
    await recordPromptSnapshot(internal, {
      model: { providerId: "test", modelId: "temporary" } as never,
      modelSelectionScope: "execution",
      entries: [],
      traceContext: createRootTraceContext({ sessionId }),
    });
    expect(snapshotOf(coldStore)).toEqual(before);
  });

  it("clears the snapshot after compaction and records the current code again", async () => {
    const runtime = createRuntime();
    await runtime.executeTurn("first");
    const internal = runtime as unknown as AgentRuntimeInternal;
    // 模拟新代码：system 文本变了，但快照仍在，请求继续发送记录的版本。
    internal.config.systemPrompt = "Rules v2";
    await runtime.executeTurn("second");
    expect(systemTexts(requests.at(-1)).join("")).toContain("Rules v1");

    const compacted = await internal.compactActiveConversation(
      undefined,
      createRootTraceContext({ sessionId }),
      [],
      {},
    );
    expect(compacted.outcome).toBe("compacted");
    expect(snapshotOf(store)).toEqual({ cleared: true });
    // compaction 返回的前缀已按当前代码重建。
    expect(
      compacted.entries
        .filter((entry) => entry.kind !== "attachment" && entry.message.role === "system")
        .map((entry) => (entry.kind === "attachment" ? "" : String(entry.message.content)))
        .join(""),
    ).toContain("Rules v2");

    await runtime.executeTurn("after compact");
    expect(systemTexts(requests.at(-1)).join("")).toContain("Rules v2");
    expect(
      snapshotOf(store)
        ?.system.map((message) => String(message.content))
        .join(""),
    ).toContain("Rules v2");
  });

  it("does not use a snapshot outside a main session", async () => {
    const runtime = createRuntime();
    const internal = runtime as unknown as AgentRuntimeInternal;
    internal.config.taskType = "subagent_child";
    await recordPromptSnapshot(internal, {
      model: { providerId: "test", modelId: "default-runtime-model" } as never,
      entries: [],
      traceContext: createRootTraceContext({ sessionId }),
    });
    expect(snapshotOf(store)).toBeUndefined();
  });

  it("copies the snapshot to a forked child session", async () => {
    const runtime = createRuntime();
    await runtime.executeTurn("first");
    const internal = runtime as unknown as AgentRuntimeInternal;
    const childId = createSessionId();
    const entry = buildForkedPromptSnapshotEntry(internal, childId);
    expect(entry).toMatchObject({
      id: `${childId}:runtime-prompt-snapshot`,
      sessionID: childId,
      type: SESSION_ENTRY_PROMPT_SNAPSHOT,
      touchSession: false,
      data: internal.promptSnapshot,
    });
  });

  it("keeps requests working when the snapshot cannot be read or written", async () => {
    const failingWrite = createStore();
    const save = failingWrite.saveSessionEntry;
    failingWrite.saveSessionEntry = async (entry) => {
      if (entry.type === SESSION_ENTRY_PROMPT_SNAPSHOT) throw new Error("disk full");
      return save(entry);
    };
    const runtime = createRuntime({}, {}, failingWrite);
    const outcome = await runtime.executeTurn("first");
    expect(outcome).toBeDefined();
    expect(requests).toHaveLength(1);

    await createRuntime().executeTurn("record");
    const { runtime: cold } = await resume({}, [], (coldStore) => {
      const read = coldStore.sessionEntries;
      coldStore.sessionEntries = async (input) => {
        if (input.type === SESSION_ENTRY_PROMPT_SNAPSHOT) throw new Error("busy");
        return read(input);
      };
    });
    await cold.executeTurn("resumed");
    expect(requests).toHaveLength(3);
  });

  it("does not record a snapshot for a model other than the session model", async () => {
    const internal = createRuntime() as unknown as AgentRuntimeInternal;
    // 降级模型：不是固定执行作用域，但也不是会话模型。
    await recordPromptSnapshot(internal, {
      model: createTurnModel(internal, { selection: createTestModelSelection("test/fallback") }),
      entries: [],
      traceContext: trace(),
    });
    expect(snapshotOf(store)).toBeUndefined();
  });

  it("bypasses the snapshot for a temporary model and uses it again for the session model", async () => {
    const runtime = createRuntime();
    await runtime.executeTurn("first");
    const internal = runtime as unknown as AgentRuntimeInternal;
    const recorded = structuredClone(snapshotOf(store));
    internal.config.systemPrompt = "Rules v2";

    const temporary = createTurnModel(internal, {
      selection: createTestModelSelection("test/temporary"),
    });
    await recordPromptSnapshot(internal, { model: temporary, entries: [], traceContext: trace() });
    // 临时模型不用也不改快照：system 按当前代码。
    expect(prefixSystem(rebuildContextPrefix(internal, { model: temporary }))).toContain(
      "Rules v2",
    );
    // 回到会话模型，system 恢复为记录的字节。
    expect(
      prefixSystem(rebuildContextPrefix(internal, { model: createTurnModel(internal) })),
    ).toContain("Rules v1");
    expect(snapshotOf(store)).toEqual(recorded);
  });

  it("keeps the snapshot when a rewind cuts the history", async () => {
    const runtime = createRuntime();
    await runtime.executeTurn("first");
    await runtime.executeTurn("second");
    const recorded = structuredClone(snapshotOf(store));
    const { runtime: cold, cold: coldStore } = await resume({ systemPrompt: "Rules v2" });
    const second = coldStore.savedParts.find(
      (part) => (part as { text?: string }).text === "second",
    );
    expect(second).toBeDefined();
    await cold.rewindConversationToMessage({
      events: [],
      targetMessageId: second!.messageID,
      traceContext: trace(),
    });
    await cold.executeTurn("edited");
    expect(systemTexts(requests.at(-1)).join("")).toContain("Rules v1");
    expect(snapshotOf(coldStore)).toEqual(recorded);
  });

  it.each([
    ["no snapshot (an older session)", undefined],
    ["unreadable snapshot data", { model: "broken" }],
  ])("records the current code when a resumed session has %s", async (_label, data) => {
    const runtime = createRuntime();
    await runtime.executeTurn("first");
    const id = `${sessionId}:runtime-prompt-snapshot`;
    if (data === undefined) store.entries.delete(id);
    else store.entries.get(id)!.data = data;

    const { runtime: cold, cold: coldStore } = await resume({ systemPrompt: "Rules v2" });
    await cold.executeTurn("resumed");
    expect(systemTexts(requests.at(-1)).join("")).toContain("Rules v2");
    expect(recordedSystem(coldStore)).toContain("Rules v2");
  });

  it("assembles and records again when a cold resume finds the cleared snapshot", async () => {
    const runtime = createRuntime();
    await runtime.executeTurn("first");
    const compacted = await (runtime as unknown as AgentRuntimeInternal).compactActiveConversation(
      undefined,
      trace(),
      [],
      {},
    );
    expect(compacted.outcome).toBe("compacted");
    expect(snapshotOf(store)).toEqual({ cleared: true });

    const { runtime: cold, cold: coldStore } = await resume({ systemPrompt: "Rules v2" });
    await cold.executeTurn("resumed");
    expect(systemTexts(requests.at(-1)).join("")).toContain("Rules v2");
    expect(recordedSystem(coldStore)).toContain("Rules v2");
  });

  it("sends the recorded system for a manual compact right after a cold resume", async () => {
    await createRuntime().executeTurn("first");
    const { runtime: cold, cold: coldStore } = await resume({ systemPrompt: "Rules v2" });
    const before = requests.length;

    await cold.executeTurn("/compact");

    // 手动 /compact 也经过轮次入口：入口先按本轮模型重建前缀，压缩请求发的是记录的 system。
    expect(requests).toHaveLength(before + 1);
    expect(systemTexts(requests[before]).join("")).toContain("Rules v1");
    expect(systemTexts(requests[before]).join("")).not.toContain("Rules v2");
    expect(snapshotOf(coldStore)).toEqual({ cleared: true });
  });

  it("clears the stored snapshot on compaction even when the resume could not read it", async () => {
    await createRuntime().executeTurn("first");
    const { runtime: unread, cold: unreadStore } = await resume(
      { systemPrompt: "Rules v2" },
      [],
      (coldStore) => {
        const read = coldStore.sessionEntries;
        coldStore.sessionEntries = async (input) => {
          if (input.type === SESSION_ENTRY_PROMPT_SNAPSHOT) throw new Error("busy");
          return read(input);
        };
      },
    );

    await unread.executeTurn("/compact");

    // 读取失败时内存里没有快照，但库里还是压缩前的那一行；压缩必须照样写清除标记。
    expect(snapshotOf(unreadStore)).toEqual({ cleared: true });
    store = unreadStore;
    const { runtime: next, cold: nextStore } = await resume({ systemPrompt: "Rules v3" });
    await next.executeTurn("after compact");
    expect(systemTexts(requests.at(-1)).join("")).toContain("Rules v3");
    expect(systemTexts(requests.at(-1)).join("")).not.toContain("Rules v1");
    expect(recordedSystem(nextStore)).toContain("Rules v3");
  });
});
