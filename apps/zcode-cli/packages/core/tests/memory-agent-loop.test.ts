import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createModelId,
  createModelProviderId,
  type ExecutionShellSelection,
  type Model,
  type ModelInputMessage,
  type ModelRequest,
  type ModelResult,
  type ModelToolContract,
} from "@zcode/contracts";

import {
  evaluateMemoryAgentToolPolicy,
  runMemoryAgentLoop,
  type MemoryAgentModelRequest,
} from "../src/memory/memory-agent-loop.js";
import { setCmdReadonlyHostForTest } from "../src/tool/handlers/bash-cmd-readonly-policy.js";
import {
  isRuntimeAttachmentEntry,
  type RuntimeMessageEntry,
} from "../src/agent/message-history.js";
import { DEFAULT_MODEL_REQUEST_MEDIA_BUDGET_BYTES } from "../src/runtime/helpers/media-budget.js";
import type { ExecutableToolCall, ToolExecutionResult } from "../src/tool/types.js";
import { createTestInputFormat } from "./test-runtime-model.js";

const modelSelection = {
  providerId: createModelProviderId("test"),
  modelId: createModelId("memory-agent"),
};
const memoryRoot = "/workspace/.memory";

describe("runMemoryAgentLoop", () => {
  it("preserves the frozen provider context and real tool catalog on every model turn", async () => {
    const initialMessages = Object.freeze([
      Object.freeze({ role: "system", content: "full system" }),
      Object.freeze({ role: "user", content: "full conversation" }),
      Object.freeze({ role: "user", content: "extract now" }),
    ]) satisfies readonly ModelInputMessage[];
    const tools = Object.freeze([
      tool("Read", true, "none"),
      tool("Write", false, "workspace"),
      tool("Agent", false, "session"),
    ]) satisfies readonly ModelToolContract[];
    const requests: MemoryAgentModelRequest[] = [];
    const executeToolCalls = vi.fn(async (calls: ExecutableToolCall[]) =>
      calls.map((call) => executionResult(call.id, call.name, "written")),
    );
    const model = generateOnlyModel(async (request) => {
      requests.push(request as MemoryAgentModelRequest);
      if (requests.length < 5) {
        return modelResult({
          text: `turn ${requests.length}`,
          toolCalls: [{ id: `read-${requests.length}`, name: "Read", input: {} }],
        });
      }
      return modelResult({
        text: "last turn",
        toolCalls: [
          {
            id: "write-last",
            name: "Write",
            input: { file_path: `${memoryRoot}/fact.md`, content: "fact" },
          },
        ],
      });
    });

    const result = await runMemoryAgentLoop({
      abortSignal: new AbortController().signal,
      bashShellSelection: undefined,
      entries: messageEntries(initialMessages),
      executeToolCalls,
      maxTurns: 5,
      registry: noBatchNoticeRegistry,
      renderRequest: passthroughRender(tools),
      model,
      rootDir: memoryRoot,
      workingDirectory: "/workspace",
      workspaceRoot: "/workspace",
    });

    expect(requests).toHaveLength(5);
    expect(executeToolCalls).toHaveBeenCalledTimes(5);
    expect(executeToolCalls).toHaveBeenLastCalledWith(
      [expect.objectContaining({ id: "write-last", name: "Write" })],
      expect.objectContaining({ abortSignal: expect.any(AbortSignal) }),
    );
    expect(requests[0]?.messages).toEqual(initialMessages);
    expect(requests.every((request) => request.tools === tools)).toBe(true);
    expect(requests.every((request) => request.toolSearchEnabled === false)).toBe(true);
    expect(requests.every((request) => request.options?.reasoningLevel === "low")).toBe(true);
    expect(requests.every((request) => request.options?.maxOutputTokens === 5_000)).toBe(true);
    expect(requests[1]?.messages.slice(-2)).toEqual([
      expect.objectContaining({
        role: "assistant",
        content: "turn 1",
        toolCalls: [{ id: "read-1", name: "Read", input: {} }],
      }),
      expect.objectContaining({
        role: "tool",
        content: "written",
        toolCallId: "read-1",
        toolName: "Read",
        isError: false,
      }),
    ]);
    expect(result.turns).toBe(5);
    expect(messagesOf(result.entries).slice(-2)).toEqual([
      expect.objectContaining({ role: "assistant", content: "last turn" }),
      expect.objectContaining({ role: "tool", toolCallId: "write-last", isError: false }),
    ]);
  });

  it("applies media capability and budget projection on every model turn", async () => {
    const unsupportedVideo = {
      type: "video" as const,
      mediaType: "video/mp4",
      dataUrl: "data:video/mp4;base64,dmlkZW8=",
    };
    const sharedImageDataUrl = `data:image/png;base64,${"A".repeat(5 * 1024 * 1024)}`;
    const retainedImageCount = Math.floor(
      DEFAULT_MODEL_REQUEST_MEDIA_BUDGET_BYTES / Buffer.byteLength(sharedImageDataUrl, "utf8"),
    );
    const historicalImage = {
      type: "image" as const,
      mediaType: "image/png",
      dataUrl: sharedImageDataUrl,
    };
    const requests: ModelRequest[] = [];
    const executeToolCalls = vi.fn(async (calls: ExecutableToolCall[]) =>
      calls.map((call) => ({
        ...executionResult(call.id, call.name, "read media"),
        modelContent: [unsupportedVideo, historicalImage],
      })),
    );
    const model = generateOnlyModel(
      async (request) => {
        requests.push(request);
        return requests.length === 1
          ? modelResult({
              toolCalls: [
                { id: "read-media-1", name: "Read", input: {} },
                { id: "read-media-2", name: "Read", input: {} },
              ],
            })
          : modelResult({ text: "done" });
      },
      { inputFormat: createTestInputFormat({ supportsVideo: false }) },
    );

    await runMemoryAgentLoop({
      bashShellSelection: undefined,
      entries: messageEntries([
        {
          role: "user",
          content: [
            { type: "text", text: "historical media" },
            unsupportedVideo,
            ...Array.from({ length: retainedImageCount + 2 }, () => historicalImage),
          ],
        },
        { role: "user", content: "extract memory" },
      ]),
      executeToolCalls,
      maxTurns: 2,
      registry: noBatchNoticeRegistry,
      renderRequest: passthroughRender([tool("Read", true, "none")]),
      model,
      rootDir: memoryRoot,
      workingDirectory: "/workspace",
      workspaceRoot: "/workspace",
    });

    expect(requests).toHaveLength(2);
    for (const request of requests) {
      const blocks = request.messages.flatMap((message) =>
        Array.isArray(message.content) ? message.content : [],
      );
      const text = blocks
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      expect(blocks.filter((block) => block.type === "video")).toHaveLength(0);
      expect(blocks.filter((block) => block.type === "image")).toHaveLength(retainedImageCount);
      expect(text).toContain("does not support video input");
      expect(text).toContain("Media omitted from provider request");
    }
  });

  it("returns the exact provider-visible denial text without invoking the executor", async () => {
    const executeToolCalls = vi.fn();
    const requests: ModelRequest[] = [];
    const model = generateOnlyModel(async (request) => {
      requests.push(request);
      if (requests.length === 1) {
        return modelResult({
          toolCalls: [
            { id: "network", name: "WebFetch", input: { url: "https://example.com" } },
            { id: "bash-write", name: "Bash", input: { command: "touch /workspace/file" } },
          ],
        });
      }
      return modelResult({ text: "done" });
    });

    const result = await runMemoryAgentLoop({
      bashShellSelection: undefined,
      entries: messageEntries([{ role: "user", content: "extract" }]),
      executeToolCalls,
      maxTurns: 2,
      registry: noBatchNoticeRegistry,
      renderRequest: passthroughRender([
        tool("WebFetch", true, "network"),
        tool("Bash", false, "workspace"),
      ]),
      model,
      rootDir: memoryRoot,
      workingDirectory: "/workspace",
      workspaceRoot: "/workspace",
    });

    expect(executeToolCalls).not.toHaveBeenCalled();
    const deniedToolMessages = [
      {
        content:
          "only Read, Grep, Glob, read-only Bash, and Edit/Write within /workspace/.memory are allowed",
        role: "tool",
        toolCallId: "network",
        toolName: "WebFetch",
        isError: true,
      },
      {
        content:
          "Only read-only shell commands and rm with all paths inside /workspace/.memory are permitted in this context (ls, find, grep, cat, stat, wc, head, tail, and similar)",
        role: "tool",
        toolCallId: "bash-write",
        toolName: "Bash",
        isError: true,
      },
    ];
    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages.slice(-2)).toEqual(deniedToolMessages);
    expect(messagesOf(result.entries).slice(-3, -1)).toEqual(deniedToolMessages);
  });

  it("returns the catalog-miss result before applying the Memory tool policy", async () => {
    const executeToolCalls = vi.fn();
    const requests: ModelRequest[] = [];
    const model = generateOnlyModel(async (request) => {
      requests.push(request);
      if (requests.length === 1) {
        return modelResult({
          toolCalls: [
            { id: "empty-name", name: "", input: {} },
            { id: "unknown-name", name: "Unknown", input: {} },
          ],
        });
      }
      return modelResult({ text: "done" });
    });

    await runMemoryAgentLoop({
      bashShellSelection: undefined,
      entries: messageEntries([{ role: "user", content: "extract" }]),
      executeToolCalls,
      maxTurns: 2,
      registry: noBatchNoticeRegistry,
      renderRequest: passthroughRender([tool("Read", true, "none")]),
      model,
      rootDir: memoryRoot,
      workingDirectory: "/workspace",
      workspaceRoot: "/workspace",
    });

    expect(executeToolCalls).not.toHaveBeenCalled();
    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages.slice(-2)).toEqual([
      {
        content: "<tool_use_error>Error: No such tool available: </tool_use_error>",
        role: "tool",
        toolCallId: "empty-name",
        toolName: "",
        isError: true,
      },
      {
        content: "<tool_use_error>Error: No such tool available: Unknown</tool_use_error>",
        role: "tool",
        toolCallId: "unknown-name",
        toolName: "Unknown",
        isError: true,
      },
    ]);
  });

  it("executes tool calls returned by the fiftieth Dream turn", async () => {
    let requestCount = 0;
    const executeToolCalls = vi.fn(async (calls: ExecutableToolCall[]) =>
      calls.map((call) => executionResult(call.id, call.name, "done")),
    );
    const model = generateOnlyModel(async () => {
      requestCount += 1;
      return modelResult({
        toolCalls: [
          requestCount === 50
            ? {
                id: "write-fiftieth",
                name: "Write",
                input: { file_path: `${memoryRoot}/fact.md`, content: "fact" },
              }
            : { id: `read-${requestCount}`, name: "Read", input: {} },
        ],
      });
    });

    const result = await runMemoryAgentLoop({
      bashShellSelection: undefined,
      entries: messageEntries([{ role: "user", content: "dream" }]),
      executeToolCalls,
      maxTurns: 50,
      registry: noBatchNoticeRegistry,
      renderRequest: passthroughRender([
        tool("Read", true, "none"),
        tool("Write", false, "workspace"),
      ]),
      model,
      rootDir: memoryRoot,
      workingDirectory: "/workspace",
      workspaceRoot: "/workspace",
    });

    expect(result.turns).toBe(50);
    expect(executeToolCalls).toHaveBeenCalledTimes(50);
    expect(executeToolCalls).toHaveBeenLastCalledWith(
      [expect.objectContaining({ id: "write-fiftieth", name: "Write" })],
      expect.any(Object),
    );
  });

  it("gives every allowed call a tool result even when the executor returns none for it", async () => {
    const requests: ModelRequest[] = [];
    const executeToolCalls = vi.fn(async (calls: ExecutableToolCall[]) => [
      executionResult(calls[0]!.id, calls[0]!.name, "read"),
    ]);
    const model = generateOnlyModel(async (request) => {
      requests.push(request);
      return requests.length === 1
        ? modelResult({
            toolCalls: [
              { id: "read-1", name: "Read", input: {} },
              { id: "read-2", name: "Read", input: {} },
            ],
          })
        : modelResult({ text: "done" });
    });

    await runMemoryAgentLoop({
      bashShellSelection: undefined,
      entries: messageEntries([{ role: "user", content: "extract" }]),
      executeToolCalls,
      maxTurns: 2,
      registry: noBatchNoticeRegistry,
      renderRequest: passthroughRender([tool("Read", true, "none")]),
      model,
      rootDir: memoryRoot,
      workingDirectory: "/workspace",
      workspaceRoot: "/workspace",
    });

    // 每个 tool_use 都要有 tool_result，否则下一次请求会被 provider 拒绝。
    expect(requests[1]?.messages.slice(-2)).toEqual([
      expect.objectContaining({ role: "tool", toolCallId: "read-1", isError: false }),
      expect.objectContaining({ role: "tool", toolCallId: "read-2", isError: true }),
    ]);
  });

  it("keeps tool results in call order and appends the batch notices after them", async () => {
    const tools = [tool("Read", true, "none"), tool("WebFetch", true, "network")];
    const executeToolCalls = vi.fn(async (calls: ExecutableToolCall[]) =>
      calls.map((call) => executionResult(call.id, call.name, { notice: `${call.id} notice` })),
    );
    const model = generateOnlyModel(async (request) =>
      request.messages.length === 1
        ? modelResult({
            toolCalls: [
              { id: "read-1", name: "Read", input: {} },
              { id: "network", name: "WebFetch", input: {} },
              { id: "read-2", name: "Read", input: {} },
            ],
          })
        : modelResult({ text: "done" }),
    );

    const result = await runMemoryAgentLoop({
      bashShellSelection: undefined,
      entries: messageEntries([{ role: "user", content: "extract" }]),
      executeToolCalls,
      maxTurns: 2,
      registry: {
        get: (name: string) =>
          name === "Read"
            ? ({
                formatBatchNotice: (output: unknown) => ({
                  source: "read_truncation_notice",
                  content: (output as { notice: string }).notice,
                }),
              } as never)
            : undefined,
      },
      renderRequest: passthroughRender(tools),
      model,
      rootDir: memoryRoot,
      workingDirectory: "/workspace",
      workspaceRoot: "/workspace",
    });

    // 被拒绝的 call 不进入调度；结果按声明顺序，批次附件排在这批 tool result 之后。
    expect(executeToolCalls).toHaveBeenCalledWith(
      [expect.objectContaining({ id: "read-1" }), expect.objectContaining({ id: "read-2" })],
      expect.any(Object),
    );
    const batch = result.entries.slice(2, 7);
    expect(
      batch.map((entry) =>
        isRuntimeAttachmentEntry(entry) ? entry.content : entry.message.toolCallId,
      ),
    ).toEqual(["read-1", "network", "read-2", "read-1 notice", "read-2 notice"]);
  });
});

