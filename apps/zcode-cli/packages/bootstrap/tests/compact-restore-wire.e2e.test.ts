// compaction 之后补回的内容走真实 runtime、真实 Read / Bash / Agent 与 `anthropic-messages` wire：
// 摘要文本的选取与摘要回复里的工具调用（compact/README.md「摘要文本的选取」）、文件补回在 user 侧、
// 后台任务状态（rewind-compact.md「Compact 之后的上下文布局」的文件恢复与后台任务状态）。每个场景都在新 app 里冷恢复，
// 检查已发出的消息逐字节回放。
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import { createSessionId } from "@zcode/contracts";
import {
  ApiKeyAccessConfig,
  ModelConfig,
  ModelOptionSpecsConfig,
  ModelPropertiesConfig,
  ProviderApiConfig,
  ProviderConfig,
  ProviderRegistry,
} from "@zcode/provider";
import { createZCodeApp } from "../src/app/create-app.js";
import { createRuntimeAiSdkModelExecutionConfig } from "../src/model-config.js";
import { createModelAdapter } from "../src/model-factory.js";

const PROVIDER_ID = "compact-wire";
const MODEL_ID = "compact-wire-model";
const SUMMARY_SENTINEL = "CRITICAL: Respond with TEXT ONLY";

type Block = Record<string, unknown> & { type?: string };
type WireMessage = { role: string; content: string | Block[] };
type WireBody = {
  system?: Block[];
  messages: WireMessage[];
  tools?: Array<{ name: string }>;
  stream?: boolean;
};
type Reply = { content: Block[]; stop: "tool_use" | "end_turn" };
type App = Awaited<ReturnType<typeof createZCodeApp>>;

interface Fixture {
  root: string;
  workspace: string;
  bodies: WireBody[];
  /** 按请求内容给出回复；返回 undefined 时回复一段文字。可以返回 Promise，用来扣住子代理。 */
  respond: (body: WireBody) => Reply | undefined | Promise<Reply | undefined>;
  /** 打开一个 app，执行 action 后关闭；resume 时从同一个存档冷恢复。 */
  withApp(action: (app: App) => Promise<void>, options?: { resume?: boolean }): Promise<void>;
  waitForRequest(predicate: (body: WireBody) => boolean): Promise<WireBody>;
  close(): Promise<void>;
}

let fixture: Fixture | undefined;
let previousStorageDir: string | undefined;

beforeEach(() => {
  previousStorageDir = process.env.ZCODE_STORAGE_DIR;
});

