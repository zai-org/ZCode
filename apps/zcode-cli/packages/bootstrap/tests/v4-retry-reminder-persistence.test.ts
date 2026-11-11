import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  createRootTraceContext,
  createSessionId,
  type Model,
  type ModelRequest,
} from "@zcode/contracts";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import { createSqliteSessionStore } from "../../adapters/src/storage/session-store/sqlite-session-store.js";
import type { AgentRuntimeInternal } from "../../core/src/runtime/internal.js";
import { createTestAgentRuntime } from "../../core/tests/test-agent-runtime.js";
import { createTestModelFactory } from "../../core/tests/test-runtime-model.js";
import { createTestSessionEventStore } from "../../core/tests/test-event-store.js";
import type { ZCodeApp } from "../src/app/types.js";
import { V4CommandExecutor } from "../src/zcode-protocol-v4/commands/executor.js";
import type {
  V4CommandCoreHost,
  V4SessionRecordView,
} from "../src/zcode-protocol-v4/commands/types.js";

const PREFIX = "PRESERVED_PREFIX_INPUT";
const INPUT = "ORIGINAL_RETRY_INPUT";
const OLD_REPLY = "REPLACED_ASSISTANT_REPLY";
const genUiContext = [{ path: "/project/page.html", state: "GEN_UI_RETRY_SNAPSHOT" }];

it.each([
  { reminder: "toolsearch", cold: false },
  { reminder: "toolsearch", cold: true },
  { reminder: "todo", cold: false },
  { reminder: "todo", cold: true },
])(
  "retry removes its entire input after $reminder reminders (cold=$cold)",
  async ({ reminder, cold }) => {
    const root = await mkdtemp(join(tmpdir(), "retry-reminder-"));
    const dbPath = join(root, "session.sqlite");
    const sessionId = createSessionId("retry-reminder");
    const requests: ModelRequest[] = [];
    let store = await createSqliteSessionStore({ dbPath });
    let toolSearchEnabled = false;
    let targetRequestCount = 0;
    const base = createTestModelFactory({
      async generateText(request) {
        requests.push(request);
        const isTarget = JSON.stringify(request.messages).includes(INPUT);
        return {
          text: isTarget && targetRequestCount++ === 0 ? OLD_REPLY : "done",
          finishReason: "stop",
          usage: {},
        };
      },
    });
    const wrap = (model: Model): Model => ({
      ...model,
      requestCapabilities: {
        toolSearch: { protocolSupported: true, defaultEnabled: toolSearchEnabled },
      },
      bind: (options) => wrap(model.bind(options)),
    });
    const makeRuntime = () =>
      createTestAgentRuntime(
        sessionId,
        {
          toolSearch: { mode: "auto" },
          modelStreaming: "off",
          titleGeneration: { enabled: false },
          workspacePath: root,
          // TaskOutput 是 deferred 工具，用于触发 ToolSearch 公告；TodoWrite 已常驻，只服务 todo 提醒。
          toolAllowlist: ["ToolSearch", "Read", "TaskOutput", "TodoWrite"],
        },
        {
          sessionStore: store,
          eventStore: createTestSessionEventStore(),
          modelFactory: (input) => wrap(base(input)),
        },
      );
    let runtime = makeRuntime();
    const reopen = async () => {
      await runtime.closeBrowserSession();
      store.close();
      store = await createSqliteSessionStore({ dbPath });
      runtime = makeRuntime();
      await runtime.resumeFromStore();
    };
    try {
      await runtime.executeTurn(PREFIX);
      // 使用真实提醒收集：十轮未使用 TodoWrite 后，下一轮自动保存 Todo reminder。
      if (reminder === "todo") {
        for (let index = 1; index < 10; index++) await runtime.executeTurn(`warmup ${index}`);
      }
      toolSearchEnabled = reminder === "toolsearch";
      const original = await runtime.executeTurn(INPUT, undefined, { intent: { genUiContext } });
      const messages = await store.messages({ sessionID: sessionId });
      const userIndex = messages.findIndex((message) =>
        message.parts.some((part) => part.type === "text" && part.text === INPUT),
      );
      const assistant = messages.at(-1)!;
      expect(userIndex).toBeGreaterThan(0);
      expect(assistant.info.role).toBe("assistant");
      // 真实用户输入还会收集一条 token 预算提醒，排在原有提醒之后；retry 同样整组删除。
      expect(messages.slice(userIndex + 1, -1)).toEqual([
        expect.objectContaining({
          info: expect.objectContaining({
            role: "user",
            synthetic: true,
            semantics: expect.objectContaining({
              kind: reminder === "todo" ? "todo_reminder" : "system_reminder",
            }),
          }),
        }),
        expect.objectContaining({
          info: expect.objectContaining({
            role: "user",
            synthetic: true,
            semantics: expect.objectContaining({ source: "total_tokens_reminder" }),
          }),
        }),
      ]);
      if (cold) await reopen();

      // 只适配 App admission；rewind、持久化、hydrate 和模型请求均走真实 Runtime。
      const sendInput: ZCodeApp["sendInput"] = async (input, options) => {
        const prompt = typeof input === "string" ? { text: input } : input;
        const result = await runtime.executeTurn(prompt.text, prompt.attachments, {
          inputId: options?.inputId,
          intent: options?.intent,
        });
        return { kind: "started_turn", turnId: result.turnId, completion: Promise.resolve(result) };
      };
      const record = {
        app: { sessionId, runtime, sendInput },
        traceContext: createRootTraceContext(),
        workspace: { workspacePath: root },
        persistence: "immediate",
      } as V4SessionRecordView;
      const host: V4CommandCoreHost = {
        getRecord: (id) => (id === sessionId ? record : undefined),
        resolveRowActionTarget: () => ({
          ok: true,
          action: "retryTurn",
          row: {} as never,
          messageId: assistant.info.id,
          editTarget: {
            entityId: messages[userIndex]!.info.id,
            productTurnId: original.turnId,
            transcriptMessageId: messages[userIndex]!.info.id,
            coveredByStableCompact: false,
            intent: { kind: "sendText", text: INPUT, genUiContext },
          },
        }),
      };
      await new V4CommandExecutor(host).execute({
        type: "retryTurn",
        sessionId,
        commandId: "retry-command",
        clientId: "test-client",
        baseRevision: 0,
        baseLogEpoch: "test-epoch",
        payload: { target: { rowId: 1, entityId: assistant.info.id } },
      } as CommandEnvelope);
      const request = JSON.stringify(requests.at(-1)?.messages);
      expect(request.split(INPUT)).toHaveLength(2);
      expect(request.split("GEN_UI_RETRY_SNAPSHOT")).toHaveLength(2);
      expect(request).toContain(PREFIX);
      expect(request).not.toContain(OLD_REPLY);

      // append-only 仍保留旧事实，但新 Runtime 只能恢复重试后的有效分支。
      expect(
        (await store.messages({ sessionID: sessionId })).some(
          (m) => m.info.id === assistant.info.id,
        ),
      ).toBe(true);
      await reopen();
      const history = JSON.stringify(
        (runtime as unknown as AgentRuntimeInternal).messageHistory.toRuntimeEntries(),
      );
      expect(history.split(INPUT)).toHaveLength(2);
      expect(history.split("GEN_UI_RETRY_SNAPSHOT")).toHaveLength(2);
      expect(history).toContain(PREFIX);
      expect(history).not.toContain(OLD_REPLY);
    } finally {
      await runtime.closeBrowserSession();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
