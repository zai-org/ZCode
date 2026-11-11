import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createSessionId,
  createToolCallId,
  SessionEventType,
  type SessionStorePort,
  type ToolPart,
} from "@zcode/contracts";
import { createReadFileStatePathKey } from "../src/tool/read-file-state.js";
import { parseReadFileStateMetadata } from "../src/tool/read-file-state-metadata.js";
import type { ReadFileStateMap } from "../src/tool/types.js";
import { MemoryFileSystem } from "./memory-test-utils.js";
import { createRecordingMessageStore } from "./runtime-output-token-continuation-test-helpers.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

const FULL_READ_CALL_ID = "snapshot-order-full-read";
const RANGE_READ_CALL_ID = "snapshot-order-range-read";
const FILE_CONTENT = "one\ntwo\nthree\n";
const FILE_MTIME_MS = 1;

/**
 * 完整 Read 在范围 Read 写入之后才读文件，所以 live 最后写入的是完整视图。
 * - `returns-last`：范围 Read 的结果事件写完再放行完整 Read，完整 Read 也后返回。
 * - `returns-first`：范围 Read 的结果事件开始写入时放行完整 Read，并让这次写入等完整 Read 的结果事件
 *   写完，完整 Read 后写入却先返回（结果事件写入慢时就是这样）。
 */
type ReturnOrder = "returns-last" | "returns-first";

/** 完整 Read 停在屏障上；声明顺序、写入顺序和返回顺序由屏障决定。 */
class HeldFullReadFileSystem extends MemoryFileSystem {
  constructor(
    files: Record<string, string>,
    fileMtimes: Record<string, number>,
    private readonly fullReadGate: Promise<void>,
  ) {
    super(files, fileMtimes);
  }

  // 文件读取快照要求 adapter revision，没有它 Read 不写 metadata，冷恢复无从重放。
  override async stat(request: Parameters<MemoryFileSystem["stat"]>[0]) {
    const stat = await super.stat(request);
    return {
      ...stat,
      revision: { id: `rev:${request.path}`, mtimeMs: stat.mtimeMs, sizeBytes: stat.sizeBytes },
    };
  }

  override async readTextFileRange(
    request: Parameters<MemoryFileSystem["readTextFileRange"]>[0],
  ): ReturnType<MemoryFileSystem["readTextFileRange"]> {
    if (request.limitLines === undefined) await this.fullReadGate;
    return super.readTextFileRange(request);
  }
}

function createFixture(returnOrder: ReturnOrder) {
  const sessionId = createSessionId(`read-state-snapshot-order-${returnOrder}`);
  const workingDirectory = resolve("/tmp/zcode-read-state-snapshot-order");
  const file = resolve(workingDirectory, "notes.txt");
  const store = {
    ...createRecordingMessageStore(),
    async getProjectPermission() {
      return null;
    },
  };
  const eventStore = createTestSessionEventStore();
  const releaseFullRead = Promise.withResolvers<void>();
  const fullResultAppended = Promise.withResolvers<void>();
  const append = eventStore.append.bind(eventStore);
  vi.spyOn(eventStore, "append").mockImplementation(async (event) => {
    const toolCallId = (event.payload as { toolCallId?: string }).toolCallId;
    const isResult = event.type === SessionEventType.ToolCallResult;
    if (isResult && toolCallId === RANGE_READ_CALL_ID && returnOrder === "returns-first") {
      releaseFullRead.resolve();
      await fullResultAppended.promise;
    }
    const stored = await append(event);
    if (isResult && toolCallId === RANGE_READ_CALL_ID && returnOrder === "returns-last") {
      // 结果事件之后执行器还要把结果交回调用方；下一轮宏任务再放行，范围 Read 一定先返回。
      setTimeout(releaseFullRead.resolve, 0);
    }
    if (isResult && toolCallId === FULL_READ_CALL_ID) setTimeout(fullResultAppended.resolve, 0);
    return stored;
  });
  const fileSystemPort = new HeldFullReadFileSystem(
    { [file]: FILE_CONTENT },
    { [file]: FILE_MTIME_MS },
    releaseFullRead.promise,
  );
  let requestCount = 0;
  const modelFactory = createTestModelFactory({
    async generateText() {
      requestCount += 1;
      if (requestCount === 1) {
        return {
          text: "",
          finishReason: "tool-calls",
          usage: {},
          toolCalls: [
            { id: FULL_READ_CALL_ID, name: "Read", input: { file_path: file }, blockIndex: 0 },
            {
              id: RANGE_READ_CALL_ID,
              name: "Read",
              input: { file_path: file, offset: 2, limit: 1 },
              blockIndex: 1,
            },
          ],
        };
      }
      return { text: "done", finishReason: "stop", usage: {} };
    },
  } as never);
  const buildRuntime = (events = eventStore) =>
    createTestAgentRuntime(
      sessionId,
      {
        mode: "yolo",
        modelStreaming: "off",
        titleGeneration: { enabled: false },
        workingDirectory,
      },
      {
        eventStore: events,
        fileSystemPort,
        modelFactory,
        sessionStore: store as unknown as SessionStorePort,
      },
    );
  return { buildRuntime, file, store };
}