afterEach(async () => {
  if (previousStorageDir === undefined) delete process.env.ZCODE_STORAGE_DIR;
  else process.env.ZCODE_STORAGE_DIR = previousStorageDir;
  if (fixture) {
    await fixture.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
  fixture = undefined;
});

describe.skipIf(process.platform === "win32")("compaction restore over the wire", () => {
  it.each([true, false])(
    "keeps the chosen summary block, restores the read file on the user side and restates the running shell (MCS %s)",
    { timeout: 60_000 },
    async (mcs) => {
      const f = await createFixture({ mcs });
      const notes = join(f.workspace, "notes.txt");
      await writeFile(notes, "WIRE_FILE_LINE\n");
      let mainCalls = 0;
      f.respond = (body) => {
        // 摘要回复：多个文本块，最后还调用了工具。只留最后一个带 <summary> 的块，工具不执行。
        if (isSummaryRequest(body)) {
          return {
            content: [
              { type: "text", text: "<summary>WIRE_SUMMARY_DROPPED</summary>" },
              { type: "text", text: "<analysis>a</analysis><summary>WIRE_SUMMARY_KEPT</summary>" },
              { type: "text", text: "WIRE_SUMMARY_TRAILING" },
              {
                type: "tool_use",
                id: "toolu_summary_read",
                name: "Read",
                input: { file_path: notes },
              },
            ],
            stop: "tool_use",
          };
        }
        mainCalls += 1;
        if (mainCalls === 1) return toolCall("toolu_read", "Read", { file_path: notes });
        if (mainCalls === 2) {
          return toolCall("toolu_bg", "Bash", {
            command: "sleep 30",
            description: "wire sleep",
            run_in_background: true,
          });
        }
        return undefined;
      };
      await f.withApp(async (app) => {
        await app.submitPrompt("read the notes");
        await app.submitPrompt("/compact");
        await app.submitPrompt("after compact");
      });

      expect(f.bodies.filter(isSummaryRequest)).toHaveLength(1);
      expect(JSON.stringify(f.bodies)).not.toContain('"tool_use_id":"toolu_summary_read"');
      const live = f.bodies.find((body) => lastUserText(body) === "after compact")!;
      const liveText = JSON.stringify(live.messages);
      expect(liveText).toContain("Summary:\\nWIRE_SUMMARY_KEPT");
      expect(liveText).not.toContain("WIRE_SUMMARY_DROPPED");
      expect(liveText).not.toContain("WIRE_SUMMARY_TRAILING");

      // 文件补回是两条 user 侧提醒，紧挨着；MCS 开时也不进 system。
      const userTexts = textBlocks(live, "user");
      const called = userTexts.indexOf(
        `<system-reminder>\nCalled the Read tool with the following input: ${JSON.stringify({ file_path: notes })}\n</system-reminder>\n`,
      );
      expect(called).toBeGreaterThan(-1);
      expect(userTexts[called + 1]).toBe(
        `<system-reminder>\nResult of calling the Read tool:\n1\tWIRE_FILE_LINE\n2\t\n</system-reminder>${mcs ? "\n" : ""}`,
      );
      expect(JSON.stringify([live.system, textBlocks(live, "system")])).not.toContain(
        "Result of calling the Read tool",
      );

      // 后台命令的 ID 与输出路径取自压缩前的启动结果；命令原文来自登记时的输入。
      const launched = toolResultText(
        f.bodies.find((body) => hasToolResult(body, "toolu_bg"))!,
        "toolu_bg",
      ).match(
        /^Command running in background with ID: (\S+)\. Output is being written to: (\S+)\./,
      )!;
      const shellText = `Background shell ${launched[1]} ("wire sleep") is still running (command, shown on one line: \`sleep 30\`). Do not start it again; to restart it, stop it with TaskStop first. You can read its output at ${launched[2]}.`;
      if (mcs) {
        expect(textBlocks(live, "system").filter((text) => text.includes(shellText))).toHaveLength(
          1,
        );
      } else {
        // MCS 关时是 user 侧提醒，排在文件补回之后。
        expect(userTexts.indexOf(`<system-reminder>\n${shellText}\n</system-reminder>`)).toBe(
          called + 2,
        );
      }

      await f.withApp(
        async (app) => {
          await app.submitPrompt("after resume");
        },
        { resume: true },
      );
      expectColdReplay(live, f.bodies.at(-1)!);
    },
  );

  it(
    "restates a running agent, delivers its result once, then restates it as ended within 30 seconds",
    { timeout: 60_000 },
    async () => {
      const f = await createFixture({ mcs: true });
      const isChild = (body: WireBody) => !(body.tools ?? []).some((tool) => tool.name === "Agent");
      const isParent = (body: WireBody) => !isChild(body) && !isSummaryRequest(body);
      let releaseChild = () => {};
      const childGate = new Promise<void>((resolve) => {
        releaseChild = resolve;
      });
      let parentCalls = 0;
      f.respond = async (body) => {
        if (isSummaryRequest(body)) {
          return {
            content: [{ type: "text", text: "<summary>WIRE_AGENT_SUMMARY</summary>" }],
            stop: "end_turn",
          };
        }
        // 子代理一直扣住，直到第一次压缩之后。
        if (isChild(body)) {
          await childGate;
          return { content: [{ type: "text", text: "WIRE_CHILD_RESULT" }], stop: "end_turn" };
        }
        parentCalls += 1;
        if (parentCalls !== 1) return undefined;
        return toolCall("toolu_agent", "Agent", {
          description: "wire child",
          prompt: "Report WIRE_CHILD_RESULT.",
          subagent_type: "general-purpose",
          run_in_background: true,
        });
      };
      const isNotification = (body: WireBody) =>
        isParent(body) && JSON.stringify(body.messages.at(-1)).includes("<task-notification>");
      await f.withApp(async (app) => {
        await app.submitPrompt("launch the child");
        await app.submitPrompt("/compact");
        await app.submitPrompt("after compact");
        releaseChild();
        await f.waitForRequest(isNotification);
        await waitFor(() => app.runtime.getActiveTurnInfo() === undefined);
        await app.submitPrompt("/compact");
        await app.submitPrompt("after second compact");
      });

      const agentId = toolResultText(
        f.bodies.find((body) => isParent(body) && hasToolResult(body, "toolu_agent"))!,
        "toolu_agent",
      ).match(/agentId: (\S+)/)![1]!;
      const running = f.bodies.find((body) => lastUserText(body) === "after compact")!;
      expect(textBlocks(running, "system").join("\n")).toContain(
        `Background agent "wire child" (${agentId}) is still running. Do NOT spawn a duplicate. You will be notified when it completes. Send it a message with SendMessage if you need a progress report before then.`,
      );
      // 运行中的状态不代替终态通知：结果在压缩之后照常送达，而且只送一次。
      const notified = f.bodies.find(isNotification)!;
      expect(JSON.stringify(notified.messages).split("<task-notification>")).toHaveLength(2);
      expect(JSON.stringify(notified.messages)).toContain("WIRE_CHILD_RESULT");

      const ended = f.bodies.find((body) => lastUserText(body) === "after second compact")!;
      const endedText = textBlocks(ended, "system").join("\n");
      expect(endedText).toContain(
        `Task ${agentId} (type: local_agent) (status: completed) (description: wire child) Send it a message with SendMessage to retrieve its result.`,
      );
      expect(endedText).not.toContain("is still running");

      await f.withApp(
        async (app) => {
          await app.submitPrompt("after resume");
        },
        { resume: true },
      );
      expectColdReplay(ended, f.bodies.at(-1)!);
    },
  );
});

async function createFixture(options: { mcs: boolean }): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "zcode-compact-wire-"));
  const workspace = join(root, "workspace");
  const storageDir = join(root, "storage");
  await mkdir(workspace, { recursive: true });
  process.env.ZCODE_STORAGE_DIR = storageDir;
  const bodies: WireBody[] = [];
  const waiters: Array<() => void> = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (!req.url?.includes("/messages")) {
      res.writeHead(404).end("{}");
      return;
    }
    const body = JSON.parse(raw) as WireBody & { model: string };
    bodies.push(body);
    const index = bodies.length;
    for (const wake of waiters.splice(0)) wake();
    const reply = (await fixture?.respond(body)) ?? {
      content: [{ type: "text", text: "done" }],
      stop: "end_turn",
    };
    writeReply(res, body, index, reply);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock server has no port");
  const registry = providerRegistry(`http://127.0.0.1:${address.port}/v1`, options.mcs);
  const sessionId = createSessionId("compact-wire");
  // shell 用隔离的 HOME，不读本机 shell 配置；PATH 等其余环境沿用测试进程。
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  const env = { ...process.env, HOME: home, ZCODE_STORAGE_DIR: storageDir };

  const waitForRequest = async (predicate: (body: WireBody) => boolean) => {
    await waitFor(() => bodies.some(predicate), waiters);
    return bodies.find(predicate)!;
  };

  const withApp = async (
    action: (app: App) => Promise<void>,
    appOptions: { resume?: boolean } = {},
  ) => {
    const sessionStore = await createSqliteSessionStore({ dbPath: join(root, "session.sqlite") });
    const app = await createZCodeApp({
      env,
      modelAdapter: createModelAdapter({
        env,
        executionConfig: createRuntimeAiSdkModelExecutionConfig(env),
      }),
      providerRegistry: registry,
      pluginStorageRoot: join(root, "plugins"),
      readSubagentRuntimeConfig: async () => ({ kind: "built-in-fallback" }),
      runtimeConfig: {
        mcp: { enabled: false },
        memory: { enabled: false },
        mode: "yolo",
        modelSelection: {
          providerId: PROVIDER_ID,
          modelId: MODEL_ID,
          options: { reasoningLevel: "disabled" },
        },
        modelStreaming: "off",
        storage: { dir: storageDir },
        subagents: { enabled: true },
        titleGeneration: { enabled: false },
        workingDirectory: workspace,
      },
      ...(appOptions.resume ? { resume: true } : {}),
      sessionId,
      sessionStore,
      skipUserConfig: true,
    });
    try {
      await action(app);
      // 等当前轮次结束再关闭；轮次中途关闭会留下中断标记，改变下一次请求。
      await waitFor(() => app.runtime.getActiveTurnInfo() === undefined);
    } finally {
      await app.close?.();
      sessionStore.close();
    }
  };

  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  fixture = { root, workspace, bodies, respond: () => undefined, withApp, waitForRequest, close };
  return fixture;
}

