// SCT08（会话工具设计 0.5）：真实 `zcode tui` 进程在伪终端中运行，键盘回答后台会话的审批。
// 发起者（yolo）用 CreateSession 建后台根；后台根的 Write 在发起者回合结束后才询问。
// 只断言用户可见的终端画面、真实工具结果、磁盘文件和重开后的 SQLite，不替换 TUI、broker 或 runtime。
import assert from "node:assert/strict";
import { spawn as spawnProcess } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { z } from "zod";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import type { SessionId } from "@zcode/contracts";

const providerModule = new URL(
  "../../../../e2e/compact-microcompact/scripted-provider.mjs",
  import.meta.url,
);
const { startScriptedProvider, stopScriptedProvider, writeScriptedCaptureFile } = await import(
  providerModule.href
);
const repoRoot = fileURLToPath(new URL("../../../../../../", import.meta.url));
const cliEntry = fileURLToPath(new URL("../../../cli/src/main.ts", import.meta.url));
const tsxLoader = fileURLToPath(import.meta.resolve("tsx"));

// 伪终端与终端模拟器借用桌面/界面包已声明的依赖，不给 bootstrap 新增原生依赖。
type Pty = {
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number }) => void): void;
  write(data: string): void;
  kill(): void;
};
type Terminal = {
  write(data: string, callback?: () => void): void;
  buffer: {
    active: {
      length: number;
      getLine(y: number): { translateToString(trimRight?: boolean): string } | undefined;
    };
  };
  dispose(): void;
};
const { spawn } = createRequire(join(repoRoot, "packages/desktop/package.json"))("node-pty") as {
  spawn(file: string, args: string[], options: Record<string, unknown>): Pty;
};
const { Terminal } = createRequire(join(repoRoot, "packages/ui/package.json"))("@xterm/xterm") as {
  Terminal: new (options: Record<string, unknown>) => Terminal;
};

const MODEL = "sct08-fixture";
const COLS = 140;
const ROWS = 40;
const KINDS = ["allow", "deny"] as const;
type Kind = (typeof KINDS)[number];
const ACTOR: Record<Kind, string> = {
  allow: "E2E_SCT08_ACTOR_ALLOW start a background writer",
  deny: "E2E_SCT08_ACTOR_DENY start another background writer",
};
const ACTOR_MARKER: Record<Kind, string> = {
  allow: "E2E_SCT08_ACTOR_ALLOW",
  deny: "E2E_SCT08_ACTOR_DENY",
};
const BACKGROUND: Record<Kind, string> = {
  allow: "E2E_SCT08_BG_ALLOW",
  deny: "E2E_SCT08_BG_DENY",
};
const CONTENT: Record<Kind, string> = {
  allow: "written after the user allowed",
  deny: "must never be written",
};
const requestSchema = z.object({
  stream: z.boolean().optional(),
  messages: z.array(
    z.object({ role: z.string(), content: z.unknown(), tool_call_id: z.string().optional() }),
  ),
  tools: z.array(z.object({ function: z.object({ name: z.string() }) })).optional(),
});
type Request = z.infer<typeof requestSchema>;

