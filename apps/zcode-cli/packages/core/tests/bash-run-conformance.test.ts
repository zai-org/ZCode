import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { type BashOutput, type ExecutionRequest, type ExecutionPort } from "@zcode/contracts";
import { NodeExecutionAdapter } from "../../adapters/src/exec/index.js";
import { bashHandler, bashToolEntry } from "../src/tool/handlers/bash.js";
import type { ToolExecutionContext } from "../src/tool/types.js";

let testRoot = "";

type BashBackgroundLifecycleExecutionPort = ExecutionPort & {
  runBashWithBackgroundLifecycle?: (
    request: ExecutionRequest,
    lifecycle: { mode: "explicit" | "auto_on_timeout" },
    options?: unknown,
  ) => Promise<unknown>;
  waitForBackgroundTask?: (taskId: string, options?: unknown) => Promise<unknown>;
};

function createContext(
  options: {
    agentId?: string;
    onToolJsxUpdate?: (event: unknown) => void;
    toolUseId?: string;
  } = {},
  executionPort: ExecutionPort,
): ToolExecutionContext {
  return {
    toolCallId: options.toolUseId ?? "toolu_bash_test",
    traceId: "trace_bash_conformance" as never,
    spanId: options.agentId ?? "span_bash_conformance",
    abortSignal: new AbortController().signal,
    executionPort,
    workingDirectory: testRoot,
    workspaceRoot: testRoot,
    runtimeScope: options.agentId ? "subagent" : "main",
    sessionId: "sess_bash_conformance" as never,
    turnId: "turn_bash_conformance" as never,
    emitEvent: async (event) => {
      options.onToolJsxUpdate?.(event);
    },
  };
}