describe("evaluateMemoryAgentToolPolicy", () => {
  const registeredTools = [
    tool("Read", true, "none"),
    tool("Grep", true, "none"),
    tool("Bash", false, "workspace"),
    tool("Write", false, "workspace"),
    tool("Edit", false, "workspace"),
    tool("Agent", false, "session"),
    tool("WebFetch", true, "network"),
    tool("mcp__server__lookup", true, "network"),
    tool("OtherReadOnly", true, "none"),
  ] as const;

  it.each([
    ["registered read-only", "Read", {}],
    ["read-only Bash", "Bash", { command: "head -n 5 /workspace/notes.txt" }],
    ["read-only Bash with safe environment", "Bash", { command: "LANG=C head /workspace/file" }],
    ["read-only Bash with input redirect", "Bash", { command: "head < /workspace/file" }],
    [
      "read-only Bash redirected to /dev/null",
      "Bash",
      {
        command: "head /workspace/file > /dev/null",
      },
    ],
    [
      "read-only background Bash",
      "Bash",
      {
        command: "head /workspace/file",
        run_in_background: true,
      },
    ],
    ["Memory Write", "Write", { file_path: `${memoryRoot}/fact.md`, content: "fact" }],
    [
      "Memory Edit",
      "Edit",
      { file_path: `${memoryRoot}/nested/fact.md`, old_string: "a", new_string: "b" },
    ],
    ["narrow Bash removal", "Bash", { command: `rm -f ${memoryRoot}/old.md` }],
  ])("allows %s", (_label, name, input) => {
    expect(decide(name, input, registeredTools)).toMatchObject({ allowed: true });
  });

  it("does not let static metadata bypass the explicit shell, Agent, or MCP boundaries", () => {
    expect(
      decide("Bash", { command: "touch /workspace/file" }, [tool("Bash", true, "none")]),
    ).toMatchObject({ allowed: false });
    expect(decide("Agent", {}, [tool("Agent", true, "none")])).toMatchObject({ allowed: false });
    expect(
      decide("mcp__server__lookup", {}, [tool("mcp__server__lookup", true, "none")]),
    ).toMatchObject({ allowed: false });
  });

  it.each([
    ".git",
    "hooks",
    ".husky",
    ".githooks",
    "node_modules",
    ".vscode",
    ".idea",
    "head",
    "config",
    "objects",
    "refs",
    ".claude",
    "skills",
    "commands",
    "agents",
    ".cargo",
    ".devcontainer",
    ".yarn",
    ".mvn",
  ])("denies Memory Write/Edit in the sensitive %s path segment", (segment) => {
    const filePath = `${memoryRoot}/${segment}/fact.md`;
    expect(decide("Write", { file_path: filePath }, registeredTools)).toMatchObject({
      allowed: false,
    });
    expect(decide("Edit", { file_path: filePath }, registeredTools)).toMatchObject({
      allowed: false,
    });
  });

  it("uses the foreground sensitive-segment normalization without broadening it", () => {
    for (const segment of [".GIT", ".git.", ".git ", ".g\u200cit", ".git:stream"]) {
      expect(
        decide("Write", { file_path: `${memoryRoot}/${segment}/fact.md` }, registeredTools),
      ).toMatchObject({ allowed: false });
    }
    expect(
      decide("Write", { file_path: `${memoryRoot}/.git-notes/fact.md` }, registeredTools),
    ).toMatchObject({ allowed: true });
  });

  it("keeps the narrow Markdown rm policy unchanged for sensitive path segments", () => {
    expect(
      decide("Bash", { command: `rm -f ${memoryRoot}/.git/fact.md` }, registeredTools),
    ).toMatchObject({ allowed: true });
  });

  it.each([
    ["unregistered", "Unknown", {}],
    ["Agent", "Agent", {}],
    ["network tool", "WebFetch", { url: "https://example.com" }],
    ["MCP tool", "mcp__server__lookup", {}],
    ["unlisted read-only tool", "OtherReadOnly", {}],
    ["outside Write", "Write", { file_path: "/workspace/outside.md", content: "x" }],
    ["uppercase extension", "Write", { file_path: `${memoryRoot}/fact.MD`, content: "x" }],
    ["write-capable Bash", "Bash", { command: "touch /workspace/file" }],
    ["recursive removal", "Bash", { command: `rm -rf ${memoryRoot}/old.md` }],
    ["glob removal", "Bash", { command: `rm ${memoryRoot}/*.md` }],
    ["write redirect", "Bash", { command: "head /workspace/file > /workspace/copy" }],
    ["unsafe environment prefix", "Bash", { command: "PATH=/tmp head /workspace/file" }],
  ])("denies %s", (_label, name, input) => {
    expect(decide(name, input, registeredTools)).toMatchObject({ allowed: false });
  });

  describe("by session shell", () => {
    afterEach(() => setCmdReadonlyHostForTest(undefined));

    it.each([
      ["posix", POSIX_SELECTION],
      ["git-bash", GIT_BASH_SELECTION],
    ])("keeps read-only Bash and Memory rm allowed in a %s session", (_label, selection) => {
      for (const command of ["head -n 5 /workspace/notes.txt", `rm -f ${memoryRoot}/old.md`]) {
        expect(decide("Bash", { command }, registeredTools, selection)).toMatchObject({
          allowed: true,
        });
      }
    });

    // Bash AST 把 # 后面当注释，cmd.exe 却会执行 & 后面的命令。
    it.each([
      ["a command chained after #", String.raw`type # & python G:\temp\hello.py`],
      ["Memory rm with a command chained after #", `rm -f ${memoryRoot}/old.md # & python x.py`],
      ["Memory rm that only Bash AST can prove", `rm -f ${memoryRoot}/old.md`],
    ])("denies %s when Bash runs through cmd.exe", (_label, command) => {
      setCmdReadonlyHostForTest(WINDOWS_CMD_HOST);
      for (const selection of [CMD_SELECTION, LEGACY_SHELL_SELECTION]) {
        expect(decide("Bash", { command }, registeredTools, selection)).toMatchObject({
          allowed: false,
        });
      }
    });

    // `DIR /b` 只有 CMD 规则放行（Bash AST 区分大小写，不认 DIR），能证明两种会经 cmd.exe 的
    // shell 走的是 CMD 规则，而不是全部拒绝或退回 Bash AST。
    it("allows what the foreground CMD read-only policy allows", () => {
      setCmdReadonlyHostForTest(WINDOWS_CMD_HOST);
      for (const selection of [CMD_SELECTION, LEGACY_SHELL_SELECTION]) {
        for (const command of ["dir /b", "DIR /b"]) {
          expect(decide("Bash", { command }, registeredTools, selection)).toMatchObject({
            allowed: true,
          });
        }
      }
    });

    // POSIX 上的 legacy-shell 回落到 /bin/sh，# 同样是注释，CMD 绕过不成立；保持修复前的 Bash AST 判定。
    it.each(["darwin", "linux"])(
      "keeps read-only Bash and Memory rm allowed in a %s legacy-shell session",
      (platform) => {
        setCmdReadonlyHostForTest({ platform, env: {} });
        for (const command of ["head -n 5 /workspace/notes.txt", `rm -f ${memoryRoot}/old.md`]) {
          expect(
            decide("Bash", { command }, registeredTools, LEGACY_SHELL_SELECTION),
          ).toMatchObject({ allowed: true });
        }
      },
    );
  });
});

