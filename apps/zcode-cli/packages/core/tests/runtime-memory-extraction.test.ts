import { drainMemoryExtractions } from "../src/runtime/helpers/project-memory-extraction.js";
import { isHiddenReminderMessage } from "../src/runtime/helpers/conversation.js";
import { describe, expect, it } from "vitest";
import {
  createPartId,
  createSessionId,
  type MessageInfo,
  type MessagePart,
  type MessageWithParts,
  type ModelInputFormat,
  type Model,
  type ModelInvocationContext,
  type ModelRequest,
  type ModelResult,
  type SessionInfo,
  type SessionStorePort,
  type SessionTaskType,
  type ToolArtifactStorePort,
} from "@zcode/contracts";

import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestModelSelection } from "./test-model-selection.js";
import { resolveProjectMemoryRoot } from "../src/memory/project-root.js";
import { createReadFileStatePathKey } from "../src/tool/read-file-state.js";
import { createToolRegistry, type ToolRegistry } from "../src/tool/registry.js";
import { MemoryFileSystem } from "./memory-test-utils.js";
import { createTestImageArtifactStore } from "./test-image-artifact-store.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import {
  createTestInputFormat,
  createTestModelFactory,
  type TestModelExecutionObservation,
} from "./test-runtime-model.js";
import type { RuntimeModelFactory } from "../src/runtime/types.js";

const CLI_STORAGE_ROOT = "/storage/cli";
const WORKSPACE_PATH = "/workspace/project";
const EXTRACTION_PROMPT_MARKER = "memory extraction subagent";
const TEST_MODEL_REF = createTestModelSelection("test/memory-extraction");