/** 压缩摘要固定走流式请求，按 SSE 回复；其余请求回复 JSON。 */
function writeReply(
  res: ServerResponse,
  body: WireBody & { model: string },
  index: number,
  reply: Reply,
) {
  const message = {
    id: `msg_${index}`,
    type: "message",
    role: "assistant",
    model: body.model,
    content: reply.content,
    stop_reason: reply.stop,
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 5 },
  };
  if (!body.stream) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(message));
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const events: Array<Record<string, unknown>> = [
    {
      type: "message_start",
      message: {
        ...message,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 100, output_tokens: 1 },
      },
    },
  ];
  for (const [blockIndex, block] of reply.content.entries()) {
    const toolUse = block.type === "tool_use";
    events.push(
      {
        type: "content_block_start",
        index: blockIndex,
        content_block: toolUse ? { ...block, input: {} } : { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: blockIndex,
        delta: toolUse
          ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
          : { type: "text_delta", text: block.text },
      },
      { type: "content_block_stop", index: blockIndex },
    );
  }
  events.push(
    {
      type: "message_delta",
      delta: { stop_reason: reply.stop, stop_sequence: null },
      usage: { output_tokens: 5 },
    },
    { type: "message_stop" },
  );
  for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
}

/** 轮询条件；收到新请求时立即再查一次。 */
async function waitFor(check: () => boolean, waiters: Array<() => void> = []): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition was not reached");
    await new Promise<void>((resolve) => {
      waiters.push(resolve);
      setTimeout(resolve, 50);
    });
  }
}