const POSIX_SELECTION: ExecutionShellSelection = {
  dialect: "posix",
  display: { name: "bash" },
  path: "/bin/bash",
  source: "auto-detected",
};
const GIT_BASH_SELECTION: ExecutionShellSelection = {
  dialect: "git-bash",
  display: { name: "Git Bash" },
  path: "C:/Program Files/Git/bin/bash.exe",
  source: "auto-detected",
};
const WINDOWS_CMD_PATH = String.raw`C:\Windows\System32\cmd.exe`;
const WINDOWS_CMD_HOST = {
  platform: "win32",
  env: { ComSpec: WINDOWS_CMD_PATH, SystemRoot: String.raw`C:\Windows`, PATH: "" },
  realpath: (path: string) => path,
};
const CMD_SELECTION: ExecutionShellSelection = {
  dialect: "cmd",
  display: { name: "CMD" },
  id: "cmd",
  path: WINDOWS_CMD_PATH,
  source: "user-config",
};
const LEGACY_SHELL_SELECTION: ExecutionShellSelection = {
  dialect: "legacy-shell",
  display: { name: "system shell" },
  source: "legacy-fallback",
};

const noBatchNoticeRegistry = { get: () => undefined };

function messageEntries(messages: readonly ModelInputMessage[]): RuntimeMessageEntry[] {
  return messages.map((message) => ({ message }));
}