describe("AgentRuntime background Memory extraction", () => {
  it("skips only the turn carrying the per-turn Extraction policy", async () => {
    let extractionRequestCount = 0;
    const runtime = createExtractionRuntime({
      async generateText(request) {
        if (isExtractionRequest(request)) extractionRequestCount += 1;
        return textResult(
          request,
          isExtractionRequest(request) ? "Nothing to save." : "main answer",
        );
      },
    });

    await runtime.executeTurn("do not remember this turn", undefined, {
      modelExecution: { memoryExtraction: "skip", selectionScope: "execution" },
    });
    await runtime.drainMemoryExtractions();
    expect(extractionRequestCount).toBe(0);

    await runtime.executeTurn("remember this later durable preference");
    await runtime.drainMemoryExtractions();
    expect(extractionRequestCount).toBe(1);
  });

  it("reuses the completed Turn Active Model instead of resolving Session Selection again", async () => {
    const createdSelections: string[] = [];
    const modelFactory = createTestModelFactory({
      onCreate(input) {
        createdSelections.push(`${input.selection.providerId}/${input.selection.modelId}`);
      },
      async generateText(request) {
        return textResult(
          request,
          isExtractionRequest(request) ? "Nothing to save." : "main answer",
        );
      },
    });
    const runtime = createExtractionRuntime({
      async generateText(request) {
        return textResult(request, "unused");
      },
      modelFactory,
    });

    await runtime.executeTurn("remember the execution-scoped result", undefined, {
      intent: {
        admissionSeq: 1,
        admittedAt: Date.now(),
        admittedDelivery: "startNow",
        clientId: "memory-test-client",
        kind: "sendText",
        modelSelection: {
          providerId: "account:zai-offpeak-idle-plan",
          modelId: "GLM-5.3-Flash",
        },
        queueItemId: "memory-test-input",
        requestedDelivery: "startNow",
        sourceCommandId: "memory-test-command",
      },
      modelExecution: { selectionScope: "execution" },
    });
    await runtime.drainMemoryExtractions();

    expect(createdSelections).toEqual(["account:zai-offpeak-idle-plan/GLM-5.3-Flash"]);
  });

  it("projects unsupported historical video before an Extraction request", async () => {
    const extractionRequests: ModelRequest[] = [];
    const runtime = createExtractionRuntime({
      artifactStore: createTestImageArtifactStore(),
      inputFormat: { supportsVideo: false },
      async generateText(request) {
        if (isExtractionRequest(request)) extractionRequests.push(request);
        return textResult(
          request,
          isExtractionRequest(request) ? "Nothing to save." : "main answer",
        );
      },
    });
    await runtime.executeTurn("persist this durable project preference", [
      { type: "video", content: "data:video/mp4;base64,dmlkZW8=" },
    ]);
    await runtime.drainMemoryExtractions();

    expect(extractionRequests).toHaveLength(1);
    expect(
      extractionRequests[0]!.messages.flatMap((message) =>
        Array.isArray(message.content)
          ? message.content.filter((block) => block.type === "video")
          : [],
      ),
    ).toHaveLength(0);
    expect(providerMessagesToText(extractionRequests[0]!.messages)).toContain(
      "does not support video input",
    );
  });

  it("starts after a successful Main turn without blocking it and keeps the frozen Main context and tools", async () => {
    const extractionStarted = deferred<void>();
    const extractionResponse = deferred<ModelResult>();
    const extractionRequests: ModelRequest[] = [];
    let extractionContext: ModelInvocationContext | undefined;
    let headerRefreshCount = 0;
    const runtime = createExtractionRuntime({
      async generateText(request, observation) {
        if (!isExtractionRequest(request)) return textResult(request, "main answer");
        extractionRequests.push(request);
        extractionContext = observation.invocationContext;
        await observation.invocationContext?.refreshRuntimeHeadersBeforeAttempt?.({
          abortSignal: request.abortSignal,
          attempt: 1,
        });
        extractionStarted.resolve();
        return await extractionResponse.promise;
      },
      onRuntimeHeaderRefresh: () => {
        headerRefreshCount += 1;
      },
    });

    const result = await runtime.executeTurn("remember this durable project preference");
    expect(result.response).toBe("main answer");
    await extractionStarted.promise;

    const request = extractionRequests[0]!;
    const requestText = providerMessagesToText(request.messages);
    expect(requestText).toContain("# Memory");
    expect(requestText).toContain("remember this durable project preference");
    expect(requestText).toContain("main answer");
    expect(requestText).toContain(EXTRACTION_PROMPT_MARKER);
    expect(request.tools?.map((tool) => tool.name)).toEqual(
      runtime
        .getTools()
        .map((tool) => tool.name)
        .filter(
          (name) => name !== "WebSearch" && name !== "ToolSearch" && name !== "DeferredToolCall",
        ),
    );
    expect(request.toolSearchEnabled).toBe(false);
    expect(headerRefreshCount).toBe(1);

    extractionResponse.resolve(textResult(request, "Nothing to save."));
    await runtime.drainMemoryExtractions();
    expect(extractionContext).toMatchObject({
      modelRequestSessionType: "main",
      metadata: { querySource: "project_memory_extract", skipTranscript: true },
    });
  });

  it("prepares inherited ToolSearch history against the frozen Memory tool scope", async () => {
    const requests: ModelRequest[] = [];
    let mainRequests = 0;
    const generateText = async (request: ModelRequest): Promise<ModelResult> => {
      requests.push(request);
      if (isExtractionRequest(request)) return textResult(request, "Nothing to save.");
      if (++mainRequests === 1)
        return {
          text: "",
          finishReason: "tool-calls",
          usage: {},
          toolCalls: [
            { id: "search-memory", name: "ToolSearch", input: { query: "select:TaskOutput" } },
          ],
        };
      return textResult(request, "main answer");
    };
    const baseFactory = createTestModelFactory({ generateText });
    const withSearch = (model: Model): Model => ({
      ...model,
      requestCapabilities: { toolSearch: { protocolSupported: true, defaultEnabled: true } },
      bind: (options) => withSearch(model.bind(options)),
    });
    const runtime = createExtractionRuntime({
      generateText,
      modelFactory: (input) => withSearch(baseFactory(input)),
      toolSearch: { mode: "native" },
    });
    await runtime.executeTurn("remember that I use TaskOutput");
    await runtime.drainMemoryExtractions();
    const extraction = requests.find(isExtractionRequest)!;
    expect(extraction.toolSearchEnabled).toBe(false);
    expect(extraction.tools?.some((tool) => tool.name === "ToolSearch")).toBe(false);
    expect(
      extraction.tools?.find((tool) => tool.name === "TaskOutput")?.deferLoading,
    ).toBeUndefined();
    expect(providerMessagesToText(extraction.messages)).toContain(
      "Tool references removed - tool search not enabled",
    );
    expect(JSON.stringify(extraction.messages)).not.toContain('"tool_reference"');
    expect(providerMessagesToText(extraction.messages)).not.toContain("schemas are NOT loaded");
    expect(
      JSON.stringify(requests.filter((request) => !isExtractionRequest(request)).at(-1)?.messages),
    ).toContain('"tool_reference"');
  });

  it("bounds a lazy pending snapshot to the successful Main turn that scheduled it", async () => {
    const firstExtractionStarted = deferred<void>();
    const firstExtractionResponse = deferred<ModelResult>();
    const pendingExtractionStarted = deferred<void>();
    const futureMainStarted = deferred<void>();
    const futureMainResponse = deferred<ModelResult>();
    const extractionRequests: ModelRequest[] = [];
    const sessionStore = createMemorySessionStore();
    let extractionRequestCount = 0;
    let mainRequestCount = 0;
    const runtime = createExtractionRuntime({
      sessionStore,
      async generateText(request) {
        if (isExtractionRequest(request)) {
          extractionRequests.push(request);
          extractionRequestCount += 1;
          if (extractionRequestCount === 1) {
            firstExtractionStarted.resolve();
            return await firstExtractionResponse.promise;
          }
          pendingExtractionStarted.resolve();
          return textResult(request, "Nothing to save.");
        }

        mainRequestCount += 1;
        if (mainRequestCount === 3) {
          futureMainStarted.resolve();
          return await futureMainResponse.promise;
        }
        return textResult(request, `main answer ${mainRequestCount}`);
      },
    });

    await runtime.executeTurn("persist the first durable preference");
    await firstExtractionStarted.promise;
    const firstTurnMessages = await sessionStore.messages({ sessionID: runtime.getSessionId() });
    const firstTurnBoundary = firstTurnMessages.at(-1);
    expect(firstTurnBoundary).toBeDefined();

    await runtime.executeTurn("persist the second durable preference");
    const secondTurnMessages = await sessionStore.messages({ sessionID: runtime.getSessionId() });
    const secondTurnBoundary = secondTurnMessages.at(-1);
    expect(secondTurnBoundary).toBeDefined();
    const firstTurnBoundaryIndex = secondTurnMessages.findIndex(
      (message) => message.info.id === firstTurnBoundary!.info.id,
    );
    expect(firstTurnBoundaryIndex).toBeGreaterThanOrEqual(0);
    // "~N messages" 只数对话消息：第二轮的隐藏提醒记录（token 预算提醒）不计入。
    const expectedPendingMessageCount = secondTurnMessages
      .slice(firstTurnBoundaryIndex + 1)
      .filter((message) => !isHiddenReminderMessage(message)).length;

    const futureTurn = runtime.executeTurn(
      "future turn content must stay outside pending extraction",
    );
    await futureMainStarted.promise;
    firstExtractionResponse.resolve(textResult(undefined, "Nothing to save."));
    await pendingExtractionStarted.promise;
    await runtime.drainMemoryExtractions();
    expect((runtime as any).memoryExtractionScheduler.getCursor()).toBe(
      secondTurnBoundary!.info.id,
    );

    futureMainResponse.resolve(textResult(undefined, "future main answer"));
    await futureTurn;
    await runtime.drainMemoryExtractions();

    const pendingRequestText = providerMessagesToText(extractionRequests[1]?.messages ?? []);
    expect(pendingRequestText).toContain(`most recent ~${expectedPendingMessageCount} messages`);
    expect(pendingRequestText).not.toContain(
      "future turn content must stay outside pending extraction",
    );
  });

  it("keeps a pending extraction on its successful-turn snapshot after a later rewind", async () => {
    const firstExtractionStarted = deferred<void>();
    const releaseFirstExtraction = deferred<void>();
    const extractionRequests: ModelRequest[] = [];
    const sessionStore = createMemorySessionStore();
    const runtime = createExtractionRuntime({
      sessionStore,
      async generateText(request) {
        if (isExtractionRequest(request)) {
          extractionRequests.push(request);
          if (extractionRequests.length === 1) {
            firstExtractionStarted.resolve();
            await releaseFirstExtraction.promise;
            throw new Error("first extraction failed");
          }
          return textResult(request, "Nothing to save.");
        }
        return textResult(request, "main answer");
      },
    });

    await runtime.executeTurn("retain this first durable preference");
    await firstExtractionStarted.promise;
    await runtime.executeTurn("discard this second obsolete preference");

    const persistedMessages = await sessionStore.messages({ sessionID: runtime.getSessionId() });
    const secondTurnBoundary = persistedMessages.at(-1);
    const discardedUserMessage = persistedMessages
      .filter((message) => message.info.role === "user" && !message.info.synthetic)
      .at(-1);
    expect(discardedUserMessage).toBeDefined();

    await runtime.executeTurn(`/rewind message ${discardedUserMessage!.info.id}`);
    releaseFirstExtraction.resolve();
    await runtime.drainMemoryExtractions();

    expect(extractionRequests).toHaveLength(2);
    expect(providerMessagesToText(extractionRequests[1]?.messages ?? [])).toContain(
      "discard this second obsolete preference",
    );
    expect((runtime as any).memoryExtractionScheduler.getCursor()).toBe(
      secondTurnBoundary?.info.id,
    );

    await runtime.executeTurn("capture this replacement durable preference");
    await runtime.drainMemoryExtractions();

    expect(extractionRequests).toHaveLength(3);
    const replacementRequestText = providerMessagesToText(
      extractionRequests.at(-1)?.messages ?? [],
    );
    expect(replacementRequestText).toContain("retain this first durable preference");
    expect(replacementRequestText).toContain("capture this replacement durable preference");
    expect(replacementRequestText).not.toContain("discard this second obsolete preference");
    expect(replacementRequestText).toContain(EXTRACTION_PROMPT_MARKER);
  });

  it("schedules Extraction for a remote workspace whose CLI runs on the remote host", async () => {
    let extractionRequestCount = 0;
    const runtime = createExtractionRuntime({
      isRemoteWorkspace: () => true,
      async generateText(request) {
        if (isExtractionRequest(request)) extractionRequestCount += 1;
        return textResult(
          request,
          isExtractionRequest(request) ? "Nothing to save." : "main answer",
        );
      },
    });

    await runtime.executeTurn("persist this durable project preference");
    await runtime.drainMemoryExtractions();

    expect(extractionRequestCount).toBe(1);
  });

  it.each<{
    memory?: { enabled?: boolean; use?: boolean };
    name: string;
    taskType?: SessionTaskType;
  }>([
    { name: "child task", taskType: "subagent_child" },
    { memory: { enabled: false }, name: "disabled feature" },
    { memory: { use: false }, name: "disabled use" },
  ])("does not schedule Extraction for $name", async (input) => {
    let extractionRequestCount = 0;
    const runtime = createExtractionRuntime({
      memory: input.memory,
      taskType: input.taskType,
      async generateText(request) {
        if (isExtractionRequest(request)) extractionRequestCount += 1;
        return textResult(request, "main answer");
      },
    });

    await runtime.executeTurn("persist this durable project preference");
    await nextTask();
    await runtime.drainMemoryExtractions(10);

    expect(extractionRequestCount).toBe(0);
  });

  it("returns before acquiring an Extraction snapshot when automatic Extraction is disabled", async () => {
    const baseSessionStore = createMemorySessionStore();
    const messageReadStacks: string[] = [];
    const sessionReadStacks: string[] = [];
    const sessionStore: SessionStorePort = {
      ...baseSessionStore,
      async messages(input) {
        messageReadStacks.push(new Error().stack ?? "");
        return baseSessionStore.messages(input);
      },
      async getSession(sessionID) {
        sessionReadStacks.push(new Error().stack ?? "");
        return baseSessionStore.getSession(sessionID);
      },
    };
    let extractionRequestCount = 0;
    const runtime = createExtractionRuntime({
      memory: { extractionEnabled: false },
      sessionStore,
      async generateText(request) {
        if (isExtractionRequest(request)) extractionRequestCount += 1;
        return textResult(request, "main answer");
      },
    });

    await runtime.executeTurn("persist this durable project preference");
    await nextTask();
    await runtime.drainMemoryExtractions(10);

    expect(extractionRequestCount).toBe(0);
    expect(extractionReadCount(messageReadStacks)).toBe(0);
    expect(extractionReadCount(sessionReadStacks)).toBe(0);
    expect((runtime as any).memoryExtractionScheduler).toBeUndefined();
  });

  it("does not schedule Extraction after a failed Main turn", async () => {
    let requestCount = 0;
    const runtime = createExtractionRuntime({
      async generateText() {
        requestCount += 1;
        throw new Error("main model failed");
      },
    });

    await expect(runtime.executeTurn("persist this durable project preference")).rejects.toThrow(
      "Turn execution failed",
    );
    await nextTask();

    expect(requestCount).toBe(1);
  });

  it("does not schedule Extraction after a cancelled Main turn", async () => {
    const mainStarted = deferred<void>();
    let extractionRequestCount = 0;
    const runtime = createExtractionRuntime({
      async generateText(request) {
        if (isExtractionRequest(request)) {
          extractionRequestCount += 1;
          return textResult(request, "Nothing to save.");
        }
        mainStarted.resolve();
        await waitForAbort(request.abortSignal);
        throw new DOMException("cancelled", "AbortError");
      },
    });
    const abortController = new AbortController();

    const turn = runtime.executeTurn("persist this durable project preference", undefined, {
      abortSignal: abortController.signal,
    });
    await mainStarted.promise;
    abortController.abort();
    await expect(turn).rejects.toMatchObject({ type: "turn_cancelled" });
    await nextTask();

    expect(extractionRequestCount).toBe(0);
  });

  it("keeps Extraction on the initial project root after the execution cwd changes", async () => {
    const extractionRequests: ModelRequest[] = [];
    const runtime = createExtractionRuntime({
      async generateText(request) {
        if (isExtractionRequest(request)) extractionRequests.push(request);
        return textResult(request, isExtractionRequest(request) ? "Nothing to save." : "done");
      },
    });

    await runtime.executeTurn("one two");
    await runtime.drainMemoryExtractions();
    (runtime as unknown as { setWorkingDirectory(cwd: string): void }).setWorkingDirectory(
      `${WORKSPACE_PATH}/nested`,
    );
    await runtime.executeTurn("persist this durable project preference");
    await runtime.drainMemoryExtractions();

    const initialMemoryRoot = resolveProjectMemoryRoot({
      cliStorageRoot: CLI_STORAGE_ROOT,
      workspacePath: WORKSPACE_PATH,
    });
    const nestedMemoryRoot = resolveProjectMemoryRoot({
      cliStorageRoot: CLI_STORAGE_ROOT,
      workspacePath: `${WORKSPACE_PATH}/nested`,
    });
    const extractionText = providerMessagesToText(extractionRequests[0]?.messages ?? []);
    expect(extractionRequests).toHaveLength(1);
    expect(extractionText).toContain(initialMemoryRoot);
    expect(extractionText).not.toContain(nestedMemoryRoot);
  });

  it("aborts the running Extraction when runtime shutdown begins", async () => {
    const extractionStarted = deferred<void>();
    let extractionSignal: AbortSignal | undefined;
    const runtime = createExtractionRuntime({
      async generateText(request) {
        if (!isExtractionRequest(request)) return textResult(request, "main answer");
        extractionSignal = request.abortSignal;
        extractionStarted.resolve();
        await waitForAbort(request.abortSignal);
        throw new DOMException("cancelled", "AbortError");
      },
    });

    await runtime.executeTurn("persist this durable project preference");
    await extractionStarted.promise;
    runtime.beginShutdown();

    expect(extractionSignal?.aborted).toBe(true);
    await runtime.drainMemoryExtractions();
    expect((runtime as any).memoryExtractionScheduler.getCursor()).toBeUndefined();
  });

  it("does not schedule Extraction when a successful Main turn finishes after shutdown starts", async () => {
    const mainStarted = deferred<void>();
    const mainResponse = deferred<ModelResult>();
    let extractionRequestCount = 0;
    const runtime = createExtractionRuntime({
      async generateText(request) {
        if (isExtractionRequest(request)) {
          extractionRequestCount += 1;
          return textResult(request, "Nothing to save.");
        }
        mainStarted.resolve();
        return await mainResponse.promise;
      },
    });

    const turn = runtime.executeTurn("persist this durable project preference");
    await mainStarted.promise;
    runtime.beginShutdown();
    mainResponse.resolve(textResult(undefined, "main answer"));
    await turn;
    await nextTask();

    expect(extractionRequestCount).toBe(0);
  });

  it("clones Main read state into the independent Extraction executor", async () => {
    const memoryRoot = resolveProjectMemoryRoot({
      cliStorageRoot: CLI_STORAGE_ROOT,
      workspacePath: WORKSPACE_PATH,
    });
    const memoryPath = `${memoryRoot}/fact.md`;
    const fileSystemPort = new MemoryFileSystem({ [memoryPath]: "old fact" });
    const toolRegistry = createToolRegistry();
    let extractionTurn = 0;
    let followupRequestText = "";
    const runtime = createExtractionRuntime({
      fileSystemPort,
      toolRegistry,
      async generateText(request) {
        if (!isExtractionRequest(request)) return textResult(request, "main answer");
        extractionTurn += 1;
        if (extractionTurn === 1) {
          return {
            ...textResult(request, ""),
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: "edit-memory",
                name: "Edit",
                input: {
                  file_path: memoryPath,
                  old_string: "old fact",
                  new_string: "new fact",
                },
              },
            ],
          };
        }
        followupRequestText = providerMessagesToText(request.messages);
        return textResult(request, "Nothing to save.");
      },
    });
    (runtime as any).readFileState.set(createReadFileStatePathKey(memoryPath), {
      path: memoryPath,
      content: "old fact",
      isPartialView: false,
      readAt: new Date(),
      sizeBytes: Buffer.byteLength("old fact"),
    });

    await runtime.executeTurn("persist this durable project preference");
    await runtime.drainMemoryExtractions();

    expect(followupRequestText).not.toContain("has not been read");
    expect(fileSystemPort.files[memoryPath]).toBe("new fact");
  });

  // Memory Agent 与 Main 共用单步内核：同一批工具结果的批次提示、同一个渲染器、同一套调度。
  it.each([
    { label: "MCS", midConversationSystem: true, noticeRole: "system" },
    { label: "non-MCS", midConversationSystem: false, noticeRole: "user" },
  ])(
    "delivers the Read partial-view notice to the next Extraction request ($label)",
    async ({ midConversationSystem, noticeRole }) => {
      const longPath = `${WORKSPACE_PATH}/long-notes.md`;
      const fileSystemPort = new MemoryFileSystem({
        [longPath]: Array.from(
          { length: 1_800 },
          (_, index) => `line ${index + 1} ${"durable project detail ".repeat(4)}`,
        ).join("\n"),
      });
      let extractionTurn = 0;
      let followup: ModelRequest | undefined;
      const generateText = async (request: ModelRequest): Promise<ModelResult> => {
        if (!isExtractionRequest(request)) return textResult(request, "main answer");
        extractionTurn += 1;
        if (extractionTurn === 1) {
          return {
            ...textResult(request, ""),
            finishReason: "tool_calls",
            toolCalls: [{ id: "read-long", name: "Read", input: { file_path: longPath } }],
          };
        }
        followup = request;
        return textResult(request, "Nothing to save.");
      };
      const runtime = createExtractionRuntime({
        fileSystemPort,
        generateText,
        modelFactory: createTestModelFactory({
          generateText,
          properties: { supportsMidConversationSystem: midConversationSystem },
        }),
      });

      await runtime.executeTurn("persist this durable project preference");
      await runtime.drainMemoryExtractions();

      const messages = followup!.messages;
      const toolIndex = messages.findIndex(
        (message) => message.role === "tool" && message.toolCallId === "read-long",
      );
      expect(toolIndex).toBeGreaterThan(0);
      expect(providerMessagesToText([messages[toolIndex]!])).not.toContain("PARTIAL view");
      const notice = messages[toolIndex + 1]!;
      expect(notice.role).toBe(noticeRole);
      expect(providerMessagesToText([notice])).toContain(
        `[Truncated: PARTIAL view \u2014 ${longPath}: showing lines 1-`,
      );
    },
  );

  it("runs the Edits of one Extraction batch one after another", async () => {
    const memoryRoot = resolveProjectMemoryRoot({
      cliStorageRoot: CLI_STORAGE_ROOT,
      workspacePath: WORKSPACE_PATH,
    });
    const memoryPath = `${memoryRoot}/fact.md`;
    const fileSystemPort = new MemoryFileSystem({ [memoryPath]: "first" });
    let extractionTurn = 0;
    let followupRequestText = "";
    const runtime = createExtractionRuntime({
      fileSystemPort,
      async generateText(request) {
        if (!isExtractionRequest(request)) return textResult(request, "main answer");
        extractionTurn += 1;
        if (extractionTurn === 1) {
          return {
            ...textResult(request, ""),
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: "edit-first",
                name: "Edit",
                input: { file_path: memoryPath, old_string: "first", new_string: "second" },
              },
              {
                id: "edit-second",
                name: "Edit",
                input: { file_path: memoryPath, old_string: "second", new_string: "third" },
              },
            ],
          };
        }
        followupRequestText = providerMessagesToText(request.messages);
        return textResult(request, "Nothing to save.");
      },
    });
    (runtime as any).readFileState.set(createReadFileStatePathKey(memoryPath), {
      path: memoryPath,
      content: "first",
      isPartialView: false,
      readAt: new Date(),
      sizeBytes: Buffer.byteLength("first"),
    });

    await runtime.executeTurn("persist this durable project preference");
    await runtime.drainMemoryExtractions();

    // Edit 不是 concurrentSafe：与 Main 一样按顺序执行，第二个 Edit 看到第一个的结果。
    expect(followupRequestText).not.toContain("String to replace not found");
    expect(fileSystemPort.files[memoryPath]).toBe("third");
  });

  it("does not let discarded branch prose satisfy the Extraction gate after rewind", async () => {
    const sessionStore = createMemorySessionStore();
    let extractionRequestCount = 0;
    const runtime = createExtractionRuntime({
      sessionStore,
      async generateText(request) {
        if (isExtractionRequest(request)) {
          extractionRequestCount += 1;
          if (extractionRequestCount === 1) throw new Error("extraction failed");
          return textResult(request, "Nothing to save.");
        }
        return textResult(request, "main answer");
      },
    });

    await runtime.executeTurn("discard this obsolete preference");
    await runtime.drainMemoryExtractions();

    const persistedMessages = await sessionStore.messages({ sessionID: runtime.getSessionId() });
    const discardedUserMessage = persistedMessages
      .filter((message) => message.info.role === "user" && !message.info.synthetic)
      .at(-1);
    expect(discardedUserMessage).toBeDefined();

    await runtime.executeTurn(`/rewind message ${discardedUserMessage!.info.id}`);
    await runtime.executeTurn("new choice");
    await runtime.drainMemoryExtractions();

    expect(extractionRequestCount).toBe(1);
  });

  it("keeps pre-compact active prose while excluding the discarded rewind branch", async () => {
    const extractionRequests: ModelRequest[] = [];
    const sessionStore = createMemorySessionStore();
    const runtime = createExtractionRuntime({
      sessionStore,
      async generateText(request) {
        if (isExtractionRequest(request)) {
          extractionRequests.push(request);
          if (extractionRequests.length < 3) throw new Error("extraction failed");
          return textResult(request, "Nothing to save.");
        }
        return textResult(request, "main answer");
      },
    });

    await runtime.executeTurn("keep this durable preference");
    await runtime.drainMemoryExtractions();
    const firstTurnMessages = await sessionStore.messages({ sessionID: runtime.getSessionId() });
    const firstAssistant = firstTurnMessages.find((message) => message.info.role === "assistant");
    expect(firstAssistant).toBeDefined();
    await sessionStore.savePart({
      auto: false,
      id: createPartId("memory-extraction-compact-boundary"),
      messageID: firstAssistant!.info.id,
      sessionID: runtime.getSessionId(),
      type: "compaction",
    });

    await runtime.executeTurn("discard this obsolete preference");
    await runtime.drainMemoryExtractions();
    const beforeRewind = await sessionStore.messages({ sessionID: runtime.getSessionId() });
    const discardedUserMessage = beforeRewind
      .filter((message) => message.info.role === "user" && !message.info.synthetic)
      .at(-1);
    expect(discardedUserMessage).toBeDefined();

    await runtime.executeTurn(`/rewind message ${discardedUserMessage!.info.id}`);
    await runtime.executeTurn("new choice");
    await runtime.drainMemoryExtractions();

    expect(extractionRequests).toHaveLength(3);
    const finalRequestText = providerMessagesToText(extractionRequests.at(-1)?.messages ?? []);
    // 只数当前路径上的对话消息（两轮各一问一答）；首次与 rewind 后补发的持久化公告
    // （environment、model、agent 目录、date）不计入。
    expect(finalRequestText).toContain("most recent ~4 messages");
  });

  it("reads durable messages and branch metadata at each schedule boundary only", async () => {
    const baseSessionStore = createMemorySessionStore();
    const messageReadStacks: string[] = [];
    const sessionReadStacks: string[] = [];
    const sessionStore: SessionStorePort = {
      ...baseSessionStore,
      async messages(input) {
        messageReadStacks.push(new Error().stack ?? "");
        return baseSessionStore.messages(input);
      },
      async getSession(sessionID) {
        sessionReadStacks.push(new Error().stack ?? "");
        return baseSessionStore.getSession(sessionID);
      },
    };
    const firstExtractionStarted = deferred<void>();
    const firstExtractionResponse = deferred<ModelResult>();
    let extractionRequestCount = 0;
    const runtime = createExtractionRuntime({
      sessionStore,
      async generateText(request) {
        if (!isExtractionRequest(request)) return textResult(request, "main answer");
        extractionRequestCount += 1;
        if (extractionRequestCount === 1) {
          firstExtractionStarted.resolve();
          return firstExtractionResponse.promise;
        }
        return textResult(request, "Nothing to save.");
      },
    });

    await runtime.executeTurn("persist the first durable preference");
    await firstExtractionStarted.promise;
    const readsAfterFirstSchedule = {
      messages: extractionReadCount(messageReadStacks),
      session: extractionReadCount(sessionReadStacks),
    };

    await runtime.executeTurn("persist the latest durable preference");
    expect(extractionReadCount(messageReadStacks) - readsAfterFirstSchedule.messages).toBe(1);
    expect(extractionReadCount(sessionReadStacks) - readsAfterFirstSchedule.session).toBe(1);
    const readsAfterPendingSchedule = {
      messages: extractionReadCount(messageReadStacks),
      session: extractionReadCount(sessionReadStacks),
    };

    firstExtractionResponse.resolve(textResult(undefined, "Nothing to save."));
    await runtime.drainMemoryExtractions();

    expect(extractionRequestCount).toBe(2);
    expect(extractionReadCount(messageReadStacks)).toBe(readsAfterPendingSchedule.messages);
    expect(extractionReadCount(sessionReadStacks)).toBe(readsAfterPendingSchedule.session);
  });
});

