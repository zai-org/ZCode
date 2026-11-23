import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createProjectId,
  createSessionId,
  type Model,
  type ModelRequest,
  type ModelResult,
} from "@zcode/contracts";
import { createSqliteSessionStore } from "../../adapters/src/storage/session-store/sqlite-session-store.js";
import { createInMemoryHookRunner } from "../src/hooks/index.js";
import type { HookCallback } from "../src/hooks/types.js";
import { createToolRegistry } from "../src/tool/registry.js";
import type { ToolEntry } from "../src/tool/types.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

type Message = ModelRequest["messages"][number];

const pre = (tool: string, cmd: string) => `PreToolUse:${tool} hook additional context: PRE ${cmd}`;
const post = (cmd: string) => `PostToolUse:Echo hook additional context: POST ${cmd}\nL2`;
const failure = (cmd: string) => `PostToolUseFailure:Fail hook additional context: FAIL ${cmd}`;
const wrap = (text: string) => `<system-reminder>\n${text}\n</system-reminder>`;

// 每批 tool result 及其后的附件：从带工具调用的 assistant 之后，到下一条 assistant 之前。
function batchTails(request: ModelRequest): Array<Array<Pick<Message, "role" | "content">>> {
  const tails: Array<Array<Pick<Message, "role" | "content">>> = [];
  let current: Array<Pick<Message, "role" | "content">> | undefined;
  for (const message of request.messages) {
    if (message.role === "assistant") {
      current = (message.toolCalls?.length ?? 0) > 0 ? [] : undefined;
      if (current) tails.push(current);
      continue;
    }
    current?.push({ role: message.role, content: message.content });
  }
  return tails;
}

