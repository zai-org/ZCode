import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import {
  createSessionId,
  type HookMatcherConfig,
  type HooksRuntimeConfigPatch,
} from "@zcode/contracts";
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

const PROVIDER_ID = "bash-wire";
export const SLEEP_ADVICE =
  "To wait for a condition, run an until-loop with run_in_background: true (e.g. `until <check>; do sleep 2; done`); you are notified when it exits. To wait for a command you started, use run_in_background: true. Do not chain shorter sleeps to work around this block.";
const MODEL_ID = "bash-wire-model";

export type Block = Record<string, unknown> & { type?: string };
type WireMessage = { role: string; content: string | Block[] };
export type WireBody = {
  system?: Block[];
  messages: WireMessage[];
  tools?: Array<{ name: string; description?: string }>;
};
type Reply = { content: Block[]; stop: "tool_use" | "end_turn" };

interface Fixture {
  root: string;
  workspace: string;
  bodies: WireBody[];
  /** 按收到的请求序号（从 1 开始）给出回复；没有时回复一段文字。 */
  script: Map<number, Reply>;
  /** 按请求内容给出回复，优先于 script；返回 undefined 时再查 script。 */
  respond?: (body: WireBody) => Reply | undefined;
  /** 每次回复前把伪造的 Date 往后拨这么多毫秒（模拟模型响应耗时）；需要先 vi.useFakeTimers。 */
  responseMs?: number;
  /** until：关闭 app 之前等到满足条件的请求（例如后台任务的通知轮）。 */
  run(
    prompt: string,
    options?: { resume?: boolean; until?: (body: WireBody) => boolean },
  ): Promise<void>;
  close(): Promise<void>;
  /** recordHooks 时 Hook 收到的 stdin，按运行顺序。 */
  hookInputs(): Promise<Array<Record<string, unknown>>>;
}

let fixture: Fixture | undefined;
let previousStorageDir: string | undefined;

export async function createFixture(options: { recordHooks?: boolean } = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "zcode-bash-wire-"));
  const workspace = join(root, "workspace");
  const storageDir = join(root, "storage");
  await mkdir(workspace, { recursive: true });
  process.env.ZCODE_STORAGE_DIR = storageDir;
  const hookLog = join(root, "hook-inputs.jsonl");
  const hooks = options.recordHooks ? await recordingHooks(root, hookLog) : undefined;
  const bodies: WireBody[] = [];
  const script = new Map<number, Reply>();
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
    if (fixture?.responseMs) vi.setSystemTime(Date.now() + fixture.responseMs);
    for (const wake of waiters.splice(0)) wake();
    const reply = fixture?.respond?.(body) ??
      script.get(bodies.length) ?? {
        content: [{ type: "text", text: "done" }],
        stop: "end_turn",
      };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: `msg_${bodies.length}`,
        type: "message",
        role: "assistant",
        model: body.model,
        content: reply.content,
        stop_reason: reply.stop,
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 5 },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock server has no port");
  const registry = providerRegistry(`http://127.0.0.1:${address.port}/v1`);
  const sessionId = createSessionId("bash-wire");
  // shell 用隔离的 HOME，不读本机 shell 配置；PATH 等其余环境沿用测试进程。
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  const env = { ...process.env, HOME: home, ZCODE_STORAGE_DIR: storageDir };

  const waitForRequest = (predicate: (body: WireBody) => boolean) =>
    waitFor(() => bodies.some(predicate), waiters);

  const run = async (
    prompt: string,
    options: { resume?: boolean; until?: (body: WireBody) => boolean } = {},
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
        ...(hooks ? { hooks } : {}),
      },
      ...(options.resume ? { resume: true } : {}),
      sessionId,
      sessionStore,
      skipUserConfig: true,
    });
    try {
      await app.submitPrompt(prompt);
      if (options.until) {
        await waitForRequest(options.until);
        // 等这个请求所在的轮次结束再关闭；轮次中途关闭会留下中断标记，改变下一次请求。
        await waitFor(() => app.runtime.getActiveTurnInfo() === undefined);
      }
    } finally {
      await app.close?.();
      sessionStore.close();
    }
  };

  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  const hookInputs = async () =>
    (await readFile(hookLog, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  fixture = { root, workspace, bodies, script, run, close, hookInputs };
  return fixture;
}

/**
 * PostToolUse 与 PostToolUseFailure 各挂一个 process Hook：把 stdin 追加到 log，
 * 返回 `AUDIT_<事件名>` 作为 additionalContext。
 */
async function recordingHooks(root: string, log: string): Promise<HooksRuntimeConfigPatch> {
  const script = join(root, "record-hook.mjs");
  await writeFile(
    script,
    [
      'import { appendFileSync } from "node:fs";',
      'let raw = "";',
      "for await (const chunk of process.stdin) raw += chunk;",
      "const input = JSON.parse(raw);",
      "appendFileSync(process.argv[2], JSON.stringify(input) + '\\n');",
      "const event = input.hook_event_name;",
      "process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: `AUDIT_${event}` } }));",
    ].join("\n"),
  );
  const matcher = (): HookMatcherConfig[] => [
    {
      matcher: "Bash",
      hooks: [
        { type: "process", command: process.execPath, args: [script, log], timeoutMs: 20_000 },
      ],
    },
  ];
  // runtimeConfig 直接传给 createZCodeApp，不经过默认配置层：输出上限与超时要写全，否则 stdout 读不到。
  return {
    enabled: true,
    events: { PostToolUse: matcher(), PostToolUseFailure: matcher() },
    maxOutputBytes: 32_768,
    timeoutMs: 60_000,
  };
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

function providerRegistry(baseUrl: string): ProviderRegistry {
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
              supportsMidConversationSystem: true,
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

export function bashCall(id: string, input: Record<string, unknown>): Reply {
  return {
    content: [{ type: "tool_use", id, name: "Bash", input: { description: id, ...input } }],
    stop: "tool_use",
  };
}

export function toolResult(body: WireBody, toolUseId: string): { is_error: boolean; text: string } {
  for (const message of body.messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type !== "tool_result" || block.tool_use_id !== toolUseId) continue;
      const content = block.content;
      const text = Array.isArray(content)
        ? (content as Block[]).map((item) => String(item.text ?? "")).join("")
        : String(content ?? "");
      return { is_error: block.is_error === true, text };
    }
  }
  throw new Error(`${toolUseId} has no tool_result`);
}

export function systemTexts(body: WireBody): string[] {
  return body.messages
    .filter((message) => message.role === "system")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content.map((block) => String(block.text ?? "")).join(""),
    );
}

