import { describe, expect, it } from "vitest";
import {
  parseImageDataUrl,
  type BashInput,
  type BashOutput,
  type ExecutionPort,
  type ExecutionResult,
  type ModelMessageContent,
  type ToolArtifactReadRequest,
  type ToolArtifactStorePort,
  type ToolArtifactWriteRequest,
} from "@zcode/contracts";
import { bashHandler, bashToolEntry } from "../src/tool/handlers/bash.js";
import { formatBashTimeoutDuration } from "../src/tool/handlers/bash-output.js";
import { isErrorForToolResult } from "../src/runtime/helpers/tool-result.js";
import { formatPersistedOutputEnvelope } from "../src/tool/result-persistence-format.js";
import { serializeOutput } from "../src/tool/executor/result-serialization.js";
import type { ToolExecutorDeps } from "../src/tool/executor/types.js";
import type { ToolExecutionContext } from "../src/tool/types.js";

const GH_RATE_LIMIT_HINT =
  "<system-reminder>GitHub API rate limit exceeded (5,000/hr shared across all tools and agents). Run `gh api rate_limit --jq .resources` and sleep until reset before further gh calls. If polling in a loop, use ScheduleWakeup instead of retrying.</system-reminder>";
const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

describe("Bash result mapping", () => {
  it("parses image data URIs through the shared media helper", () => {
    const parsed = parseImageDataUrl(` data:image/PNG;base64,${PNG_1X1_BASE64} `);

    expect(parsed?.mediaType).toBe("image/png");
    expect(parsed?.base64).toBe(PNG_1X1_BASE64);
    expect(parsed?.dataUrl).toBe(`data:image/png;base64,${PNG_1X1_BASE64}`);
    expect(Buffer.from(parsed?.data ?? []).byteLength).toBeGreaterThan(0);
    expect(parseImageDataUrl("data:text/plain;base64,aaaa")).toBeUndefined();
    expect(parseImageDataUrl("data:image/png;base64,abcde")).toBeUndefined();
  });

  it("formats persisted-output envelopes with caller supplied byte style", () => {
    expect(
      formatPersistedOutputEnvelope({
        content: `${"a".repeat(1_200)}\n${"b".repeat(1_200)}`,
        formatBytes: (bytes) => `fmt:${bytes}`,
        originalBytes: 4_096,
        persistedPath: "/tmp/stdout.log",
        previewChars: 2_000,
      }),
    ).toBe(
      [
        "<persisted-output>",
        "Output too large (fmt:4096). Full output saved to: /tmp/stdout.log",
        "",
        "Preview (first fmt:2000):",
        "a".repeat(1_200),
        "...",
        "</persisted-output>",
      ].join("\n"),
    );
  });

  it("returns structuredContent before image, text, stderr, background, and hints", () => {
    const structuredContent = [{ type: "text", text: "structured result" }];

    expect(
      formatModelContent(
        bashOutput({
          stdout: `data:image/png;base64,${PNG_1X1_BASE64}`,
          stderr: "stderr should be ignored",
          isImage: true,
          backgroundTaskId: "exec_bg",
          structuredContent,
          staleReadFileStateHint: "stale hint should be ignored",
          ghRateLimitHint: GH_RATE_LIMIT_HINT,
        }),
      ),
    ).toEqual(structuredContent);
  });

  it("formats stdout, stderr, stale read hints, and gh rate-limit hints as ordered text", () => {
    expect(
      formatText(
        bashOutput({
          stdout: "\n\n  hello\n\n",
          stderr: "  warn\n",
          staleReadFileStateHint:
            "[This command modified 1 file you've previously read: a.ts. Call Read before editing.]",
          ghRateLimitHint: GH_RATE_LIMIT_HINT,
        }),
      ),
    ).toBe(
      [
        "  hello",
        "warn",
        "[This command modified 1 file you've previously read: a.ts. Call Read before editing.]",
        GH_RATE_LIMIT_HINT,
      ].join("\n"),
    );
  });

  it("formats interrupted Bash results with the aborted error tag", () => {
    expect(
      formatText(
        bashOutput({
          stdout: "partial\n",
          stderr: "stderr\n",
          interrupted: true,
          status: "cancelled",
        }),
      ),
    ).toBe("partial\nstderr\n<error>Command was aborted before completion</error>");
  });

  it.each([
    ["no output", "", "Exit code 143\nCommand timed out after 1s"],
    // 输出开头的空行保留，只去掉末尾空白。
    ["captured output", "\n\npartial\n", "Exit code 143\nCommand timed out after 1s\n\n\npartial"],
  ])(
    "formats a hard timeout with %s as a failure without the aborted tag",
    async (_name, stdout, expected) => {
      let requestedTimeoutMs: number | undefined;
      const executionPort: ExecutionPort = {
        async run(request) {
          requestedTimeoutMs = request.timeoutMs;
          return executionResult({
            status: "timed_out",
            stdout,
            exitCode: 143,
            timedOut: true,
            // adapter 的通用文案；模型看到的超时行由 Bash 投影按实际生效的超时重新格式化。
            error: { type: "timeout", message: "Command timed out after 1.5s" },
          });
        },
      };

      const output = (await bashHandler(
        { command: "sleep 3", timeout: 1500 } satisfies BashInput,
        contextWith(executionPort),
      )) as BashOutput;

      expect(requestedTimeoutMs).toBe(1500);
      expect(formatText(output)).toBe(expected);
      expect(
        isErrorForToolResult({ success: true, output, toolCallId: "tool_bash", toolName: "Bash" }),
      ).toBe(true);
    },
  );

  it("keeps the leading blank lines of failed output", async () => {
    const executionPort: ExecutionPort = {
      async run() {
        return executionResult({ status: "failed", stdout: "\n\nboom\n", exitCode: 7 });
      },
    };

    const output = (await bashHandler(
      { command: "printf '\\n\\nboom\\n'; exit 7" } satisfies BashInput,
      contextWith(executionPort),
    )) as BashOutput;

    expect(formatText(output)).toBe("Exit code 7\n\n\nboom");
  });

  it.each([
    [0, "0s"],
    [0.5, "0.0s"],
    [50, "0s"],
    [1000, "1s"],
    [1500, "1s"],
    [59_999, "59s"],
    [60_000, "1m 0s"],
    [90_000, "1m 30s"],
    [90_500, "1m 31s"],
    [120_000, "2m 0s"],
    [600_000, "10m 0s"],
    [3_599_500, "1h 0m 0s"],
    [3_600_000, "1h 0m 0s"],
    [86_400_000, "1d 0h 0m"],
    [90_061_000, "1d 1h 1m"],
  ])("formats a %d ms Bash timeout as %s", (timeoutMs, expected) => {
    expect(formatBashTimeoutDuration(timeoutMs)).toBe(expected);
  });

  it("keeps the zcode generic no-output placeholder for empty Bash output", async () => {
    const emptyBashContent = "(Bash completed with no output)";
    const result = await serializeOutput(
      minimalToolExecutorDeps(),
      bashOutput(),
      bashToolEntry,
      {},
      "tool_bash",
      new AbortController().signal,
    );

    expect(result.content).toBe(emptyBashContent);
    expect(result.modelContent).toBe(emptyBashContent);
    expect(result.originalBytes).toBe(0);
    expect(result.returnedBytes).toBe(Buffer.byteLength(emptyBashContent, "utf8"));
  });

  it("formats persisted foreground output with the 2KB preview envelope", () => {
    const preview = "a".repeat(1_200);
    const stdout = `${preview}\n${"b".repeat(1_200)}`;

    expect(
      formatText(
        bashOutput({
          stdout,
          persistedOutputPath: "/tmp/stdout.log",
          persistedOutputSize: 4_096,
        }),
      ),
    ).toBe(
      [
        "<persisted-output>",
        "Output too large (4KB). Full output saved to: /tmp/stdout.log",
        "",
        "Preview (first 2KB):",
        preview,
        "...",
        "</persisted-output>",
      ].join("\n"),
    );
  });

  it("uses Bash persisted-output projection when serializer persists a large Bash result", async () => {
    const stdout = "x".repeat(30_001);
    const artifactStore = new RecordingArtifactStore();

    const result = await serializeOutput(
      {
        ...minimalToolExecutorDeps(),
        artifactStore,
      },
      bashOutput({
        stdout,
        stdoutBytes: Buffer.byteLength(stdout, "utf8"),
        stderrBytes: 0,
      }),
      bashToolEntry,
      {},
      "tool_bash",
      new AbortController().signal,
    );

    expect(artifactStore.requests).toHaveLength(1);
    expect(result.content).toContain("<persisted-output>");
    expect(result.content).toContain(
      "Output too large (29.3KB). Full output saved to: /artifacts/artifact-1.json",
    );
    expect(result.content).toContain(`Preview (first 2KB):\n${"x".repeat(2_000)}`);
    expect(result.modelContent).toBe(result.content);
  });

  it("does not rehydrate oversized stderr after serializer persists a Bash result", async () => {
    const stderr = "E".repeat(30_001);
    const artifactStore = new RecordingArtifactStore();

    const result = await serializeOutput(
      {
        ...minimalToolExecutorDeps(),
        artifactStore,
      },
      bashOutput({
        stderr,
        stdoutBytes: 0,
        stderrBytes: Buffer.byteLength(stderr, "utf8"),
      }),
      bashToolEntry,
      {},
      "tool_bash",
      new AbortController().signal,
    );

    expect(artifactStore.requests).toHaveLength(1);
    expect(result.content).toContain(
      "Output too large (29.3KB). Full output saved to: /artifacts/artifact-1.json",
    );
    expect(result.content).toContain(`Preview (first 2KB):\n${"E".repeat(2_000)}`);
    expect(result.content.match(/E/g)).toHaveLength(2_000);
    expect(result.returnedBytes).toBeLessThan(2_200);
    expect(result.modelContent).toBe(result.content);
  });

  it("keeps the head and tail of large failed Bash output inline", async () => {
    const stdout = `${"H".repeat(6_000)}${"M".repeat(18_000)}${"T".repeat(6_001)}`;
    const artifactStore = new RecordingArtifactStore();

    const result = await serializeOutput(
      {
        ...minimalToolExecutorDeps(),
        artifactStore,
      },
      bashOutput({
        exitCode: 2,
        status: "failed",
        stderr: "bad command",
        stdout,
        stdoutBytes: Buffer.byteLength(stdout, "utf8"),
        stderrBytes: Buffer.byteLength("bad command", "utf8"),
      }),
      bashToolEntry,
      {},
      "tool_bash",
      new AbortController().signal,
    );

    // 失败命令不落盘：完整文本超过 1 万 + 1024 字符时，保留头尾各 5000 字符，中间写明截掉的字符数。
    const full = `Exit code 2\n${stdout}\nbad command`;
    expect(artifactStore.requests).toHaveLength(0);
    expect(result.content).toBe(
      `${full.slice(0, 5_000)}\n\n... [${full.length - 10_000} characters truncated] ...\n\n${full.slice(-5_000)}`,
    );
    expect(result.modelContent).toBe(result.content);
  });

  it.each([10_500, 20_000])(
    "keeps a failed Bash output of %i CJK characters inline instead of persisting it",
    async (length) => {
      const stdout = "错".repeat(length);
      const artifactStore = new RecordingArtifactStore();

      const result = await serializeOutput(
        { ...minimalToolExecutorDeps(), artifactStore },
        bashOutput({ exitCode: 1, status: "failed", stdout }),
        bashToolEntry,
        {},
        "tool_bash",
        new AbortController().signal,
      );

      // 失败正文已按字符保留头尾；多字节文本超过 30000 字节也不能再被落盘成 2KB 开头预览。
      const full = `Exit code 1\n${stdout}`;
      const expected =
        full.length <= 11_024
          ? full
          : `${full.slice(0, 5_000)}\n\n... [${full.length - 10_000} characters truncated] ...\n\n${full.slice(-5_000)}`;
      expect(Buffer.byteLength(expected, "utf8")).toBeGreaterThan(30_000);
      expect(artifactStore.requests).toHaveLength(0);
      expect(result.content).toBe(expected);
      expect(result.content).not.toContain("<persisted-output>");
      expect(result.truncated).toBe(false);
      expect(result.modelContent).toBe(result.content);
    },
  );

  it("still persists a successful CJK Bash output over the byte budget", async () => {
    const stdout = "错".repeat(10_500);
    const artifactStore = new RecordingArtifactStore();

    const result = await serializeOutput(
      { ...minimalToolExecutorDeps(), artifactStore },
      bashOutput({ stdout }),
      bashToolEntry,
      {},
      "tool_bash",
      new AbortController().signal,
    );

    expect(artifactStore.requests).toHaveLength(1);
    expect(result.content).toContain("<persisted-output>");
  });

  it("keeps the byte budget for a failed Bash result that returns structuredContent", async () => {
    const artifactStore = new RecordingArtifactStore();

    const result = await serializeOutput(
      { ...minimalToolExecutorDeps(), artifactStore },
      bashOutput({
        exitCode: 1,
        status: "failed",
        structuredContent: [{ type: "text", text: "structured".repeat(10_000) }],
      }),
      bashToolEntry,
      {},
      "tool_bash",
      new AbortController().signal,
    );

    // structuredContent 不经过失败正文的头尾截断，没有字符上限，仍按字节预算落盘。
    expect(artifactStore.requests).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it("shows failed Bash output in full up to the truncation slack", () => {
    const stdout = "x".repeat(11_000);
    expect(formatText(bashOutput({ exitCode: 1, status: "failed", stdout }))).toBe(
      `Exit code 1\n${stdout}`,
    );
  });

  it("uses the inline output of an adapter-persisted failure instead of the saved-file preview", () => {
    const stdout = "y".repeat(30_000);
    const text = formatText(
      bashOutput({
        exitCode: 1,
        status: "failed",
        stdout,
        persistedOutputPath: "/tmp/exec_fail.output",
        persistedOutputSize: 90_000,
      }),
    );
    expect(text).not.toContain("<persisted-output>");
    expect(text).toBe(
      `Exit code 1\n${"y".repeat(4_988)}\n\n... [20012 characters truncated] ...\n\n${"y".repeat(5_000)}`,
    );
  });

  it("names the timeout when a foreground command is moved to the background", () => {
    expect(
      formatText(
        bashOutput({
          status: "backgrounded",
          backgroundTaskId: "exec_bg",
          persistedOutputPath: "/tmp/exec_bg.output",
          timedOutAfterMs: 120_000,
        }),
      ),
    ).toBe(
      "Command did not complete within its 120s timeout and was moved to the background (ID: exec_bg). Output is being written to: /tmp/exec_bg.output. You will be notified when it completes. To check interim output, use Read on that file path.",
    );
  });

  it("appends the session cwd note after the background text", () => {
    const note =
      "Session cwd remains /work/repo; directory changes made by the backgrounded command do not apply to subsequent commands.";
    expect(
      formatText(
        bashOutput({
          status: "backgrounded",
          backgroundTaskId: "exec_bg",
          persistedOutputPath: "/tmp/exec_bg.output",
          backgroundSessionCwd: "/work/repo",
        }),
      ),
    ).toBe(
      `Command running in background with ID: exec_bg. Output is being written to: /tmp/exec_bg.output. You will be notified when it completes. To check interim output, use Read on that file path.\n${note}`,
    );
    expect(
      formatText(
        bashOutput({
          status: "backgrounded",
          backgroundTaskId: "exec_bg",
          persistedOutputPath: "/tmp/exec_bg.output",
          timedOutAfterMs: 120_000,
          backgroundSessionCwd: "/work/repo",
        }),
      ),
    ).toBe(
      `Command did not complete within its 120s timeout and was moved to the background (ID: exec_bg). Output is being written to: /tmp/exec_bg.output. You will be notified when it completes. To check interim output, use Read on that file path.\n${note}`,
    );
  });

  it("tells a synchronous subagent that no notification follows its final response", () => {
    const sync =
      "If it exits while you are still working you will be notified, but it is terminated when you give your final response and no notification can follow that \u2014 so do not end your turn to wait for it; if you need its result, wait for it before giving your final response.";
    expect(
      formatText(
        bashOutput({
          status: "backgrounded",
          backgroundTaskId: "exec_bg",
          persistedOutputPath: "/tmp/exec_bg.output",
          backgroundInSyncSubagent: true,
        }),
      ),
    ).toBe(
      `Command running in background with ID: exec_bg. Output is being written to: /tmp/exec_bg.output. ${sync} To check interim output, use Read on that file path.`,
    );
    expect(
      formatText(
        bashOutput({
          status: "backgrounded",
          backgroundTaskId: "exec_bg",
          persistedOutputPath: "/tmp/exec_bg.output",
          timedOutAfterMs: 120_000,
          backgroundInSyncSubagent: true,
          backgroundSessionCwd: "/work/repo",
        }),
      ),
    ).toBe(
      `Command did not complete within its 120s timeout and was moved to the background (ID: exec_bg). Output is being written to: /tmp/exec_bg.output. ${sync} To check interim output, use Read on that file path.\nSession cwd remains /work/repo; directory changes made by the backgrounded command do not apply to subsequent commands.`,
    );
  });

  it("does not rehydrate structuredContent after serializer persists a large Bash result", async () => {
    const largeStructuredText = "structured".repeat(10_000);
    const artifactStore = new RecordingArtifactStore();

    const result = await serializeOutput(
      {
        ...minimalToolExecutorDeps(),
        artifactStore,
      },
      bashOutput({
        structuredContent: [{ type: "text", text: largeStructuredText }],
      }),
      bashToolEntry,
      {},
      "tool_bash",
      new AbortController().signal,
    );

    expect(artifactStore.requests).toHaveLength(1);
    expect(result.content).toContain("<persisted-output>");
    expect(result.content).not.toContain(largeStructuredText);
    expect(result.modelContent).toBe(result.content);
  });

  it("formats background results with background wording and without persisted-output envelopes", () => {
    expect(
      formatText(
        bashOutput({
          status: "backgrounded",
          backgroundTaskId: "exec_bg",
          persistedOutputPath: "/tmp/exec_bg.output",
        }),
      ),
    ).toBe(
      "Command running in background with ID: exec_bg. Output is being written to: /tmp/exec_bg.output. You will be notified when it completes. To check interim output, use Read on that file path.",
    );

    expect(
      formatText(
        bashOutput({
          status: "backgrounded",
          backgroundTaskId: "exec_bg",
          backgroundedByUser: true,
          persistedOutputPath: "/tmp/exec_bg.output",
        }),
      ),
    ).toBe(
      "Command was manually backgrounded by user with ID: exec_bg. Output is being written to: /tmp/exec_bg.output",
    );

    expect(
      formatText(
        bashOutput({
          status: "backgrounded",
          backgroundTaskId: "exec_bg",
          assistantAutoBackgrounded: true,
          persistedOutputPath: "/tmp/exec_bg.output",
        }),
      ),
    ).toBe(
      "Command exceeded the assistant-mode blocking budget (15s) and was moved to the background with ID: exec_bg. It is still running \u2014 you will be notified when it completes. Output is being written to: /tmp/exec_bg.output. In assistant mode, delegate long-running work to a subagent or use run_in_background to keep this conversation responsive.",
    );
  });

  it("returns image content only for recognized data image output and falls back otherwise", () => {
    const dataUrl = `data:image/png;base64,${PNG_1X1_BASE64}`;

    expect(
      formatModelContent(
        bashOutput({
          stdout: dataUrl,
          isImage: true,
        }),
      ),
    ).toEqual([
      {
        type: "image",
        mediaType: "image/png",
        dataUrl,
      },
    ]);

    expect(
      formatText(
        bashOutput({
          stdout: "data:image/png;base64,not-base64-image",
          isImage: true,
        }),
      ),
    ).toBe("data:image/png;base64,not-base64-image");
  });

  it("does not add gh rate-limit hints to failed provider-error Bash output", async () => {
    const executionPort: ExecutionPort = {
      async run() {
        return executionResult({
          status: "failed",
          stderr: "API rate limit exceeded for user",
        });
      },
    };

    const output = (await bashHandler(
      { command: "gh pr view 123" } satisfies BashInput,
      contextWith(executionPort),
    )) as BashOutput;

    expect(output.ghRateLimitHint).toBeUndefined();
    expect(formatText(output)).not.toContain(GH_RATE_LIMIT_HINT);
  });

  it("adds the gh rate-limit hint from successful stdout", async () => {
    const executionPort: ExecutionPort = {
      async run() {
        return executionResult({
          status: "completed",
          stdout: "API rate limit exceeded for user",
        });
      },
    };

    const output = (await bashHandler(
      { command: "gh pr view 123" } satisfies BashInput,
      contextWith(executionPort),
    )) as BashOutput;

    expect(output.ghRateLimitHint).toBe(GH_RATE_LIMIT_HINT);
    expect(formatText(output)).toContain(GH_RATE_LIMIT_HINT);
  });
});

function formatModelContent(output: BashOutput): ModelMessageContent {
  const content = bashToolEntry.formatModelContent?.(output);
  expect(content).toBeDefined();
  return content as ModelMessageContent;
}

function formatText(output: BashOutput): string {
  const content = formatModelContent(output);
  expect(typeof content).toBe("string");
  return content as string;
}

function bashOutput(output: Partial<BashOutput> = {}): BashOutput {
  return {
    stdout: "",
    stderr: "",
    interrupted: false,
    status: "completed",
    ...output,
  };
}

function contextWith(executionPort: ExecutionPort): ToolExecutionContext {
  return {
    toolCallId: "tool_bash",
    traceId: "trace_bash",
    spanId: "span_bash",
    abortSignal: new AbortController().signal,
    executionPort,
    workingDirectory: "/tmp",
    workspaceRoot: "/tmp",
    sessionId: "sess_bash",
    turnId: "turn_bash",
  };
}

function executionResult(options: {
  status: ExecutionResult["status"];
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  timedOut?: boolean;
  error?: ExecutionResult["error"];
}): ExecutionResult {
  const now = new Date();
  return {
    status: options.status,
    stdout: {
      text: options.stdout ?? "",
      bytes: Buffer.byteLength(options.stdout ?? "", "utf8"),
      truncated: false,
    },
    stderr: {
      text: options.stderr ?? "",
      bytes: Buffer.byteLength(options.stderr ?? "", "utf8"),
      truncated: false,
    },
    durationMs: 1,
    timedOut: options.timedOut ?? false,
    cancelled: false,
    startedAt: now,
    completedAt: now,
    ...(options.exitCode !== undefined ? { exitCode: options.exitCode } : {}),
    ...(options.error ? { error: options.error } : {}),
  };
}

function minimalToolExecutorDeps(): ToolExecutorDeps {
  return {
    defaultTimeoutMs: 300_000,
    emitEvent: async () => {},
    getMode: () => "build",
    getWorkingDirectory: () => "/tmp",
    getWorkspaceRoot: () => "/tmp",
    maxConcurrency: 1,
    permissionBroker: {} as ToolExecutorDeps["permissionBroker"],
    permissionService: {} as ToolExecutorDeps["permissionService"],
    readFileState: new Map(),
    registry: {} as ToolExecutorDeps["registry"],
    sessionId: "sess_bash" as ToolExecutorDeps["sessionId"],
  };
}

class RecordingArtifactStore implements ToolArtifactStorePort {
  readonly requests: ToolArtifactWriteRequest[] = [];

  async writeToolResultArtifact(request: ToolArtifactWriteRequest) {
    this.requests.push(request);
    return {
      id: "artifact-1",
      uri: "zcode-artifact://test/artifact-1",
      path: "/artifacts/artifact-1.json",
      bytes: Buffer.byteLength(request.content, "utf8"),
      contentType: request.contentType ?? "text/plain",
      createdAt: new Date(),
    };
  }

  async readToolResultArtifact(_request: ToolArtifactReadRequest): Promise<never> {
    throw new Error("readToolResultArtifact should not be called");
  }
}
