import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { z } from "zod";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import { isTranscriptVisibleMessage } from "../../src/active-transcript/index.js";
import {
  LOCAL_TOOL_SEARCH_NAME,
  createMessageId,
  createPartId,
  createProjectId,
  type SessionId,
} from "@zcode/contracts";
import {
  createSessionResultSchema,
  forkSessionResultSchema,
  listSessionsResultSchema,
  mutationResultSchema,
  readSessionResultSchema,
  sendToSessionResultSchema,
  waitSessionsResultSchema,
} from "@zcode/session-control/contracts";

const providerModule = new URL(
  "../../../../e2e/compact-microcompact/scripted-provider.mjs",
  import.meta.url,
);
const { startScriptedProvider, stopScriptedProvider, writeScriptedCaptureFile } = await import(
  providerModule.href
);
const cliEntry = fileURLToPath(new URL("../../../cli/src/main.ts", import.meta.url));
const tsxLoader = fileURLToPath(import.meta.resolve("tsx"));
const MODEL = "session-control-fixture";
const ACTOR = "SCT_ACTOR: exercise the standalone session tools";
const FIRST = "SCT_FIRST: preserve this stable boundary";
const SECOND = "SCT_SECOND: exactly one queued input";
const LONG = "SCT_LONG: remain active until interrupted";
const TITLE = "SCT 独立会话";
const DONE = "SCT_ALL_TOOLS_VERIFIED";
// 预置在另一个 workspace 的历史会话：验证独立 CLI 读本机会话库、但不能写。
const HISTORY_ID = "sess_00000000-0000-4000-8000-00000000a11c";
const HISTORY_TITLE = "SCT 其他目录历史";
const HISTORY_TEXT = "SCT_HISTORY: written by another process";
const OUTPUTS = {
  ListSessions: listSessionsResultSchema,
  ReadSession: readSessionResultSchema,
  CreateSession: createSessionResultSchema,
  ForkSession: forkSessionResultSchema,
  SendToSession: sendToSessionResultSchema,
  WaitSessions: waitSessionsResultSchema,
  InterruptSession: mutationResultSchema,
  RenameSession: mutationResultSchema,
};
const TOOLS = Object.keys(OUTPUTS);
type Step = { name: string; input: Record<string, unknown> };
type Output<K extends keyof typeof OUTPUTS> = z.output<(typeof OUTPUTS)[K]>;
const requestSchema = z.object({
  stream: z.boolean().optional(),
  messages: z.array(
    z.object({ role: z.string(), content: z.unknown(), tool_call_id: z.string().optional() }),
  ),
  tools: z.array(z.object({ function: z.object({ name: z.string() }) })).optional(),
});
type Request = z.infer<typeof requestSchema>;

function* invokeRaw(name: string, input: Step["input"]): Generator<Step, string, string> {
  return yield { name, input };
}

function* invoke<K extends keyof typeof OUTPUTS>(
  name: K,
  input: Step["input"],
): Generator<Step, Output<K>, string> {
  const raw = yield { name, input };
  return OUTPUTS[name].parse(JSON.parse(raw)) as Output<K>;
}