describe.each([true, false])("tool hook context after the tool batch (MCS=%s)", (mcs) => {
  it("keeps raw tool results and sends one context per hook after the batch, live and after resume", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-tool-hook-context-"));
    const dbPath = join(root, "session.sqlite");
    const sessionId = createSessionId(`tool-hook-context-${mcs}`);
    let store = await createSqliteSessionStore({ dbPath });
    const requests: ModelRequest[] = [];
    const script: ModelResult[] = [
      toolCalls([
        ["echo-a", "Echo", "a"],
        ["echo-b", "Echo", "b"],
      ]),
      toolCalls([["fail-c", "Fail", "c"]]),
      toolCalls([["blocked-d", "Blocked", "d"]]),
      { text: "done", finishReason: "stop", usage: {} },
      { text: "resumed", finishReason: "stop", usage: {} },
    ];
    const respond = async (request: ModelRequest): Promise<ModelResult> => {
      requests.push(structuredClone(request));
      return script[requests.length - 1]!;
    };
    const baseFactory = createTestModelFactory({
      generateText: respond,
      properties: { supportsMidConversationSystem: mcs },
    });
    // Anthropic Messages 协议的请求能力：user 侧提醒并入最后一个 tool result。
    const withMessagesProtocol = (model: Model): Model => ({
      ...model,
      requestCapabilities: { foldRemindersIntoToolResults: true },
      bind: (options) => withMessagesProtocol(model.bind(options)),
    });
    const cmdOf = (input: unknown) => String((input as { cmd?: unknown }).cmd);
    const contextHook =
      (prefix: string): HookCallback =>
      async (input) => {
        const toolInput = "toolInput" in input ? input.toolInput : undefined;
        const toolName = "toolName" in input ? input.toolName : undefined;
        return {
          hookSpecificOutput: {
            hookEventName: input.hookEventName,
            additionalContext: `${prefix} ${cmdOf(toolInput)}${prefix === "POST" ? "\nL2" : ""}`,
            ...(prefix === "PRE" && toolName === "Blocked"
              ? { permissionDecision: "deny", permissionDecisionReason: "blocked by test hook" }
              : {}),
          },
        };
      };
    const hookRunner = createInMemoryHookRunner({
      hooks: [
        { event: "PreToolUse", callback: contextHook("PRE") },
        { event: "PostToolUse", callback: contextHook("POST") },
        { event: "PostToolUseFailure", callback: contextHook("FAIL") },
      ],
    });
    const makeRuntime = () => {
      const registry = createToolRegistry();
      registry.register(testTool("Echo", async (input) => `out:${cmdOf(input)}`));
      registry.register(
        testTool("Fail", async (input) => {
          throw new Error(`failed ${cmdOf(input)}`);
        }),
      );
      registry.register(testTool("Blocked", async () => "never runs"));
      return createTestAgentRuntime(
        sessionId,
        {
          mode: "yolo",
          titleGeneration: { enabled: false },
          workingDirectory: root,
          workspacePath: root,
        },
        {
          eventStore: createTestSessionEventStore(),
          hookRunner,
          modelFactory: (input) => withMessagesProtocol(baseFactory(input)),
          sessionStore: store,
          toolRegistry: registry,
        },
      );
    };
    let runtime: ReturnType<typeof makeRuntime> | undefined;
    try {
      await store.createSession({
        id: sessionId,
        projectID: createProjectId("tool-hook-context"),
        slug: "tool-hook-context",
        title: "Tool hook context",
        directory: root,
        version: "test",
        time: { created: 1, updated: 1 },
      });
      runtime = makeRuntime();
      await runtime.executeTurn("run the tools");
      expect(requests).toHaveLength(4);

      const parallelContexts = [pre("Echo", "a"), post("a"), pre("Echo", "b"), post("b")];
      const failedContexts = [pre("Fail", "c"), failure("c")];
      const deniedContexts = [pre("Blocked", "d")];
      // tool_result 只放工具原文。MCS：这批结果之后一条 system，按工具分组，附件之间空一行；
      // 非 MCS：每条一个 system-reminder，并入这批最后一个 tool result。
      const batch = (results: string[], contexts: string[]) =>
        mcs
          ? [
              ...results.map((content) => ({ role: "tool", content })),
              { role: "system", content: contexts.join("\n\n") },
            ]
          : results.map((content, index) => ({
              role: "tool",
              content:
                index === results.length - 1
                  ? [content, ...contexts.map(wrap)].join("\n\n")
                  : content,
            }));
      const expected = [
        batch(["out:a", "out:b"], parallelContexts),
        batch(["failed c"], failedContexts),
        batch(["blocked by test hook"], deniedContexts),
      ];
      expect(batchTails(requests[1]!)).toEqual(expected.slice(0, 1));
      expect(batchTails(requests[2]!)).toEqual(expected.slice(0, 2));
      expect(batchTails(requests[3]!)).toEqual(expected);

      await runtime.closeBrowserSession();
      runtime = undefined;
      store.close();
      store = await createSqliteSessionStore({ dbPath });
      runtime = makeRuntime();
      await runtime.resumeFromStore();
      await runtime.executeTurn("continue after resume");
      expect(requests).toHaveLength(5);
      // 附件随历史持久化：冷恢复后的请求里位置与内容不变。
      expect(batchTails(requests[4]!)).toEqual(expected);
    } finally {
      await runtime?.closeBrowserSession();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

function toolCalls(calls: Array<[string, string, string]>): ModelResult {
  return {
    text: "",
    finishReason: "tool-calls",
    usage: {},
    toolCalls: calls.map(([id, name, cmd]) => ({ id, name, input: { cmd } })),
  };
}

function testTool(name: string, handler: ToolEntry["handler"]): ToolEntry {
  return {
    metadata: {
      name,
      description: `${name} test tool`,
      readOnly: true,
      destructive: false,
      concurrentSafe: true,
      sideEffectScope: "none",
    },
    inputSchema: {
      type: "object",
      properties: { cmd: { type: "string" } },
      required: ["cmd"],
      additionalProperties: false,
    },
    outputSchema: { type: "string" },
    handler,
  } as ToolEntry;
}