/**
 * 冷恢复后的首个请求：重启前最后一个请求的 system 与 messages 原样在前，只在后面追加。
 * 缓存断点会移到最新的消息上，不算内容。is_error 也要相同：错误结果的标记随 completed part 持久化。
 */
export function expectColdReplay(live: WireBody, resumed: WireBody) {
  expect(withoutVolatile(resumed.system)).toEqual(withoutVolatile(live.system));
  expect(withoutVolatile(resumed.messages.slice(0, live.messages.length))).toEqual(
    withoutVolatile(live.messages),
  );
}

function withoutVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutVolatile);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "cache_control")
      .map(([key, item]) => [key, withoutVolatile(item)]),
  );
}

export function expectNoTotalTokens(bodies: WireBody[]) {
  for (const body of bodies) expect(JSON.stringify(body)).not.toContain("<total_tokens>");
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function setupBashWireTest() {
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
}

export async function assertSubagentBashText(runInBackground: boolean, expected: string) {
  const f = await createFixture();
  const isChild = (body: WireBody) => !(body.tools ?? []).some((tool) => tool.name === "Agent");
  let parentCalls = 0;
  let childCalls = 0;
  f.respond = (body) => {
    if (isChild(body)) {
      childCalls += 1;
      return childCalls === 1
        ? bashCall("toolu_child_bg", { command: "sleep 0.2", run_in_background: true })
        : undefined;
    }
    parentCalls += 1;
    if (parentCalls !== 1) return undefined;
    return {
      content: [
        {
          type: "tool_use",
          id: "toolu_agent",
          name: "Agent",
          input: {
            description: "child task",
            prompt: "Start the command in the background.",
            subagent_type: "general-purpose",
            run_in_background: runInBackground,
          },
        },
      ],
      stop: "tool_use",
    };
  };
  await f.run("launch the child", {
    until: () => f.bodies.filter(isChild).length >= 2,
  });

  const childResult = toolResult(f.bodies.filter(isChild)[1]!, "toolu_child_bg");
  expect(childResult.is_error).toBe(false);
  expect(childResult.text).toMatch(
    new RegExp(
      `^Command running in background with ID: \\S+\\. Output is being written to: \\S+\\. ${escapeRegExp(expected)} To check interim output, use Read on that file path\\.$`,
    ),
  );
}