function providerRegistry(baseUrl: string, mcs: boolean): ProviderRegistry {
  return new ProviderRegistry([
    {
      providerId: PROVIDER_ID,
      config: new ProviderConfig({
        access: new ApiKeyAccessConfig({ apiKey: "wire-local-fake" }),
        api: new ProviderApiConfig({ type: "anthropic-messages", baseUrl }),
        models: [MODEL_ID],
        enabled: true,
      }),
      models: [
        {
          modelId: MODEL_ID,
          config: new ModelConfig({
            properties: new ModelPropertiesConfig({
              contextWindow: 1_000_000,
              inputFormat: { supportsText: true },
              outputFormat: { supportsText: true },
              supportsToolCall: true,
              supportsJsonSchemaOutput: true,
              supportsNativeWebSearch: false,
              supportsMidConversationSystem: mcs,
            }),
            optionSpecs: new ModelOptionSpecsConfig({
              reasoningLevel: { values: ["disabled"], map: "{}" },
              maxOutputTokens: { max: 10_000, map: '{"max_tokens": maxOutputTokens}' },
            }),
          }),
        },
      ],
    },
  ]);
}

function isSummaryRequest(body: WireBody): boolean {
  return JSON.stringify(body.messages.at(-1)).includes(SUMMARY_SENTINEL);
}

function toolCall(id: string, name: string, input: Record<string, unknown>): Reply {
  return { content: [{ type: "tool_use", id, name, input }], stop: "tool_use" };
}

/** 该角色所有消息里的文本，按出现顺序；字符串内容算一条。 */
function textBlocks(body: WireBody, role: string): string[] {
  return body.messages
    .filter((message) => message.role === role)
    .flatMap((message) =>
      typeof message.content === "string"
        ? [message.content]
        : message.content.flatMap((block) => (block.type === "text" ? [String(block.text)] : [])),
    );
}

/** 最后一条 user 消息的最后一个文本块，即本次请求的用户输入。 */
function lastUserText(body: WireBody): string | undefined {
  return textBlocks({ messages: body.messages.filter((m) => m.role === "user") }, "user").at(-1);
}

function hasToolResult(body: WireBody, toolUseId: string): boolean {
  return body.messages.some(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some(
        (block) => block.type === "tool_result" && block.tool_use_id === toolUseId,
      ),
  );
}

function toolResultText(body: WireBody, toolUseId: string): string {
  for (const message of body.messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type !== "tool_result" || block.tool_use_id !== toolUseId) continue;
      const content = block.content;
      return Array.isArray(content)
        ? (content as Block[]).map((item) => String(item.text ?? "")).join("")
        : String(content ?? "");
    }
  }
  throw new Error(`${toolUseId} has no tool_result`);
}

/**
 * 冷恢复后的首个请求：重启前最后一个请求的 system 与 messages 原样在前，只在后面追加。
 * 缓存断点会移到最新的消息上，不算内容。
 */
function expectColdReplay(live: WireBody, resumed: WireBody) {
  expect(withoutCacheControl(resumed.system)).toEqual(withoutCacheControl(live.system));
  expect(withoutCacheControl(resumed.messages.slice(0, live.messages.length))).toEqual(
    withoutCacheControl(live.messages),
  );
}

function withoutCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCacheControl);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "cache_control")
      .map(([key, item]) => [key, withoutCacheControl(item)]),
  );
}