function createExtractionRuntime(input: {
  toolSearch?: { mode: "native" | "local" | "off" | "auto" };
  artifactStore?: ToolArtifactStorePort;
  generateText: (
    request: ModelRequest,
    observation: TestModelExecutionObservation,
  ) => Promise<ModelResult>;
  fileSystemPort?: MemoryFileSystem;
  isRemoteWorkspace?: () => boolean;
  memory?: { enabled?: boolean; extractionEnabled?: boolean; use?: boolean };
  inputFormat?: Partial<ModelInputFormat>;
  modelFactory?: RuntimeModelFactory;
  onRuntimeHeaderRefresh?: () => void;
  sessionStore?: SessionStorePort;
  taskType?: SessionTaskType;
  toolRegistry?: ToolRegistry;
}): AgentRuntime {
  const fileSystemPort = input.fileSystemPort ?? new MemoryFileSystem({});
  return createTestAgentRuntime(
    createSessionId(`runtime-memory-extraction-${crypto.randomUUID()}`),
    {
      toolSearch: input.toolSearch,
      memory: {
        cliStorageRoot: CLI_STORAGE_ROOT,
        enabled: true,
        use: true,
        ...input.memory,
      },
      mode: "yolo",
      taskType: input.taskType,
      titleGeneration: { enabled: false },
      workingDirectory: WORKSPACE_PATH,
    },
    {
      artifactStore: input.artifactStore,
      eventStore: createTestSessionEventStore(),
      fileSystemPort,
      isRemoteWorkspace: input.isRemoteWorkspace,
      modelFactory:
        input.modelFactory ??
        createTestModelFactory({
          generateText: input.generateText,
          ...(input.inputFormat
            ? { properties: { inputFormat: createTestInputFormat(input.inputFormat) } }
            : {}),
        }),
      providerRuntimeHeadersPort: input.onRuntimeHeaderRefresh
        ? {
            async refreshBeforeModelRequest() {
              input.onRuntimeHeaderRefresh?.();
              return { headersApplied: true };
            },
          }
        : undefined,
      sessionStore: input.sessionStore ?? createMemorySessionStore(),
      toolRegistry: input.toolRegistry ?? createToolRegistry(),
    },
  );
}