async function readWholeFile(
  runtime: ReturnType<typeof createTestAgentRuntime>,
  file: string,
  id: string,
) {
  return runtime.getToolExecutor().execute({
    id: createToolCallId(id),
    input: { file_path: file },
    name: "Read",
  });
}

function snapshotIndexOf(part: ToolPart | undefined): number | undefined {
  if (part?.state.status !== "completed") return undefined;
  return parseReadFileStateMetadata(part.state.metadata)?.snapshotIndex;
}

describe("read file state snapshot order", () => {
  // 修复原因：part 在工具开始前按声明顺序落盘、完成时原地更新；工具结果返回的先后也不等于写入先后
  // （handler 写入之后还有序列化、hook、结果事件等异步步骤）。冷恢复按这两种顺序重放快照时，并行
  // Read 里后写入的完整视图会被范围视图覆盖，重启前后同一次完整 Read 结果不同。
  it.each(["returns-last", "returns-first"] as const)(
    "restores the view of the parallel Read that wrote last when it %s",
    async (returnOrder) => {
      const fixture = createFixture(returnOrder);
      const runtime = fixture.buildRuntime();

      expect((await runtime.executeTurn("read the file twice")).response).toBe("done");

      const readParts = fixture.store.savedParts.filter(
        (part): part is ToolPart => part.type === "tool" && part.tool === "Read",
      );
      expect(readParts.map((part) => [part.callID, part.blockIndex, part.state.status])).toEqual([
        [FULL_READ_CALL_ID, 0, "completed"],
        [RANGE_READ_CALL_ID, 1, "completed"],
      ]);
      const [fullRead, rangeRead] = readParts;
      expect(typeof snapshotIndexOf(rangeRead)).toBe("number");
      expect(snapshotIndexOf(fullRead)).toBeGreaterThan(snapshotIndexOf(rangeRead) ?? Infinity);

      const live = await readWholeFile(runtime, fixture.file, "snapshot-order-live-probe");
      const resumed = fixture.buildRuntime(createTestSessionEventStore());
      await resumed.resumeFromStore();
      // 冷恢复出的记录带进程内标记，compaction 按读取时间给它们排序。
      const resumedState = (resumed as unknown as { readFileState: ReadFileStateMap })
        .readFileState;
      expect(resumedState.get(createReadFileStatePathKey(fixture.file))?.restoredFromSession).toBe(
        true,
      );
      const cold = await readWholeFile(resumed, fixture.file, "snapshot-order-cold-probe");

      const unchanged = { type: "file_unchanged", filePath: fixture.file };
      expect([live.output, cold.output]).toEqual([unchanged, unchanged]);
    },
  );
});