// SCT01/02/04/05/06：真实 CLI main → LocalToolSearch/DeferredToolCall → executor → owner → SQLite。
// 模型只编排请求；引用、分页边界、operation 和 executionId 必须取自真实 tool_result。
it("runs all eight session tools in a standalone CLI process and reopens its SQLite history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-session-control-e2e-"));
  const workspace = join(directory, "workspace");
  const database = join(directory, "sessions.sqlite");
  const configDirectory = join(directory, ".zcode", "cli");
  await Promise.all([mkdir(workspace), mkdir(configDirectory, { recursive: true })]);
  const firstStarted = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const longStarted = Promise.withResolvers<void>();
  const releaseLong = Promise.withResolvers<void>();
  const received = new Map<string, string>();
  const targetRequests: string[] = [];
  let created: Output<"CreateSession"> | undefined;
  let forked: Output<"ForkSession"> | undefined;
  let completed = false;
  let passed = false;
  let providerError: unknown;

  async function* scenario(): AsyncGenerator<Step, void, string> {
    const discovery = yield {
      name: LOCAL_TOOL_SEARCH_NAME,
      input: { query: `select:${TOOLS.join(",")}` },
    };
    for (const name of TOOLS) assert.ok(discovery.includes(name), `missing schema: ${name}`);
    // 独立 CLI 只注册共有 8 个；App 独有工具不出现。
    for (const appOnly of ["ListProjects", "OpenSession", "SetSessionPinned"])
      assert.ok(!discovery.includes(`"${appOnly}"`), `unexpected App tool: ${appOnly}`);
    const roots = yield* invoke("ListSessions", {});
    // 读本机会话库：调用者根与预置的其他 workspace 历史都列出；历史只宣称可读。
    assert.equal(roots.sessions.length, 2);
    const history = roots.sessions.find((item) => item.session.sessionId === HISTORY_ID)!;
    assert.equal(history.title, HISTORY_TITLE);
    assert.deepEqual(history.availableActions, ["readSession"]);
    const historyRead = yield* invoke("ReadSession", { sessionId: HISTORY_ID, view: "messages" });
    assert.ok(historyRead.view === "messages");
    assert.deepEqual(
      historyRead.messages.map((item) => [item.role, item.text]),
      [["user", HISTORY_TEXT]],
    );
    const caller = roots.sessions.find((item) => item.session.sessionId !== HISTORY_ID)!.session;
    assert.equal(caller.kind, "cli");
    assert.ok(caller.kind === "cli");
    // macOS /var 临时目录会被 cwd 解析成 /private/var；使用 owner 返回的真实 workspace 身份。
    const createInput = { prompt: FIRST };
    created = yield* invoke("CreateSession", createInput);
    assert.equal(created.creation, "created");
    assert.equal(created.firstInput, "accepted");
    assert.equal(created.delivery, "start_now");
    assert.ok(created.session && created.operation);
    assert.equal(created.session.kind, "cli");
    // 规格 0.14：requestId 不再由模型给出，重试要回放回执里的那个 id。
    assert.deepEqual(
      yield* invoke("CreateSession", { ...createInput, retryOf: created.requestId }),
      created,
    );
    await firstStarted.promise;
    const first = yield* invoke("ReadSession", {
      sessionId: created.session.sessionId,
      view: "summary",
    });
    assert.ok(first.view === "summary");
    assert.equal(first.summary.status, "running");
    const firstExecutionId = first.summary.executionId;
    assert.ok(firstExecutionId);
    const observing = yield* invoke("WaitSessions", {
      operations: [
        { sessionId: created.operation.session.sessionId, commandId: created.operation.commandId },
      ],
      mode: "all",
      timeoutMs: 0,
    });
    assert.equal(observing.status, "timed_out");
    assert.equal(observing.operations[0]!.status, "running");
    assert.deepEqual(observing.operations[0]!.operation, created.operation);
    const sendInput = { sessionId: created.session.sessionId, prompt: SECOND };
    const sent = yield* invoke("SendToSession", sendInput);
    assert.equal(sent.admission, "accepted");
    assert.equal(sent.delivery, "queued");
    assert.deepEqual(
      yield* invoke("SendToSession", { ...sendInput, retryOf: sent.requestId }),
      sent,
    );
    // 超时只释放观察；原 owner 继续运行目标并排队接纳下一条输入。
    assert.deepEqual(targetRequests, [FIRST]);
    releaseFirst.resolve();
    const waited = yield* invoke("WaitSessions", {
      operations: [
        { sessionId: created.operation.session.sessionId, commandId: created.operation.commandId },
        { sessionId: sent.operation.session.sessionId, commandId: sent.operation.commandId },
      ],
      mode: "all",
    });
    assert.equal(waited.status, "completed");
    assert.deepEqual(
      waited.operations.map((item) => item.operation),
      [created.operation, sent.operation],
    );
    assert.deepEqual(
      waited.operations.map((item) => item.status),
      ["completed", "completed"],
    );
    const page = yield* invoke("ReadSession", {
      sessionId: created.session.sessionId,
      view: "messages",
      limit: 1,
    });
    assert.ok(page.view === "messages");
    assert.deepEqual(
      page.messages.map((item) => [item.role, item.text]),
      [["user", FIRST]],
    );
    assert.ok(page.nextCursor);
    const rest = yield* invoke("ReadSession", {
      sessionId: created.session.sessionId,
      view: "messages",
      cursor: page.nextCursor,
    });
    assert.ok(rest.view === "messages");
    assert.deepEqual(
      rest.messages.map((item) => [item.role, item.text]),
      [
        ["assistant", "SCT_FIRST_DONE"],
        ["user", SECOND],
        ["assistant", "SCT_SECOND_DONE"],
      ],
    );
    forked = yield* invoke("ForkSession", {
      sessionId: created.session.sessionId,
      atMessage: rest.messages[0]!.id,
    });
    assert.equal(forked.status, "created");
    assert.ok(forked.session);
    assert.notEqual(forked.session.sessionId, created.session.sessionId);
    const forkHistory = yield* invoke("ReadSession", {
      sessionId: forked.session.sessionId,
      view: "messages",
    });
    assert.ok(forkHistory.view === "messages");
    assert.deepEqual(
      forkHistory.messages.map((item) => [item.role, item.text]),
      [
        ["user", FIRST],
        ["assistant", "SCT_FIRST_DONE"],
        // stable fork 另存 assistant timeline 标记，它没有正文；不能把它算作模型执行。
        ["assistant", ""],
      ],
    );
    assert.equal(
      (yield* invoke("RenameSession", {
        sessionId: created.session.sessionId,
        title: TITLE,
      })).status,
      "applied",
    );
    // 规格 0.14：workspace 过滤器已删除（发现链循环）；标题子串匹配仍只返回这一条。
    const listed = yield* invoke("ListSessions", { query: TITLE });
    assert.equal(listed.sessions.length, 1);
    assert.deepEqual(listed.sessions[0]!.session, created.session);
    assert.equal(listed.sessions[0]!.title, TITLE);
    const historyWrite = yield* invokeRaw("SendToSession", {
      sessionId: HISTORY_ID,
      prompt: "must not restore history",
    });
    // 读范围不扩大写权限：其他 workspace 的历史在写授权前就被拒绝，不会恢复它。
    assert.match(historyWrite, /outside the trusted scope/);
    const long = yield* invoke("SendToSession", {
      sessionId: created.session.sessionId,
      prompt: LONG,
    });
    assert.equal(long.admission, "accepted");
    assert.equal(long.delivery, "start_now");
    await longStarted.promise;
    const active = yield* invoke("ReadSession", {
      sessionId: created.session.sessionId,
      view: "summary",
    });
    assert.ok(active.view === "summary");
    assert.equal(active.summary.status, "running");
    assert.ok(active.summary.executionId);
    assert.notEqual(active.summary.executionId, firstExecutionId);
    assert.equal(
      (yield* invoke("InterruptSession", {
        sessionId: created.session.sessionId,
        expectedExecutionId: firstExecutionId,
      })).status,
      "rejected",
    );
    const stillRunning = yield* invoke("WaitSessions", {
      operations: [
        { sessionId: long.operation.session.sessionId, commandId: long.operation.commandId },
      ],
      mode: "any",
      timeoutMs: 0,
    });
    assert.equal(stillRunning.status, "timed_out");
    assert.equal(stillRunning.operations[0]!.status, "running");
    assert.equal(stillRunning.operations[0]!.executionId, active.summary.executionId);
    assert.equal(
      (yield* invoke("InterruptSession", {
        sessionId: created.session.sessionId,
        expectedExecutionId: active.summary.executionId,
      })).status,
      "applied",
    );
    const interrupted = yield* invoke("WaitSessions", {
      operations: [
        { sessionId: long.operation.session.sessionId, commandId: long.operation.commandId },
      ],
      mode: "all",
    });
    assert.equal(interrupted.status, "completed");
    assert.equal(interrupted.operations[0]!.status, "interrupted");
    assert.deepEqual(interrupted.operations[0]!.operation, long.operation);
    completed = true;
  }

  const plan = scenario();
  let step = 0;
  const provider = await startScriptedProvider({
    name: "session-control-e2e",
    handler: async ({ body }: { body: unknown }) => {
      try {
        const request = requestSchema.parse(body);
        const text = request.messages
          .filter((message) => message.role === "user")
          .map((message) => JSON.stringify(message.content))
          .join("\n");
        // 标题 sidecar 也只访问本地 provider，不推进业务场景。
        if (!request.tools?.length) return response(request, "SCT fixture title");
        if (text.includes(ACTOR)) {
          const names = request.tools.map((tool) => tool.function.name);
          assert.ok(names.includes(LOCAL_TOOL_SEARCH_NAME) && names.includes("DeferredToolCall"));
          // 会话工具 deferred：只经 ToolSearch / DeferredToolCall 调用，不进入首屏工具表。
          assert.equal(
            names.some((name) => TOOLS.includes(name)),
            false,
          );
          let result = "";
          if (step > 0) {
            const toolResult = request.messages.find(
              (message) => message.role === "tool" && message.tool_call_id === `sct-${step}`,
            );
            assert.ok(toolResult, `missing tool_result for step ${step}`);
            result = z.string().parse(toolResult.content);
            received.set(`sct-${step}`, result);
          }
          const current = await plan.next(result);
          if (current.done) return response(request, DONE);
          step += 1;
          const call =
            current.value.name === LOCAL_TOOL_SEARCH_NAME
              ? current.value
              : { name: "DeferredToolCall", input: current.value };
          return response(request, call, `sct-${step}`);
        }
        if (text.includes(LONG)) {
          targetRequests.push(LONG);
          longStarted.resolve();
          await releaseLong.promise;
          return response(request, "must be interrupted");
        }
        if (text.includes(SECOND)) {
          targetRequests.push(SECOND);
          return response(request, "SCT_SECOND_DONE");
        }
        assert.ok(text.includes(FIRST), `unexpected provider request: ${text}`);
        targetRequests.push(FIRST);
        firstStarted.resolve();
        await releaseFirst.promise;
        return response(request, "SCT_FIRST_DONE");
      } catch (error) {
        providerError ??= error;
        // fixture 断言失败属于本轮失败，返回不可重试响应以保留首个证据。
        return { status: 400, body: { error: { message: String(error) } } };
      }
    },
  });
  let stdout = "";
  let stderr = "";
  let child: ReturnType<typeof spawn> | undefined;
  let exited: Promise<[number | null, NodeJS.Signals | null]> | undefined;
  const errors: unknown[] = [];
  try {
    await writeConfig(directory, provider.baseURL);
    // 另一个进程在另一个 workspace 留下的历史：只写持久层，不由本次 CLI 托管。
    const seeded = await createSqliteSessionStore({ dbPath: database });
    try {
      const historyId = HISTORY_ID as SessionId;
      const messageId = createMessageId("sct-history-user");
      await seeded.createSession({
        id: historyId,
        projectID: createProjectId("sct-history"),
        directory: join(directory, "other-workspace"),
        slug: "sct-history",
        title: HISTORY_TITLE,
        version: "test",
      });
      await seeded.saveMessage({
        id: messageId,
        sessionID: historyId,
        role: "user",
        agent: "zcode-agent",
        time: { created: 1 },
      } as never);
      await seeded.savePart({
        id: createPartId("sct-history-text"),
        messageID: messageId,
        sessionID: historyId,
        type: "text",
        text: HISTORY_TEXT,
      } as never);
    } finally {
      seeded.close();
    }
    // 直接启动生产 main；合法 --mode 参数只授权 actor，目标独立 build 权限由 owner 维护。
    child = spawn(
      process.execPath,
      [
        "--disable-warning=DEP0205",
        "--import",
        tsxLoader,
        cliEntry,
        "-p",
        ACTOR,
        "--mode",
        "yolo",
        "--toolsearch-mode",
        "local",
        "--output-format",
        "stream-json",
      ],
      {
        cwd: workspace,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          HOME: directory,
          USERPROFILE: directory,
          APPDATA: directory,
          LOCALAPPDATA: directory,
          ZCODE_ENV: "test",
          ZCODE_DATA_BASE_DIR: directory,
          ZCODE_STORAGE_DIR: join(directory, "storage"),
          ZCODE_SESSION_DB_PATH: database,
          ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: join(directory, "builtin.json"),
          ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: join(directory, "personal.json"),
          ZCODE_MODEL_TELEMETRY_ENABLED: "false",
        },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 75_000,
        killSignal: "SIGKILL",
      },
    );
    child.stdout!.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr!.on("data", (chunk) => {
      stderr += chunk;
    });
    exited = once(child, "close") as Promise<[number | null, NodeJS.Signals | null]>;
    const [code, signal] = await exited;
    if (providerError) throw providerError;
    assert.deepEqual({ code, signal }, { code: 0, signal: null }, stderr);
    assert.ok(completed, `scenario stopped at ${step}`);
    assert.match(stdout, new RegExp(DONE));
    assert.deepEqual(targetRequests, [FIRST, SECOND, LONG]);
    assert.equal(received.size, step);
    assert.equal((await readFile(database)).subarray(0, 16).toString(), "SQLite format 3\0");
    assert.ok(created?.session && forked?.session);
    const store = await createSqliteSessionStore({ dbPath: database });
    try {
      const roots = await store.listSessions();
      assert.equal(roots.length, 4, "create retry must not add a root");
      const history = await store.messages({ sessionID: HISTORY_ID as SessionId });
      assert.equal(history.length, 1, "reading history must not restore or write it");
      const target = await store.getSession(created.session.sessionId as SessionId);
      assert.equal(target?.title, TITLE);
      assert.equal(target?.lastOutcome, "interrupted");
      assert.equal(target?.parentID, undefined);
      const messages = await store.messages({
        sessionID: created.session.sessionId as SessionId,
      });
      // staging 起运行时提醒与中断标记也以隐藏 user 消息落库；只比较界面可见的真实输入。
      assert.deepEqual(
        messages
          .filter((message) => message.info.role === "user" && isTranscriptVisibleMessage(message))
          .map((message) =>
            message.parts
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n"),
          ),
        [FIRST, SECOND, LONG],
      );
      assert.ok(
        messages
          .filter((message) => message.info.role === "assistant")
          .every((message) => message.info.role === "assistant" && message.info.mode === "build"),
      );
      const fork = await store.messages({ sessionID: forked.session.sessionId as SessionId });
      assert.deepEqual(
        fork
          .filter(
            (message) =>
              !(message.info.role === "user" && message.info.visibility === "model-only"),
          )
          .flatMap((message) =>
            message.parts.filter((part) => part.type === "text").map((part) => part.text),
          ),
        [FIRST, "SCT_FIRST_DONE"],
      );
      const actor = roots.find(
        (root) =>
          root.id !== created!.session!.sessionId &&
          root.id !== forked!.session!.sessionId &&
          root.id !== HISTORY_ID,
      )!;
      const executed = (await store.messages({ sessionID: actor.id }))
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "tool" && TOOLS.includes(part.tool));
      assert.equal(executed.length, step - 1);
      assert.deepEqual(
        [...new Set(executed.map((part) => part.type === "tool" && part.tool))].sort(),
        [...TOOLS].sort(),
      );
      // 唯一预期失败的调用是写入未托管的历史会话；其余调用都必须成功完成。
      const failed = executed.filter(
        (part) => part.type === "tool" && part.state.status !== "completed",
      );
      assert.equal(failed.length, 1);
      assert.ok(failed[0]?.type === "tool" && failed[0].tool === "SendToSession");
    } finally {
      try {
        store.close();
      } catch (error) {
        errors.push(error);
      }
    }
    passed = errors.length === 0;
  } catch (error) {
    // 清理和证据写入失败不能覆盖最先发生的场景断言，原错误始终排在第一位。
    errors.unshift(error);
  } finally {
    releaseFirst.resolve();
    releaseLong.resolve();
    for (const cleanup of [
      async () => {
        if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await exited;
      },
      async () => {
        provider.server.closeAllConnections();
        await stopScriptedProvider(provider);
      },
      async () => {
        if (passed && errors.length === 0) {
          await rm(directory, { recursive: true, force: true, maxRetries: 3 });
        } else {
          process.stderr.write(`CLI session-control evidence: ${directory}\n`);
          const writes = await Promise.allSettled([
            writeFile(join(directory, "stdout.jsonl"), stdout),
            writeFile(join(directory, "stderr.txt"), stderr),
            writeScriptedCaptureFile(provider, join(directory, "provider-capture.json")),
          ]);
          for (const write of writes) if (write.status === "rejected") errors.push(write.reason);
        }
      },
    ]) {
      try {
        await cleanup();
      } catch (error) {
        if (!errors.includes(error)) errors.push(error);
      }
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, `CLI session-control E2E failed: ${String(errors[0])}`, {
      cause: errors[0],
    });
  }
}, 90_000);