function createMemorySessionStore(): SessionStorePort {
  const messages = new Map<string, MessageInfo>();
  const parts = new Map<string, MessagePart>();
  let session: SessionInfo | null = null;

  return {
    async createSession(input) {
      const now = Date.now();
      session = {
        ...input,
        taskType: input.taskType ?? "interactive",
        time: {
          created: input.time?.created ?? now,
          updated: input.time?.updated ?? now,
        },
      };
      return session;
    },
    async getSession() {
      return session;
    },
    // 终态结果由 CLI 存储维护；夹具也须更新同一条会话记录。
    async updateSession(input) {
      if (!session || session.id !== input.id) throw new Error("Session not found");
      session = { ...session, ...input, time: { ...session.time, ...input.time } };
      return session;
    },
    async getProjectPermission() {
      return null;
    },
    async messages(input): Promise<MessageWithParts[]> {
      return [...messages.values()]
        .filter((message) => message.sessionID === input.sessionID)
        .map((info) => ({
          info,
          parts: [...parts.values()].filter((part) => part.messageID === info.id),
        }));
    },
    async readTarget() {
      return null;
    },
    async readTodos() {
      return [];
    },
    async saveMessage(input) {
      messages.set(input.id, input);
    },
    async savePart(input) {
      parts.set(input.id, input);
    },
    async setRevert(input) {
      if (!session || session.id !== input.sessionID) return;
      session = {
        ...session,
        revert: input.revert,
        time: { ...session.time, updated: Date.now() },
      };
    },
    async clearRevert(sessionID) {
      if (!session || session.id !== sessionID) return;
      session = {
        ...session,
        revert: undefined,
        time: { ...session.time, updated: Date.now() },
      };
    },
  } as SessionStorePort;
}