it("answers a background session approval from the real TUI keyboard (SCT08)", async () => {
  // macOS 的 /var 临时目录会被 cwd 解析成 /private/var；CreateSession 校验真实 workspace 身份。
  const directory = await realpath(await mkdtemp(join(tmpdir(), "zcode-sct08-")));
  const workspace = join(directory, "workspace");
  const database = join(directory, "sessions.sqlite");
  await Promise.all([
    mkdir(workspace),
    mkdir(join(directory, ".zcode", "cli"), { recursive: true }),
  ]);
  const files: Record<Kind, string> = {
    allow: join(workspace, "sct08-allow.txt"),
    deny: join(workspace, "sct08-deny.txt"),
  };
  const created: Partial<Record<Kind, string>> = {};
  const backgroundResult = {
    allow: Promise.withResolvers<string>(),
    deny: Promise.withResolvers<string>(),
  };
  const answered: Record<Kind, boolean> = { allow: false, deny: false };
  // 后台根的 Write 只在发起者这一轮完全结束后才发出：这正是原缺陷场景，
  // 询问发生在任何一次提交之外（修复前 TUI 的审批入口此时已恢复为空）。
  const actorTurnEnded = {
    allow: Promise.withResolvers<void>(),
    deny: Promise.withResolvers<void>(),
  };
  let providerError: unknown;
  const provider = await startScriptedProvider({
    name: "sct08-tui-approval",
    handler: async ({ body }: { body: unknown }) => {
      try {
        const request = requestSchema.parse(body);
        // 标题等辅助请求不带工具，也只访问本地 provider。
        if (!request.tools?.length) return response(request, "SCT08 title");
        const userText = request.messages
          .filter((message) => message.role === "user")
          .map((message) => JSON.stringify(message.content))
          .join("\n");
        for (const kind of KINDS) {
          if (!userText.includes(BACKGROUND[kind])) continue;
          const result = toolResult(request, `sct08-write-${kind}`);
          if (result === undefined) {
            await actorTurnEnded[kind].promise;
            return response(
              request,
              { name: "Write", input: { file_path: files[kind], content: CONTENT[kind] } },
              `sct08-write-${kind}`,
            );
          }
          backgroundResult[kind].resolve(result);
          return response(request, `${BACKGROUND[kind]}_DONE`);
        }
        // 第二轮的历史里也有第一轮的回执，所以先判断 deny。
        for (const kind of ["deny", "allow"] as const) {
          if (!userText.includes(ACTOR_MARKER[kind])) continue;
          const result = toolResult(request, `sct08-create-${kind}`);
          if (result === undefined)
            return response(
              request,
              {
                name: "CreateSession",
                input: { prompt: BACKGROUND[kind] },
              },
              `sct08-create-${kind}`,
            );
          created[kind] = (
            JSON.parse(result) as { session: { sessionId: string } }
          ).session.sessionId;
          return response(request, `${ACTOR_MARKER[kind]}_DONE`);
        }
        throw new Error(`unexpected provider request: ${userText.slice(0, 400)}`);
      } catch (error) {
        providerError ??= error;
        return { status: 400, body: { error: { message: String(error) } } };
      }
    },
  });
  let raw = "";
  let pty: Pty | undefined;
  let exited: Promise<number> | undefined;
  const terminal = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
  const errors: unknown[] = [];
  let passed = false;

  async function screen(): Promise<string> {
    // 终端是增量绘制，只看 PTY 原始流会漏掉未变化的字符；用终端模拟器还原当前画面。
    await new Promise<void>((resolve) => terminal.write("", resolve));
    const lines: string[] = [];
    const buffer = terminal.buffer.active;
    for (let y = 0; y < buffer.length; y += 1)
      lines.push(buffer.getLine(y)?.translateToString(true) ?? "");
    return lines.join("\n");
  }
  async function waitFor<T>(
    describe: string,
    probe: (text: string) => T | undefined,
    timeoutMs = 30_000,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (providerError) throw providerError;
      // 用户回答前后台工具已有结果，说明询问没有到达 TUI（修复前被拒绝 broker 直接拒绝）。
      for (const kind of KINDS) {
        const early = await Promise.race([
          backgroundResult[kind].promise,
          Promise.resolve(undefined),
        ]);
        if (early !== undefined && !answered[kind])
          throw new Error(`background ${kind} finished before the user answered: ${early}`);
      }
      const value = probe(await screen());
      if (value !== undefined) return value;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${describe}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  async function submit(text: string) {
    pty!.write(`\x1b[200~${text}\x1b[201~`);
    await waitFor(`draft "${text}"`, (value) => (value.includes(text) ? true : undefined));
    pty!.write("\r");
  }
  async function approvalFor(kind: Kind) {
    // 回复已显示且输入框回到空闲占位符，说明发起者这一轮已结束，之后才放行后台根的询问。
    await waitFor(`${kind} actor turn ended`, (value) =>
      value.includes(`${ACTOR_MARKER[kind]}_DONE`) && value.includes("Type a prompt")
        ? true
        : undefined,
    );
    actorTurnEnded[kind].resolve();
    const origin = await waitFor(`${kind} approval panel`, (value) =>
      value.includes("Approval required: Write")
        ? /From background session (sess_\S+)/.exec(value)?.[1]
        : undefined,
    );
    // 来源只标注后台会话自己的 ID，与 CreateSession 的真实回执一致。
    assert.equal(origin, created[kind]);
    await assert.rejects(access(files[kind]), { code: "ENOENT" });
  }

  try {
    await writeConfig(directory, provider.baseURL);
    pty = spawn(
      process.execPath,
      [
        "--disable-warning=DEP0205",
        "--import",
        tsxLoader,
        cliEntry,
        "tui",
        "--mode",
        "yolo",
        "--locale",
        "en-US",
        "--no-browser",
      ],
      {
        name: "xterm-256color",
        cols: COLS,
        rows: ROWS,
        cwd: workspace,
        // 系统 ConPTY 会先关输出再回传退出码；使用 node-pty 自带版本。
        useConptyDll: process.platform === "win32",
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          TERM: "xterm-256color",
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
      },
    );
    pty.onData((data) => {
      raw += data;
      terminal.write(data);
    });
    exited = new Promise((resolve) => pty!.onExit(({ exitCode }) => resolve(exitCode)));
    await waitFor("TUI input", (value) => (value.includes("Type a prompt") ? true : undefined));

    // 允许：默认选中 Deny，上移两次到 Allow once 再确认。
    await submit(ACTOR.allow);
    await approvalFor("allow");
    pty.write("\x1b[A");
    await waitFor("Always allow highlighted", (value) =>
      value.includes("> Always allow in this project") ? true : undefined,
    );
    pty.write("\x1b[A");
    await waitFor("Allow once highlighted", (value) =>
      value.includes("> Allow once") ? true : undefined,
    );
    answered.allow = true;
    pty.write("\r");
    assert.match(await backgroundResult.allow.promise, /File created successfully/);
    assert.equal(await readFile(files.allow, "utf8"), CONTENT.allow);
    await waitFor("approval panel closed", (value) =>
      value.includes("Approval required") ? undefined : true,
    );

    // 拒绝：Enter 确认默认的 Deny，工具不执行。
    await submit(ACTOR.deny);
    await approvalFor("deny");
    answered.deny = true;
    pty.write("\r");
    assert.match(await backgroundResult.deny.promise, /Denied in TUI/);
    await assert.rejects(access(files.deny), { code: "ENOENT" });

    // 正常退出：owner 关闭后台根后进程结束。
    pty.write("\x03");
    await new Promise((resolve) => setTimeout(resolve, 300));
    pty.write("\x03");
    assert.equal(await exited, 0);
    if (providerError) throw providerError;

    const store = await createSqliteSessionStore({ dbPath: database });
    try {
      const sessions = await store.listSessions();
      assert.equal(sessions.length, 3, "actor plus two independent background roots");
      for (const kind of KINDS) {
        const sessionId = created[kind] as SessionId;
        const info = await store.getSession(sessionId);
        assert.equal(info?.parentID, undefined);
        // 发起者是 yolo，后台根仍是 build；共用的只是询问通道。
        assert.equal(info?.permission?.mode, "build");
        const write = (await store.messages({ sessionID: sessionId }))
          .flatMap((message) => message.parts)
          .find((part) => part.type === "tool" && part.tool === "Write");
        assert.ok(write?.type === "tool");
        assert.equal(write.state.status, kind === "allow" ? "completed" : "error");
      }
    } finally {
      store.close();
    }
    passed = true;
  } catch (error) {
    errors.push(error);
  } finally {
    for (const kind of KINDS) actorTurnEnded[kind].resolve();
    for (const cleanup of [
      async () => {
        if (!passed) {
          process.stderr.write(`SCT08 TUI evidence: ${directory}\n`);
          await writeFile(join(directory, "screen.txt"), await screen());
          await writeFile(join(directory, "pty.txt"), raw);
          await writeScriptedCaptureFile(provider, join(directory, "provider-capture.json"));
        }
      },
      async () => {
        pty?.kill();
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
        terminal.dispose();
      },
      async () => {
        provider.server.closeAllConnections();
        await stopScriptedProvider(provider);
      },
      async () => {
        if (passed) await rm(directory, { recursive: true, force: true, maxRetries: 3 });
      },
    ]) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(errors, `SCT08 TUI E2E failed: ${String(errors[0])}`, {
      cause: errors[0],
    });
}, 120_000);

// SCT08 的 headless 分支：没有交互面，后台根的询问立即得到拒绝结果，工具不执行，进程正常退出。
it("denies a background session approval immediately in headless mode (SCT08)", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "zcode-sct08-headless-")));
  const workspace = join(directory, "workspace");
  const database = join(directory, "sessions.sqlite");
  await Promise.all([
    mkdir(workspace),
    mkdir(join(directory, ".zcode", "cli"), { recursive: true }),
  ]);
  const file = join(workspace, "sct08-headless.txt");
  const backgroundResult = Promise.withResolvers<string>();
  let providerError: unknown;
  const provider = await startScriptedProvider({
    name: "sct08-headless",
    handler: async ({ body }: { body: unknown }) => {
      try {
        const request = requestSchema.parse(body);
        if (!request.tools?.length) return response(request, "SCT08 title");
        const userText = request.messages
          .filter((message) => message.role === "user")
          .map((message) => JSON.stringify(message.content))
          .join("\n");
        if (userText.includes("E2E_SCT08_BG_HEADLESS")) {
          const result = toolResult(request, "sct08-write-headless");
          if (result === undefined)
            return response(
              request,
              { name: "Write", input: { file_path: file, content: "must never be written" } },
              "sct08-write-headless",
            );
          backgroundResult.resolve(result);
          return response(request, "E2E_SCT08_BG_HEADLESS_DONE");
        }
        if (toolResult(request, "sct08-create-headless") === undefined)
          return response(
            request,
            {
              name: "CreateSession",
              input: {
                prompt: "E2E_SCT08_BG_HEADLESS",
              },
            },
            "sct08-create-headless",
          );
        // 发起者等到后台工具已有结果才结束，证明拒绝不依赖发起者或进程退出。
        await backgroundResult.promise;
        return response(request, "E2E_SCT08_HEADLESS_ACTOR_DONE");
      } catch (error) {
        providerError ??= error;
        return { status: 400, body: { error: { message: String(error) } } };
      }
    },
  });
  let passed = false;
  try {
    await writeConfig(directory, provider.baseURL);
    const child = spawnProcess(
      process.execPath,
      [
        "--disable-warning=DEP0205",
        "--import",
        tsxLoader,
        cliEntry,
        "-p",
        "E2E_SCT08_HEADLESS_ACTOR",
        "--mode",
        "yolo",
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
        timeout: 60_000,
        killSignal: "SIGKILL",
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr!.on("data", (chunk) => {
      stderr += chunk;
    });
    const [code, signal] = (await once(child, "close")) as [number | null, NodeJS.Signals | null];
    if (providerError) throw providerError;
    assert.deepEqual({ code, signal }, { code: 0, signal: null }, stderr);
    assert.match(stdout, /E2E_SCT08_HEADLESS_ACTOR_DONE/);
    assert.match(await backgroundResult.promise, /No permission client configured for Write/);
    await assert.rejects(access(file), { code: "ENOENT" });
    passed = true;
  } finally {
    backgroundResult.resolve("");
    provider.server.closeAllConnections();
    await stopScriptedProvider(provider);
    if (passed) await rm(directory, { recursive: true, force: true, maxRetries: 3 });
    else process.stderr.write(`SCT08 headless evidence: ${directory}\n`);
  }
}, 90_000);

function toolResult(request: Request, id: string): string | undefined {
  const message = request.messages.find((item) => item.role === "tool" && item.tool_call_id === id);
  if (!message) return undefined;
  const text =
    typeof message.content === "string" ? message.content : JSON.stringify(message.content);
  // 提醒以 "\n\n<system-reminder>" 追加在工具结果之后；只取工具自己的正文。
  const reminder = text.indexOf("\n\n<system-reminder>");
  return reminder < 0 ? text : text.slice(0, reminder);
}

function response(
  request: Request,
  value: string | { name: string; input: Record<string, unknown> },
  id = "fixture",
) {
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