function messagesOf(entries: readonly RuntimeMessageEntry[]): ModelInputMessage[] {
  return entries.flatMap((entry) => (isRuntimeAttachmentEntry(entry) ? [] : [entry.message]));
}

/** 循环机制测试用：entries 原样作为请求消息；与 Main 渲染器的一致性在 runtime 测试里覆盖。 */
function passthroughRender(tools: readonly ModelToolContract[]) {
  return (entries: readonly RuntimeMessageEntry[]) => ({
    messages: entries.map((entry) =>
      isRuntimeAttachmentEntry(entry)
        ? { role: "user" as const, content: entry.content }
        : entry.message,
    ),
    tools: tools as ModelToolContract[],
    toolSearchEnabled: false,
  });
}

function decide(
  name: string,
  input: unknown,
  tools: readonly ModelToolContract[],
  bashShellSelection?: ExecutionShellSelection,
) {
  return evaluateMemoryAgentToolPolicy({
    bashShellSelection,
    rootDir: memoryRoot,
    toolCall: { id: "call", name, input },
    tools,
    workingDirectory: "/workspace",
    workspaceRoot: "/workspace",
  });
}

function tool(
  name: string,
  readOnly: boolean,
  sideEffectScope: ModelToolContract["sideEffectScope"],
): ModelToolContract {
  return {
    name,
    inputSchema: { type: "object" },
    readOnly,
    sideEffectScope,
  };
}