function isExtractionRequest(request: ModelRequest): boolean {
  return providerMessagesToText(request.messages).includes(EXTRACTION_PROMPT_MARKER);
}

function textResult(_request: ModelRequest | undefined, text: string): ModelResult {
  return {
    finishReason: "stop",
    model: TEST_MODEL_REF,
    text,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  };
}

function providerMessagesToText(messages: readonly unknown[]): string {
  return messages
    .map((message) => {
      if (!message || typeof message !== "object" || !("content" in message)) return "";
      const content = (message as { content?: unknown }).content;
      if (typeof content === "string") return content;
      if (!Array.isArray(content)) return "";
      return content
        .map((block) =>
          block && typeof block === "object" && "text" in block
            ? String((block as { text?: unknown }).text ?? "")
            : "",
        )
        .join("\n");
    })
    .join("\n");
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function nextTask(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function extractionReadCount(stacks: readonly string[]): number {
  return stacks.filter((stack) => stack.includes("scheduleProjectMemoryExtraction")).length;
}

async function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (!signal || signal.aborted) return;
  await new Promise<void>((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

describe("memory cleanup deadline", () => {
  it("reports an unresolved drain instead of declaring resources released", async () => {
    const pending = Promise.withResolvers<void>();
    const owner = { memoryExtractionScheduler: { drain: () => pending.promise } };
    await expect(drainMemoryExtractions.call(owner as never, 5)).rejects.toThrow(
      "Memory extraction drain timed out",
    );
    pending.resolve();
    await drainMemoryExtractions.call(owner as never, null);
  });
});
