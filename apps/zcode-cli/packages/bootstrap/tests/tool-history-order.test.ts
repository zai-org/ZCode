import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import {
  InMemorySessionEventStore,
  createRootTraceContext,
  createSessionId,
  type ModelRequest,
  type ToolPart,
} from "@zcode/contracts";
import { AgentRuntime, createToolRegistry } from "@zcode/core";
import { createTestModelFactory } from "../../core/tests/test-runtime-model.js";

const scenarios = [
  "success",
  "tool-error",
  "stream-failure",
  "slow-pending",
  "failed-pending",
  "stop",
] as const;

// 流中 tool_call 的到达顺序：write、native（provider 执行）、read，共用一个块序号计数器。
const BLOCK_INDEX: Record<string, number> = { write: 0, native: 1, read: 2 };

describe("tool order through runtime and SQLite", () => {
  it.each(scenarios)(
    "preserves history and streaming behavior: %s",
    async (scenario) => {
      const root = await mkdtemp(join(tmpdir(), "zcode-tool-order-"));
      const dbPath = join(root, "session.sqlite");
      const sessionId = createSessionId("tool-order");
      // 合并适配：SQLite store 已改为异步打开，必须等初始化完成后再注入持久化故障。
      let store = await createSqliteSessionStore({ dbPath });
      const writes: ToolPart[] = [];
      const writeStatuses = (callID: string) =>
        writes.filter((part) => part.callID === callID).map((part) => part.state.status);
      const pendingStarted = Promise.withResolvers<void>();
      const pendingRelease = Promise.withResolvers<void>();
      const readStarted = Promise.withResolvers<void>();
      const executionOrder: string[] = [];
      const requests: ModelRequest[] = [];
      let pendingAttempts = 0;
      let firstStreamFinished = false;
      let readStartedBeforeFinish = false;
      let laterStreamEventConsumed = false;
      const originalSavePart = store.savePart.bind(store);
      store.savePart = async (part) => {
        if (part.type === "tool") {
          if (
            part.callID === "read" &&
            part.state.status === "pending" &&
            pendingAttempts++ === 0
          ) {
            pendingStarted.resolve();
            if (scenario === "slow-pending" || scenario === "stop") await pendingRelease.promise;
            if (scenario === "failed-pending") throw new Error("injected pending write failure");
          }
          writes.push(structuredClone(part));
        }
        await originalSavePart(part);
      };
      const createRegistry = () => {
        const registry = createToolRegistry();
        for (const name of ["DeferredWrite", "EarlyRead"]) {
          registerFixtureTool(registry, name, name === "EarlyRead", async (_input, context) => {
            executionOrder.push(name);
            if (name === "EarlyRead") {
              readStartedBeforeFinish = !firstStreamFinished;
              readStarted.resolve();
              context.recordReadFileStateMetadata?.({
                content: "EarlyRead result",
                isPartialView: false,
                mtimeMs: 1,
                path: join(root, "early-read.txt"),
                readAtMs: 1,
                revisionId: "rev:early-read",
                schemaVersion: 1,
                sizeBytes: 16,
                tool: "Read",
              });
            }
            if (name === "DeferredWrite" && scenario === "tool-error")
              throw new Error("tool error");
            return `${name} result`;
          });
        }
        return registry;
      };
      const abort = new AbortController();
      const modelFactory = createTestModelFactory({
        async *streamText(request) {
          requests.push(structuredClone(request));
          if (requests.length === 1) {
            yield {
              type: "tool_call",
              toolCall: { id: "write", name: "DeferredWrite", input: {} },
            };
            yield {
              type: "tool_call",
              toolCall: { id: "native", name: "NativeSearch", input: {}, providerExecuted: true },
            };
            yield { type: "tool_call", toolCall: { id: "read", name: "EarlyRead", input: {} } };
            // 同一声明重复到达不占用第二个序号。provider 执行的调用和本地工具共用块序号
            // （write=0、native=1、read=2，见 apps/zcode-cli/docs/design/v2/model/assistant-block-order.md）。
            yield { type: "tool_call", toolCall: { id: "read", name: "EarlyRead", input: {} } };
            if (scenario === "slow-pending" || scenario === "stop") {
              await pendingStarted.promise;
              yield { type: "text_delta", text: "tail while pending is blocked" };
              laterStreamEventConsumed = true;
              if (scenario === "stop") abort.abort();
              pendingRelease.resolve();
            } else if (scenario !== "failed-pending") {
              await readStarted.promise;
            }
            firstStreamFinished = true;
            if (scenario === "stream-failure") throw new Error("Model request timed out.");
            yield { type: "finish", finishReason: "tool-calls", usage: {} };
            return;
          }
          yield { type: "text_delta", text: "done" };
          yield { type: "finish", finishReason: "stop", usage: {} };
        },
      });
      const createRuntime = () =>
        new AgentRuntime(
          sessionId,
          {
            mode: "yolo",
            modelStreaming: "on",
            workingDirectory: root,
            modelSelection: { providerId: "test", modelId: "tool-order" },
          },
          {
            modelFactory,
            sessionStore: store,
            toolRegistry: createRegistry(),
            eventStore: new InMemorySessionEventStore({ retention: "unbounded" }),
          },
        );
      let runtime = createRuntime();
      try {
        const turn = runtime.executeTurn("declare write then read", [], {
          abortSignal: abort.signal,
        });
        if (scenario === "stop") {
          await expect(turn).rejects.toThrow("Turn was cancelled");
          expect(laterStreamEventConsumed).toBe(true);
          expect(executionOrder).toEqual([]);
          // 原 streaming 路径先写 running 再由 executor 检查取消；本修复保持这一记录集合。
          // 取消时没有结果的服务端调用按中断收口，卡片写一次 error 终态（anthropic-stream-compat.md
          // 「中断收口」）；它和 read 写入的先后取决于时序，所以按 callID 分别断言。
          expect(writeStatuses("read")).toEqual(["pending", "running"]);
          expect(writeStatuses("native")).toEqual(["error"]);
          expect(writes.every((part) => part.blockIndex === BLOCK_INDEX[part.callID])).toBe(true);
          return;
        }
        await turn;
        expect(requests).toHaveLength(2);
        expect(pendingAttempts).toBe(scenario === "failed-pending" ? 2 : 1);
        const live = toolHistory(requests[1]!);
        expect(live.calls.map((call) => call.id)).toEqual(["write", "read"]);
        // 服务端调用没有结果，live 回放为 tool_use + 中断错误结果，排在本地工具之前。
        // 断流重试作废的 attempt 不回放服务端轮次（anthropic-stream-compat.md「回放」）。
        expect(live.results.map((result) => result.toolCallId)).toEqual(
          scenario === "stream-failure" ? ["write", "read"] : ["native", "write", "read"],
        );
        if (scenario !== "stream-failure") {
          expect(live.results[0]).toMatchObject({ toolCallId: "native", isError: true });
        }
        expect(executionOrder.filter((name) => name === "EarlyRead")).toHaveLength(1);
        expect(executionOrder.filter((name) => name === "DeferredWrite")).toHaveLength(
          scenario === "stream-failure" ? 0 : 1,
        );
        if (scenario === "slow-pending") expect(laterStreamEventConsumed).toBe(true);
        if (["success", "tool-error", "stream-failure"].includes(scenario)) {
          expect(readStartedBeforeFinish).toBe(true);
          // read 提前执行，写库早于声明在前的 write：物理顺序和声明顺序不同，这是本用例的前提。
          const firstWrite = (callID: string) => writes.findIndex((part) => part.callID === callID);
          expect(firstWrite("read")).toBeLessThan(firstWrite("write"));
          // 读取边界按 blockIndex 排序，读回的是流顺序，不是写库顺序。
          const parts = (await store.messages({ sessionID: sessionId }))
            .flatMap((message) => message.parts)
            .filter((part) => part.type === "tool");
          expect(parts.map((part) => part.callID)).toEqual(["write", "native", "read"]);
          // 读取状态快照序号在 state.metadata 里随 completed 写入保存进 SQLite，读回后仍在。
          const read = parts.find((part) => part.callID === "read");
          expect(
            read?.state.status === "completed" ? read.state.metadata?.readFileState : undefined,
          ).toMatchObject({ snapshotIndex: expect.any(Number) });
        }
        expect(writes.length).toBeGreaterThan(0);

        // 冷恢复确实关闭并重开数据库，再观察新的 ModelFactory 请求。
        runtime.beginShutdown();
        store.close();
        store = await createSqliteSessionStore({ dbPath });
        runtime = createRuntime();
        await runtime.resumeFromStore();
        await runtime.executeTurn("later user query");
        // 已知问题（docs/issues/stream-recovery-provider-round/01-cold-resume-replays-dropped-provider-round.md）：
        // 已有本地工具提交时的断流恢复，live 不带服务端轮次，冷恢复却回放它。这里断言当前差异，
        // 修复后删掉这个分支，改回冷恢复等于 live。
        const coldExpected =
          scenario === "stream-failure"
            ? {
                ...live,
                results: [
                  expect.objectContaining({ toolCallId: "native", isError: true }),
                  ...live.results,
                ],
              }
            : live;
        expect(toolHistory(requests.at(-1)!)).toEqual(coldExpected);
        const laterUser = (await store.messages({ sessionID: sessionId })).findLast(
          (message) => message.info.role === "user",
        );
        expect(laterUser).toBeDefined();
        await runtime.rewindConversationToMessage({
          events: [],
          targetMessageId: laterUser!.info.id,
          traceContext: createRootTraceContext({ sessionId }),
        });
        await runtime.executeTurn("edited later user query");
        expect(toolHistory(requests.at(-1)!)).toEqual(coldExpected);
        expect(writes.every((part) => part.blockIndex === BLOCK_INDEX[part.callID])).toBe(true);
      } finally {
        pendingRelease.resolve();
        runtime.beginShutdown();
        store.close();
        await rm(root, { recursive: true, force: true });
      }
    },
    15_000,
  );

  it("commits live tool results in blockIndex order when tool_call arrival differs", async () => {
    // openai-compatible 在流结束时按 index 发出 tool_call；后一个调用的名字先到时，tool_input_start
    // （分配 blockIndex）与 tool_call（到达顺序）相反。live 必须按 blockIndex 执行并提交结果，
    // 和冷恢复同序，否则重启后请求字节不同。
    const root = await mkdtemp(join(tmpdir(), "zcode-tool-order-arrival-"));
    const dbPath = join(root, "session.sqlite");
    const sessionId = createSessionId("tool-order-arrival");
    let store = await createSqliteSessionStore({ dbPath });
    const requests: ModelRequest[] = [];
    const modelFactory = createTestModelFactory({
      async *streamText(request) {
        requests.push(structuredClone(request));
        if (requests.length === 1) {
          yield { type: "tool_input_start", id: "second", toolName: "ToolB" };
          yield { type: "tool_input_start", id: "first", toolName: "ToolA" };
          yield { type: "tool_call", toolCall: { id: "first", name: "ToolA", input: {} } };
          yield { type: "tool_call", toolCall: { id: "second", name: "ToolB", input: {} } };
          yield { type: "finish", finishReason: "tool-calls", usage: {} };
          return;
        }
        yield { type: "text_delta", text: "done" };
        yield { type: "finish", finishReason: "stop", usage: {} };
      },
    });
    const createRuntime = () => {
      const registry = createToolRegistry();
      for (const name of ["ToolA", "ToolB"]) {
        registerFixtureTool(registry, name, false, async () => `${name} result`);
      }
      return new AgentRuntime(
        sessionId,
        {
          mode: "yolo",
          modelStreaming: "on",
          workingDirectory: root,
          modelSelection: { providerId: "test", modelId: "tool-order" },
        },
        {
          modelFactory,
          sessionStore: store,
          toolRegistry: registry,
          eventStore: new InMemorySessionEventStore({ retention: "unbounded" }),
        },
      );
    };
    let runtime = createRuntime();
    try {
      await runtime.executeTurn("run both tools");
      const live = toolHistory(requests[1]!, ["first", "second"]);
      expect(live.calls.map((call) => call.id)).toEqual(["second", "first"]);
      expect(live.results.map((result) => result.toolCallId)).toEqual(["second", "first"]);

      runtime.beginShutdown();
      store.close();
      store = await createSqliteSessionStore({ dbPath });
      runtime = createRuntime();
      await runtime.resumeFromStore();
      await runtime.executeTurn("later user query");
      expect(toolHistory(requests.at(-1)!, ["first", "second"])).toEqual(live);
    } finally {
      runtime.beginShutdown();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

type ToolRegistry = ReturnType<typeof createToolRegistry>;

function registerFixtureTool(
  registry: ToolRegistry,
  name: string,
  readOnly: boolean,
  handler: Parameters<ToolRegistry["register"]>[0]["handler"],
) {
  const sideEffectScope = readOnly ? "none" : "workspace";
  registry.register({
    capability: "Return a fixed result for tool-history regression",
    inputSchema: {},
    outputSchema: { type: "string" },
    permission: {
      permission: "test",
      reason: "In-process fixture",
      riskLevel: "low",
      sideEffectScope,
      needsApproval: false,
      patternSources: ["none"],
      denyPriority: "beforeAsk",
    },
    resultBudget: { strategy: "inline", maxInlineBytes: 1024, maxModelBytes: 1024 },
    timeout: { kind: "none" },
    cancellation: { supported: true, cleanup: "none", userVisibleMessage: "Cancelled" },
    trace: {
      required: true,
      propagateToAdapters: false,
      recordInput: "none",
      recordOutput: "none",
    },
    metadata: {
      name,
      concurrentSafe: true,
      destructive: false,
      needsApproval: false,
      readOnly,
      riskLevel: "low",
      sideEffectScope,
    },
    handler,
  });
}

function toolHistory(request: ModelRequest, localCallIds: readonly string[] = ["write", "read"]) {
  return {
    calls: request.messages
      .flatMap((message) => message.toolCalls ?? [])
      .filter((call) => localCallIds.includes(call.id)),
    results: request.messages
      .filter((message) => message.role === "tool")
      .map(({ toolCallId, content, isError }) => ({ toolCallId, content, isError })),
  };
}