function generateOnlyModel(
  generateText: (request: ModelRequest) => Promise<ModelResult>,
  properties: Partial<Model["properties"]> = {},
): Model {
  return {
    ...modelSelection,
    properties: {
      requiresMfjsToolSchema: false,
      contextWindow: 200_000,
      inputFormat: createTestInputFormat(),
      outputFormat: { supportsText: true },
      supportsToolCall: true,
      supportsJsonSchemaOutput: true,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: true,
      ...properties,
    },
    optionSpecs: {
      reasoningLevel: { values: ["low", "high"] },
      maxOutputTokens: { max: 32_000 },
    },
    options: { maxOutputTokens: 32_000, reasoningLevel: "high" },
    bind() {
      return this;
    },
    generateText,
    streamText() {
      throw new Error("memory agent loop must not stream");
    },
  };
}

function modelResult(
  input: Pick<Partial<ModelResult>, "reasoning" | "text" | "toolCalls">,
): ModelResult {
  return {
    finishReason: input.toolCalls?.length ? "tool_calls" : "stop",
    model: modelSelection,
    text: input.text ?? "",
    toolCalls: input.toolCalls,
    reasoning: input.reasoning,
    usage: {},
  };
}

function executionResult(
  toolCallId: string,
  toolName: string,
  output: unknown,
): ToolExecutionResult {
  const now = new Date();
  return {
    completedAt: now,
    durationMs: 0,
    output,
    startedAt: now,
    success: true,
    toolCallId,
    toolName,
  };
}