test.skipIf(process.platform === "win32")(
  "zcode-cli Bash explicit background survives timeout and parent abort with a real process",
  {
    // 测试基建修复：该用例会启动并回收真实子进程；全量 Turbo 并发会放大进程调度延迟，
    // 不能复用 Vitest 默认 5 秒预算，否则功能已完成时仍可能被测试框架先行超时。
    timeout: 15_000,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bash-lifecycle-conformance-"));
    const executionPort = new NodeExecutionAdapter({ outputRootDir: root });
    const parentTurn = new AbortController();
    testRoot = root;

    try {
      const output = (await bashHandler(
        {
          command: "printf 'started'; sleep 0.08; printf 'completed'",
          run_in_background: true,
          timeout: 5,
        },
        {
          ...createContext({}, executionPort),
          abortSignal: parentTurn.signal,
          toolCallId: "toolu_explicit_lifecycle_conformance",
        },
      )) as BashOutput;

      expect(output.status).toBe("backgrounded");
      expect(output.backgroundTaskId).toMatch(/^exec_/u);
      parentTurn.abort();
      const snapshot = await executionPort.waitForBackgroundTask(output.backgroundTaskId!);
      expect(snapshot?.status).toBe("completed");
      expect(snapshot?.result?.stdout.text).toBe("startedcompleted");
    } finally {
      await executionPort.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "zcode-cli Bash explicit background logs the real child pid with toolCallId",
  { timeout: 15_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bash-process-log-conformance-"));
    const executionPort = new NodeExecutionAdapter({ outputRootDir: root });
    const entries: Array<{ message: string; context: Record<string, unknown> }> = [];
    const logger = {
      debug() {},
      info(message: string, context?: Record<string, unknown>) {
        entries.push({ message, context: context ?? {} });
      },
      warn() {},
      error() {},
      child() {
        return logger;
      },
    } as unknown as NonNullable<ToolExecutionContext["logger"]>;
    testRoot = root;

    try {
      const output = (await bashHandler(
        { command: "sleep 0.05", run_in_background: true },
        {
          ...createContext({}, executionPort),
          logger,
          toolCallId: "toolu_explicit_process_log",
        },
      )) as BashOutput;

      expect(output.status).toBe("backgrounded");
      const snapshot = await executionPort.waitForBackgroundTask(output.backgroundTaskId!);
      const started = entries.filter(
        (entry) => entry.context.event === "tool.bash.process.started",
      );
      // 真实 adapter 在 explicit 模式下不转发 started，启动日志必须由 handler 用 task.pid 补写。
      expect(started).toHaveLength(1);
      expect(started[0]?.context).toMatchObject({
        runInBackground: true,
        toolCallId: "toolu_explicit_process_log",
      });
      expect(started[0]?.context.pid).toEqual(expect.any(Number));
      expect(started[0]?.context.pid).toBe(snapshot?.pid);
    } finally {
      await executionPort.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "zcode-cli Bash keeps first-token sleep on the hard-timeout foreground path",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bash-sleep-timeout-conformance-"));
    const executionPort = new NodeExecutionAdapter({ outputRootDir: root });
    testRoot = root;

    try {
      const output = (await bashHandler(
        {
          command: "sleep 0.2; printf 'unexpected'",
          timeout: 10,
        },
        {
          ...createContext({}, executionPort),
          toolCallId: "toolu_sleep_timeout_conformance",
        },
      )) as BashOutput;

      expect(output.status).toBe("timed_out");
      expect(output.timedOut).toBe(true);
      expect(output.backgroundTaskId).toBeUndefined();
      expect(output.stdout).not.toContain("unexpected");
    } finally {
      await executionPort.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("zcode-cli Bash handler auto-backgrounds eligible foreground commands on timeout", async () => {
  testRoot = "/repo";
  let runBashWithBackgroundLifecycleCalled = false;
  const executionPort = {
    async run() {
      return {
        cancelled: false,
        completedAt: new Date(),
        durationMs: 10,
        error: {
          message: "Execution timed out after 10ms",
          type: "timeout" as const,
        },
        startedAt: new Date(),
        status: "timed_out" as const,
        stderr: {
          bytes: 0,
          text: "",
          truncated: false,
        },
        stdout: {
          bytes: 0,
          text: "",
          truncated: false,
        },
        timedOut: true,
      };
    },
    async runBashWithBackgroundLifecycle() {
      runBashWithBackgroundLifecycleCalled = true;
      return {
        kind: "backgrounded" as const,
        task: {
          outputPath: "/tmp/zcode-bash-output.log",
          startedAt: new Date(),
          status: "running" as const,
          taskId: "exec_auto_background",
        },
      };
    },
  } as ExecutionPort & {
    runBashWithBackgroundLifecycle?: (
      request: ExecutionRequest,
      lifecycle: { mode: "explicit" | "auto_on_timeout" },
      options?: unknown,
    ) => Promise<{
      kind: "backgrounded";
      task: {
        outputPath: string;
        startedAt: Date;
        status: "running";
        taskId: string;
      };
    }>;
  };

  const output = (await bashHandler(
    { command: "npm test", timeout: 10 },
    createContext({}, executionPort),
  )) as BashOutput;

  expect(runBashWithBackgroundLifecycleCalled).toBe(true);
  expect(output.status).toBe("backgrounded");
  expect(output.backgroundTaskId).toBe("exec_auto_background");
  expect(output.assistantAutoBackgrounded).toBeUndefined();
  expect(output.backgroundedByUser).toBeUndefined();
  expect(output.persistedOutputPath).toBe("/tmp/zcode-bash-output.log");
});

test("zcode-cli Bash handler does not auto-background sleep commands on timeout", async () => {
  testRoot = "/repo";
  let runCalled = false;
  let runBashWithBackgroundLifecycleCalled = false;
  const executionPort = {
    async run() {
      runCalled = true;
      return {
        cancelled: false,
        completedAt: new Date(),
        durationMs: 1,
        exitCode: 0,
        startedAt: new Date(),
        status: "completed" as const,
        stderr: {
          bytes: 0,
          text: "",
          truncated: false,
        },
        stdout: {
          bytes: 0,
          text: "",
          truncated: false,
        },
        timedOut: false,
      };
    },
    async runBashWithBackgroundLifecycle() {
      runBashWithBackgroundLifecycleCalled = true;
      throw new Error("sleep should not use auto-background");
    },
  } as ExecutionPort & {
    runBashWithBackgroundLifecycle?: (
      request: ExecutionRequest,
      lifecycle: { mode: "explicit" | "auto_on_timeout" },
      options?: unknown,
    ) => Promise<unknown>;
  };

  const output = (await bashHandler(
    { command: "sleep 999", timeout: 10 },
    createContext({}, executionPort),
  )) as BashOutput;

  expect(runCalled).toBe(true);
  expect(runBashWithBackgroundLifecycleCalled).toBe(false);
  expect(output.status).toBe("completed");
});

test("zcode-cli Bash handler auto-backgrounds assignment-prefixed sleep commands on timeout", async () => {
  testRoot = "/repo";
  let runCalled = false;
  let runBashWithBackgroundLifecycleCalled = false;
  const executionPort = {
    async run() {
      runCalled = true;
      return {
        cancelled: false,
        completedAt: new Date(),
        durationMs: 1,
        exitCode: 0,
        startedAt: new Date(),
        status: "completed" as const,
        stderr: {
          bytes: 0,
          text: "",
          truncated: false,
        },
        stdout: {
          bytes: 0,
          text: "",
          truncated: false,
        },
        timedOut: false,
      };
    },
    async runBashWithBackgroundLifecycle() {
      runBashWithBackgroundLifecycleCalled = true;
      return {
        kind: "backgrounded" as const,
        task: {
          outputPath: "/tmp/zcode-bash-output.log",
          startedAt: new Date(),
          status: "running" as const,
          taskId: "exec_assignment_sleep",
        },
      };
    },
  } as ExecutionPort & {
    runBashWithBackgroundLifecycle?: (
      request: ExecutionRequest,
      lifecycle: { mode: "explicit" | "auto_on_timeout" },
      options?: unknown,
    ) => Promise<{
      kind: "backgrounded";
      task: {
        outputPath: string;
        startedAt: Date;
        status: "running";
        taskId: string;
      };
    }>;
  };

  const output = (await bashHandler(
    { command: "FOO=1 sleep 999", timeout: 10 },
    createContext({}, executionPort),
  )) as BashOutput;

  expect(runCalled).toBe(false);
  expect(runBashWithBackgroundLifecycleCalled).toBe(true);
  expect(output.status).toBe("backgrounded");
  expect(output.backgroundTaskId).toBe("exec_assignment_sleep");
});

test("zcode-cli Bash does not duplicate production cwd reset stderr", async () => {
  testRoot = "/repo";
  const executionPort: ExecutionPort = {
    async run() {
      return {
        cancelled: false,
        durationMs: 1,
        exitCode: 0,
        stderr: {
          artifactBytes: undefined,
          artifactPath: undefined,
          bytes: 0,
          text: "",
          truncated: false,
        },
        stdout: {
          artifactBytes: undefined,
          artifactPath: undefined,
          bytes: 5,
          text: "left\n",
          truncated: false,
        },
        status: "completed",
        timedOut: false,
        resolvedCwd: "/tmp/outside",
      };
    },
  };

  const output = (await bashHandler(
    { command: "cd /tmp/outside && echo left" },
    createContext({}, executionPort),
  )) as BashOutput;
  const content = String(bashToolEntry.formatModelContent?.(output));

  expect(content.match(/Shell cwd was reset to /g)).toHaveLength(1);
});