async function writeConfig(directory: string, baseUrl: string) {
  await Promise.all([
    writeFile(
      join(directory, "builtin.json"),
      JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        config: {
          providerConfigRules: { templateRules: [], providerRules: [] },
          modelConfigRules: {
            modelRules: [
              {
                modelMatch: ".*",
                config: {
                  enabled: true,
                  properties: {
                    contextWindow: 1_000_000,
                    requiresMfjsToolSchema: false,
                    inputFormat: {
                      supportsText: true,
                      supportsImage: false,
                      supportsVideo: false,
                      supportsAudio: false,
                      supportsPdf: false,
                    },
                    outputFormat: { supportsText: true },
                    supportsToolCall: true,
                    supportsJsonSchemaOutput: false,
                    supportsNativeWebSearch: false,
                    supportsMidConversationSystem: false,
                  },
                  optionSpecs: {
                    reasoningLevel: { values: ["disabled"], map: "{}" },
                    maxOutputTokens: { max: 8192, map: "{'max_tokens': maxOutputTokens}" },
                  },
                },
              },
            ],
            modelApiRules: [],
            providerSiteRules: [],
            templateModelRules: [],
            builtinProviderModelRules: [],
          },
        },
      }),
    ),
    writeFile(
      join(directory, "personal.json"),
      JSON.stringify({
        schemaVersion: 1,
        config: {
          providerConfigRules: {
            providerRules: [
              {
                providerId: "fixture",
                config: {
                  group: "standard-personal",
                  personalModelIds: [MODEL],
                  access: { type: "api-key", apiKey: "local-fixture-key" },
                  api: { type: "openai-chat-completions", baseUrl },
                },
              },
            ],
          },
          modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
          defaultModelSelection: { providerId: "fixture", modelId: MODEL },
        },
      }),
    ),
    writeFile(
      join(directory, ".zcode", "cli", "config.json"),
      JSON.stringify({
        features: { memory: false, mcp: false, subagent: false, skill: false },
        plugins: { enabled: false },
        skills: { enabled: false },
      }),
    ),
  ]);
}

function response(request: Request, value: string | Step, id = "fixture") {
  const tool = typeof value !== "string";
  const message = tool
    ? {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id,
            type: "function",
            function: { name: value.name, arguments: JSON.stringify(value.input) },
          },
        ],
      }
    : { role: "assistant", content: value };
  const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 };
  if (!request.stream)
    return {
      body: {
        id,
        object: "chat.completion",
        model: MODEL,
        created: 1,
        choices: [{ index: 0, message, finish_reason: tool ? "tool_calls" : "stop" }],
        usage,
      },
    };
  const delta = tool ? { tool_calls: [{ index: 0, ...message.tool_calls![0] }] } : message;
  const frame = (choices: unknown[], extra = {}) =>
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: MODEL, created: 1, choices, ...extra })}\n\n`;
  return {
    headers: { "content-type": "text/event-stream" },
    bodyText:
      frame([{ index: 0, delta, finish_reason: null }]) +
      frame([{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }]) +
      frame([], { usage }) +
      "data: [DONE]\n\n",
  };
}
