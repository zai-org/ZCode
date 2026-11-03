import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  BashOutputSchema,
  CoreErrorType,
  SessionEventType,
  createImageProcessorError,
} from "@zcode/contracts";
import { isErrorForToolResult } from "../src/runtime/helpers/tool-result.js";
import { decideBashCwdPolicy } from "../src/tool/handlers/bash-cwd-policy.js";
import { bashHandler, bashToolEntry, createBashToolEntry } from "../src/tool/handlers/bash.js";
import type { BashBackgroundLifecycleExecutionPort } from "../src/tool/handlers/bash-background-lifecycle.js";
import { resolveTimeoutMs } from "../src/tool/executor/timeout.js";
import type {
  BashInput,
  BashOutput,
  CommandExecutionSpanWriter,
  ExecutionPort,
  ExecutionRequest,
  ExecutionResult,
  FileSystemPort,
  FileSystemReadTextResult,
  FileSystemStatResult,
  ImageProcessorPort,
  ExecutionShellSelection,
  SessionEvent,
  ToolExecutionSpanWriter,
} from "@zcode/contracts";
import { createReadFileStatePathKey } from "../src/tool/read-file-state.js";
import type { ReadFileStateMap, ToolExecutionContext } from "../src/tool/types.js";

const workspaceRoot = resolve("/work");
const projectRoot = resolve(workspaceRoot, "project");
const defaultCommandRoot = resolve("/tmp");

describe("Bash cwd policy", () => {
  it("keeps cwd when resolved cwd stays inside workspace", () => {
    expect(
      decideBashCwdPolicy({
        status: "completed",
        exitCode: 0,
        resolvedCwd: "/repo/subdir",
        workspaceRoot: "/repo",
        runtimeScope: "main",
      }),
    ).toEqual({ nextWorkingDirectory: "/repo/subdir" });
  });

  it("resets cwd and returns provider-visible stderr suffix when resolved cwd leaves workspace", () => {
    expect(
      decideBashCwdPolicy({
        status: "completed",
        exitCode: 0,
        resolvedCwd: "/tmp/outside",
        workspaceRoot: "/repo",
        runtimeScope: "main",
      }),
    ).toEqual({
      nextWorkingDirectory: "/repo",
      stderrSuffix: "Shell cwd was reset to /repo",
    });
  });

  it("does not update cwd for subagent scope", () => {
    expect(
      decideBashCwdPolicy({
        status: "completed",
        exitCode: 0,
        resolvedCwd: "/tmp/outside",
        workspaceRoot: "/repo",
        runtimeScope: "subagent",
      }),
    ).toEqual({});
  });

  it("treats macOS /private/tmp aliases as the same cwd boundary", () => {
    expect(
      decideBashCwdPolicy({
        status: "completed",
        exitCode: 0,
        resolvedCwd: "/private/tmp/repo/subdir",
        workspaceRoot: "/tmp/repo",
        runtimeScope: "main",
      }),
    ).toEqual({ nextWorkingDirectory: "/tmp/repo/subdir" });
  });

  it.skipIf(process.platform === "win32")(
    "keeps cwd when a symlink workspace resolves to a physical child path",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-bash-cwd-policy-"));
      const realRoot = join(root, "real-project");
      const linkRoot = join(root, "project-link");
      const realChild = join(realRoot, "child");

      await mkdir(realChild, { recursive: true });
      await symlink(realRoot, linkRoot, "dir");

      try {
        const physicalChild = await realpath(realChild);
        expect(
          decideBashCwdPolicy({
            status: "completed",
            exitCode: 0,
            resolvedCwd: physicalChild,
            workspaceRoot: linkRoot,
            runtimeScope: "main",
          }),
        ).toEqual({ nextWorkingDirectory: join(linkRoot, "child") });
        // 不 cd 的命令捕获到 root 的物理路径：写回 root 原样，环境公告不会报目录变化。
        expect(
          decideBashCwdPolicy({
            status: "completed",
            exitCode: 0,
            resolvedCwd: await realpath(realRoot),
            workspaceRoot: linkRoot,
            runtimeScope: "main",
          }),
        ).toEqual({ nextWorkingDirectory: linkRoot });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("handles Windows path containment case-insensitively", () => {
    expect(
      decideBashCwdPolicy({
        status: "completed",
        exitCode: 0,
        resolvedCwd: "C:\\Repo\\Subdir",
        workspaceRoot: "c:\\repo",
        platform: "win32",
        runtimeScope: "main",
      }),
    ).toEqual({ nextWorkingDirectory: "c:\\repo\\Subdir" });
  });

  it("writes cwd back in the workspace root spelling", () => {
    // 同一目录换了写法（盘符大小写、/private 别名）时写回 root 原样。
    expect(
      decideBashCwdPolicy({
        status: "completed",
        exitCode: 0,
        resolvedCwd: "C:\\Repo",
        workspaceRoot: "c:\\Repo",
        platform: "win32",
        runtimeScope: "main",
      }),
    ).toEqual({ nextWorkingDirectory: "c:\\Repo" });
    expect(
      decideBashCwdPolicy({
        status: "completed",
        exitCode: 0,
        resolvedCwd: "/tmp/repo",
        workspaceRoot: "/private/tmp/repo",
        runtimeScope: "main",
      }),
    ).toEqual({ nextWorkingDirectory: "/private/tmp/repo" });
    expect(
      decideBashCwdPolicy({
        status: "completed",
        exitCode: 0,
        resolvedCwd: "/outside",
        workspaceRoot: "/private/tmp/repo",
        runtimeScope: "main",
      }),
    ).toEqual({
      nextWorkingDirectory: "/private/tmp/repo",
      stderrSuffix: "Shell cwd was reset to /private/tmp/repo",
    });
  });

  it("reuses shared Windows tool path normalization for Git Bash cwd aliases", () => {
    expect(
      decideBashCwdPolicy({
        status: "completed",
        exitCode: 0,
        resolvedCwd: "/c/Repo/Subdir",
        workspaceRoot: "C:\\Repo",
        platform: "win32",
        runtimeScope: "main",
      }),
    ).toEqual({ nextWorkingDirectory: "C:\\Repo\\Subdir" });
  });

  it("reuses shared Windows tool path normalization for extended drive paths", () => {
    expect(
      decideBashCwdPolicy({
        status: "completed",
        exitCode: 0,
        resolvedCwd: "\\\\?\\c:\\Repo\\Subdir",
        workspaceRoot: "C:\\Repo",
        platform: "win32",
        runtimeScope: "main",
      }),
    ).toEqual({ nextWorkingDirectory: "C:\\Repo\\Subdir" });
  });

  it.skipIf(process.platform === "win32")(
    "does not infer Windows cwd semantics from POSIX /c paths",
    () => {
      expect(
        decideBashCwdPolicy({
          status: "completed",
          exitCode: 0,
          resolvedCwd: "/c/repo/subdir",
          workspaceRoot: "/c/repo",
          platform: "linux",
          runtimeScope: "main",
        }),
      ).toEqual({ nextWorkingDirectory: "/c/repo/subdir" });
    },
  );

  it.skipIf(process.platform === "win32")(
    "honors explicit POSIX cwd semantics for Windows-looking path strings",
    () => {
      expect(
        decideBashCwdPolicy({
          status: "completed",
          exitCode: 0,
          resolvedCwd: "C:\\Repo\\Subdir",
          workspaceRoot: "c:\\repo",
          platform: "linux",
          runtimeScope: "main",
        }),
      ).toEqual({
        nextWorkingDirectory: "c:\\repo",
        stderrSuffix: "Shell cwd was reset to c:\\repo",
      });
    },
  );

  it("keeps cwd for workspace child directories whose names start with dot-dot", () => {
    expect(
      decideBashCwdPolicy({
        status: "completed",
        exitCode: 0,
        resolvedCwd: "/repo/..cache",
        workspaceRoot: "/repo",
        runtimeScope: "main",
      }),
    ).toEqual({ nextWorkingDirectory: "/repo/..cache" });

    expect(
      decideBashCwdPolicy({
        status: "completed",
        exitCode: 0,
        resolvedCwd: "C:\\Repo\\..cache",
        workspaceRoot: "c:\\repo",
        platform: "win32",
        runtimeScope: "main",
      }),
    ).toEqual({ nextWorkingDirectory: "c:\\repo\\..cache" });
  });
});

describe("bashHandler", () => {
  it("把非零退出码保留为事实，只有结构化执行错误才标记 Command 失败", async () => {
    const outcomes: string[] = [];
    const telemetry = recordingBashTelemetry(outcomes);
    const nonZeroPort: ExecutionPort = {
      async run() {
        return executionResult({ status: "failed", exitCode: 1 });
      },
    };
    await bashHandler(
      { command: "grep missing file.txt" },
      contextWith(nonZeroPort, { telemetry }),
    );
    expect(outcomes).toEqual(["exit:1", "completed"]);

    outcomes.length = 0;
    const spawnErrorPort: ExecutionPort = {
      async run() {
        return executionResult({
          status: "spawn_error",
          error: { message: "spawn failed", type: "spawn_error" },
        });
      },
    };
    await bashHandler({ command: "missing-command" }, contextWith(spawnErrorPort, { telemetry }));
    expect(outcomes).toEqual(["failed:spawn"]);
  });

  it.each([
    "sqlite3 /Users/test/.zcode/v2/tasks-index.sqlite .tables",
    "cd ~/.zcode/v2 && sqlite3 tasks-index.sqlite .tables",
    'db=~/.zcode/v2/tasks-index.sqlite; sqlite3 "$db" .tables',
  ])(
    "does not present shell text matching as a task database security boundary: %s",
    async (command) => {
      let capturedRequest: ExecutionRequest | undefined;
      const executionPort: ExecutionPort = {
        async run(request) {
          capturedRequest = request;
          return executionResult({
            status: "completed",
            exitCode: 0,
          });
        },
      };

      await bashHandler({ command }, contextWith(executionPort));

      expect(capturedRequest?.command).toEqual({
        mode: "shell",
        command,
        shellProfile: "posix-bash",
      });
      expect(capturedRequest?.sandbox).not.toHaveProperty("protectedResources");
    },
  );

  it("delegates shell command, timeout, session cwd, and sandbox fields to ExecutionPort", async () => {
    let capturedRequest: ExecutionRequest | undefined;
    const executionPort: ExecutionPort = {
      async run(request) {
        capturedRequest = request;
        return executionResult({
          status: "failed",
          exitCode: 2,
          stderr: "nope",
        });
      },
    };

    const output = (await bashHandler(
      {
        command: "npm test",
        timeout: 123,
        dangerouslyDisableSandbox: true,
      } satisfies BashInput,
      contextWith(executionPort, {
        workingDirectory: projectRoot,
        workspaceRoot: projectRoot,
      }),
    )) as BashOutput;

    expect(output).toMatchObject({
      exitCode: 2,
      status: "failed",
      stderr: "nope",
    });
    expect(bashToolEntry.formatModelContent?.(output)).toBe("Exit code 2\nnope");
    expect(
      isErrorForToolResult({
        completedAt: new Date(),
        durationMs: 1,
        output,
        startedAt: new Date(),
        success: true,
        toolCallId: "toolu_bash",
        toolName: "Bash",
      }),
    ).toBe(true);

    expect(capturedRequest?.command).toEqual({
      mode: "shell",
      command: "npm test",
      shellProfile: "posix-bash",
    });
    expect(capturedRequest?.cwd).toBe(projectRoot);
    // 模型输入不带 env；handler 只设置会话上下文变量。
    expect(capturedRequest?.env).toEqual({
      set: {
        CLAUDE_CODE_SESSION_ID: "sess_test",
        CLAUDE_PROJECT_DIR: projectRoot,
        CLAUDE_SESSION_ID: "sess_test",
        ZCODE_PROJECT_DIR: projectRoot,
        ZCODE_SESSION_ID: "sess_test",
      },
    });
    expect(capturedRequest?.timeoutMs).toBe(123);
    expect(capturedRequest?.outputLimit).toEqual({
      maxInlineBytes: 30_000,
      maxBufferBytes: 30_000,
      maxPersistedBytes: 5 * 1024 * 1024 * 1024,
      persistOutput: "on_truncate",
    });
    expect(capturedRequest?.sandbox).toMatchObject({
      enabled: false,
      dangerouslyDisableSandbox: true,
    });
    expect(capturedRequest?.sandbox).not.toHaveProperty("protectedResources");
  });

  it("keeps the filesystem output-loss diagnostic in provider-visible stdout", async () => {
    const diagnostic =
      "Command output was lost: the temp filesystem at /tmp/tasks is full (9MB free). The child process's stdout/stderr writes failed with ENOSPC. Free up space on this filesystem.";
    const executionPort: ExecutionPort = {
      async run() {
        return executionResult({
          status: "failed",
          exitCode: 7,
          stdout: diagnostic,
        });
      },
    };

    const output = (await bashHandler(
      {
        command: "failing-command",
      } satisfies BashInput,
      contextWith(executionPort),
    )) as BashOutput;

    expect(output.stdout).toBe(diagnostic);
    expect(output.stderr).toBe("");
    expect(bashToolEntry.formatModelContent?.(output)).toBe(`Exit code 7\n${diagnostic}`);
  });

  it("does not attach a no-op Bash startup script by default", async () => {
    const executionRequests: ExecutionRequest[] = [];
    const executionPort: ExecutionPort = {
      async run(request) {
        executionRequests.push(request);
        return executionResult({
          status: "completed",
          exitCode: 0,
          stdout: "ok\n",
        });
      },
    };

    await bashHandler({ command: "echo ok" }, contextWith(executionPort));

    expect(executionRequests).toHaveLength(1);
    expect(
      (executionRequests[0] as Record<string, unknown> | undefined)?.bashStartup,
    ).toBeUndefined();
    expect(executionRequests[0]?.bashPrelude).toBeUndefined();
  });

  it("adds sanitized Bash performance attribution to structured output", async () => {
    const executionPort: ExecutionPort = {
      async run(_request, options) {
        await options?.onEvent?.({
          type: "progress",
          timestamp: new Date(),
          elapsedMs: 42,
          stdoutBytes: 5,
          stderrBytes: 0,
          stdoutTail: "hello",
          stderrTail: "",
        });
        return {
          ...executionResult({
            status: "completed",
            exitCode: 0,
            stdout: "hello",
          }),
          durationMs: 1234,
        };
      },
    };

    const output = (await bashHandler(
      { command: "npm test -- --runInBand" },
      contextWith(executionPort),
    )) as BashOutput;

    expect(output).toMatchObject({
      stdout: "hello",
      perf: {
        detail: {
          kind: "command",
          command: {
            runMs: 1234,
            firstOutputMs: 42,
            noOutputMs: 42,
            exitCode: 0,
            timedOut: false,
            outputBytes: 5,
            category: "test",
            count: 1,
            name: "npm",
            status: "completed",
          },
        },
      },
    });
    expect((output as any).perf.detail.command.hash).toMatch(/^[a-f0-9]{16}$/u);
    expect(JSON.stringify((output as any).perf)).not.toContain("npm test");
  });

  it("accepts semantic timeout and boolean values from model input", async () => {
    let capturedRequest: ExecutionRequest | undefined;
    const executionPort: ExecutionPort = {
      async run(request) {
        capturedRequest = request;
        return executionResult({ status: "completed" });
      },
    };

    await bashHandler(
      {
        command: "npm test",
        timeout: "123",
        run_in_background: "false",
        dangerouslyDisableSandbox: "1",
      },
      contextWith(executionPort),
    );

    expect(capturedRequest?.timeoutMs).toBe(123);
    expect(capturedRequest?.sandbox).toMatchObject({
      enabled: false,
      dangerouslyDisableSandbox: true,
    });
  });

  it("keeps the workspace root in session context variables after cd, for background calls too", async () => {
    const requests: ExecutionRequest[] = [];
    const executionPort: BashBackgroundLifecycleExecutionPort = {
      async run(request) {
        requests.push(request);
        return executionResult({ status: "completed", exitCode: 0, stdout: "ok\n" });
      },
      async runBashWithBackgroundLifecycle(request) {
        requests.push(request);
        return { kind: "completed", result: executionResult({ status: "completed", exitCode: 0 }) };
      },
    };
    const context = contextWith(executionPort, {
      workingDirectory: resolve(projectRoot, "nested"),
      workspaceRoot: projectRoot,
    });

    await bashHandler({ command: "echo ok" } satisfies BashInput, context);
    await bashHandler({ command: "echo ok", run_in_background: true } satisfies BashInput, context);

    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.env?.set?.CLAUDE_PROJECT_DIR).toBe(projectRoot);
      expect(request.env?.set?.ZCODE_SESSION_ID).toBe("sess_test");
    }
  });

  it("updates session cwd from successful foreground Bash execution", async () => {
    const nextCwd = resolve(projectRoot, "nested");
    let observedCwd: string | undefined;
    let capturedRequest: ExecutionRequest | undefined;
    const executionPort: ExecutionPort = {
      async run(request) {
        capturedRequest = request;
        return executionResult({
          status: "completed",
          exitCode: 0,
          resolvedCwd: nextCwd,
          stdout: "ok\n",
        });
      },
    };

    const output = (await bashHandler(
      { command: `cd ${nextCwd} && echo ok` } satisfies BashInput,
      contextWith(executionPort, {
        workingDirectory: projectRoot,
        workspaceRoot: projectRoot,
        setWorkingDirectory: (cwd) => {
          observedCwd = cwd;
        },
      }),
    )) as BashOutput;

    expect(capturedRequest?.captureCwdAfterSuccess).toBe(true);
    expect(capturedRequest?.command).toMatchObject({
      mode: "shell",
      shellProfile: "posix-bash",
    });
    expect(observedCwd).toBe(nextCwd);
    expect(bashToolEntry.formatModelContent?.(output)).toBe("ok");
  });

  it("keeps cwd persistence independent from read-only Bash inspection classification", async () => {
    const nextCwd = resolve(projectRoot, "nested");
    let observedCwd: string | undefined;
    const executionPort: ExecutionPort = {
      async run() {
        return executionResult({
          status: "completed",
          exitCode: 0,
          resolvedCwd: nextCwd,
          stdout: "src/index.ts:1:foo\n",
        });
      },
    };

    const output = (await bashHandler(
      { command: `cd ${nextCwd} && grep -R -n foo src` } satisfies BashInput,
      contextWith(executionPort, {
        workingDirectory: projectRoot,
        workspaceRoot: projectRoot,
        setWorkingDirectory: (cwd) => {
          observedCwd = cwd;
        },
      }),
    )) as BashOutput;

    expect(observedCwd).toBe(nextCwd);
    expect(output.stderr).toBe("");
    expect(bashToolEntry.formatModelContent?.(output)).toBe("src/index.ts:1:foo");
  });

  it("resets main Bash cwd to workspace root and exposes the cwd reset stderr when final cwd leaves workspace", async () => {
    const outsideCwd = resolve("/tmp/zcode-outside");
    let observedCwd: string | undefined;
    const executionPort: ExecutionPort = {
      async run() {
        return executionResult({
          status: "completed",
          exitCode: 0,
          resolvedCwd: outsideCwd,
          stdout: "done\n",
        });
      },
    };

    const output = (await bashHandler(
      { command: "cd /tmp/zcode-outside && echo done" } satisfies BashInput,
      contextWith(executionPort, {
        workingDirectory: projectRoot,
        workspaceRoot: projectRoot,
        setWorkingDirectory: (cwd) => {
          observedCwd = cwd;
        },
      }),
    )) as BashOutput;

    expect(observedCwd).toBe(projectRoot);
    expect(output.stderr).toBe(`Shell cwd was reset to ${projectRoot}`);
    expect(bashToolEntry.formatModelContent?.(output)).toBe(
      `done\nShell cwd was reset to ${projectRoot}`,
    );
    expect(JSON.stringify(output)).not.toContain("resolvedCwd");
    expect(JSON.stringify(output)).not.toContain(outsideCwd);
  });

  it("preserves existing stderr content when appending cwd reset stderr", async () => {
    const outsideCwd = resolve("/tmp/zcode-stderr-outside");
    const executionPort: ExecutionPort = {
      async run() {
        return executionResult({
          status: "completed",
          exitCode: 0,
          resolvedCwd: outsideCwd,
          stdout: "done\n",
          stderr: "  warning detail  \n\n",
        });
      },
    };

    const output = (await bashHandler(
      {
        command: "cd /tmp/zcode-stderr-outside && echo done",
      } satisfies BashInput,
      contextWith(executionPort, {
        workingDirectory: projectRoot,
        workspaceRoot: projectRoot,
      }),
    )) as BashOutput;

    expect(output.stderr).toBe(`  warning detail  \nShell cwd was reset to ${projectRoot}`);
  });

  it("does not leave stray carriage returns when appending cwd reset stderr", async () => {
    const outsideCwd = resolve("/tmp/zcode-crlf-stderr-outside");
    const executionPort: ExecutionPort = {
      async run() {
        return executionResult({
          status: "completed",
          exitCode: 0,
          resolvedCwd: outsideCwd,
          stdout: "done\n",
          stderr: "warning detail\r\n\r\n",
        });
      },
    };

    const output = (await bashHandler(
      {
        command: "cd /tmp/zcode-crlf-stderr-outside && echo done",
      } satisfies BashInput,
      contextWith(executionPort, {
        workingDirectory: projectRoot,
        workspaceRoot: projectRoot,
      }),
    )) as BashOutput;

    expect(output.stderr).toBe(`warning detail\nShell cwd was reset to ${projectRoot}`);
  });

  it("keeps cwd reset stderr even when project cwd env is present", async () => {
    const previousEnv = process.env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR;
    process.env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR = "1";
    const outsideCwd = resolve("/tmp/zcode-env-outside");
    let observedCwd: string | undefined;
    const executionPort: ExecutionPort = {
      async run() {
        return executionResult({
          status: "completed",
          exitCode: 0,
          resolvedCwd: outsideCwd,
          stdout: "done\n",
        });
      },
    };

    try {
      const output = (await bashHandler(
        {
          command: "cd /tmp/zcode-env-outside && echo done",
        } satisfies BashInput,
        contextWith(executionPort, {
          workingDirectory: projectRoot,
          workspaceRoot: projectRoot,
          setWorkingDirectory: (cwd) => {
            observedCwd = cwd;
          },
        }),
      )) as BashOutput;

      expect(observedCwd).toBe(projectRoot);
      expect(output.stderr).toBe(`Shell cwd was reset to ${projectRoot}`);
      expect(bashToolEntry.formatModelContent?.(output)).toBe(
        `done\nShell cwd was reset to ${projectRoot}`,
      );
    } finally {
      if (previousEnv === undefined) {
        delete process.env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR;
      } else {
        process.env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR = previousEnv;
      }
    }
  });

  it("does not reset or expose cwd reminder for subagent Bash scope", async () => {
    let observedCwd: string | undefined;
    const executionPort: ExecutionPort = {
      async run() {
        return executionResult({
          status: "completed",
          exitCode: 0,
          resolvedCwd: "/tmp/subagent-outside",
          stdout: "child\n",
        });
      },
    };

    const output = (await bashHandler(
      { command: "cd /tmp/subagent-outside && echo child" } satisfies BashInput,
      contextWith(executionPort, {
        runtimeScope: "subagent",
        setWorkingDirectory: (cwd) => {
          observedCwd = cwd;
        },
      }),
    )) as BashOutput;

    expect(observedCwd).toBeUndefined();
    expect(output.stderr).toBe("");
    expect(bashToolEntry.formatModelContent?.(output)).toBe("child");
  });

  it("does not capture or update cwd for background Bash execution", async () => {
    let observedCwd: string | undefined;
    let capturedRequest: ExecutionRequest | undefined;
    const executionPort: BashBackgroundLifecycleExecutionPort = {
      async run() {
        throw new Error("run should not be used for background execution");
      },
      async runBashWithBackgroundLifecycle(request) {
        capturedRequest = request;
        return {
          kind: "backgrounded",
          task: {
            taskId: "exec_bg",
            status: "running",
            startedAt: new Date(),
          },
        };
      },
    };

    await bashHandler(
      { command: "cd /tmp", run_in_background: true } satisfies BashInput,
      contextWith(executionPort, {
        setWorkingDirectory: (cwd) => {
          observedCwd = cwd;
        },
      }),
    );

    expect(capturedRequest?.captureCwdAfterSuccess).toBeUndefined();
    expect(capturedRequest?.command).toMatchObject({
      mode: "shell",
      shellProfile: "posix-bash",
    });
    expect(observedCwd).toBeUndefined();
  });

  it.each([
    [
      "failed",
      executionResult({
        status: "failed",
        exitCode: 1,
        resolvedCwd: "/tmp/ignored",
      }),
    ],
    [
      "timed_out",
      executionResult({
        status: "timed_out",
        timedOut: true,
        resolvedCwd: "/tmp/ignored",
      }),
    ],
  ])("does not update cwd for %s Bash results", async (_name, result) => {
    let observedCwd: string | undefined;
    const executionPort: ExecutionPort = {
      async run() {
        return result;
      },
    };

    const output = (await bashHandler(
      { command: "cd /tmp && false" } satisfies BashInput,
      contextWith(executionPort, {
        setWorkingDirectory: (cwd) => {
          observedCwd = cwd;
        },
      }),
    )) as BashOutput;

    expect(observedCwd).toBeUndefined();
    expect(bashToolEntry.formatModelContent?.(output)).not.toContain("Shell cwd was reset");
  });

  it.each([
    ["rg missing .", "No matches found", false],
    ["find . -name missing", "Some directories were inaccessible", false],
    ["printf x | grep y", "No matches found", false],
    ["rg missing .; test -f missing", "Condition is false", false],
    ["rg missing . || test -f missing", "Condition is false", false],
    ["rg missing . && test -f missing", "Condition is false", false],
    ["true && rg missing .", "No matches found", false],
    ["git grep missing", "No matches found", false],
    ["git -C . diff --exit-code", "Files differ", false],
    ["rg missing .; exit 1", "Command exited with code 1", true],
  ])(
    "interprets %s exit 1 from status-bearing command",
    async (command, interpretation, expectedIsError) => {
      const executionPort: ExecutionPort = {
        async run() {
          return executionResult({
            status: "failed",
            exitCode: 1,
          });
        },
      };

      const output = (await bashHandler(
        { command } satisfies BashInput,
        contextWith(executionPort),
      )) as BashOutput;

      expect(output.returnCodeInterpretation).toBe(interpretation);
      expect(
        isErrorForToolResult({
          completedAt: new Date(),
          durationMs: 1,
          output,
          startedAt: new Date(),
          success: true,
          toolCallId: "call_bash",
          toolName: "Bash",
        }),
      ).toBe(expectedIsError);
    },
  );

  it("keeps raw command output on BashOutput and trims only provider-visible content", async () => {
    const executionPort: ExecutionPort = {
      async run() {
        return executionResult({
          status: "completed",
          stderr: "\nwarn\n",
          stdout: "\nalpha\n\n",
        });
      },
    };

    const output = (await bashHandler(
      {
        command: "printf '\\nalpha\\n\\n'",
      } satisfies BashInput,
      contextWith(executionPort),
    )) as BashOutput;

    expect(output.stdout).toBe("\nalpha\n\n");
    expect(output.stderr).toBe("\nwarn\n");
    expect(bashToolEntry.formatModelContent?.(output)).toBe("alpha\nwarn");
  });

  it("does not add cwd reset text without observing an actual shell cwd change", async () => {
    const executionPort: ExecutionPort = {
      async run() {
        return executionResult({
          exitCode: 1,
          status: "failed",
          stderr: "cd: no such file or directory",
        });
      },
    };

    const output = (await bashHandler(
      {
        command: "cd /missing-zcode-path && pwd",
      } satisfies BashInput,
      contextWith(executionPort, {
        workingDirectory: projectRoot,
        workspaceRoot: projectRoot,
      }),
    )) as BashOutput;

    expect(output.stderr).toBe("cd: no such file or directory");
    expect(bashToolEntry.formatModelContent?.(output)).toBe(
      "Exit code 1\ncd: no such file or directory",
    );
  });

  it("marks valid image data URI stdout as image output for provider-visible content", async () => {
    const tinyPng =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l2tzWQAAAABJRU5ErkJggg==";
    const executionPort: ExecutionPort = {
      async run() {
        return executionResult({
          status: "completed",
          stdout: tinyPng,
        });
      },
    };

    const output = (await bashHandler(
      {
        command: "printf image",
      } satisfies BashInput,
      contextWith(executionPort),
    )) as BashOutput;

    expect(output.isImage).toBe(true);
    expect(output.stdout).toBe(tinyPng);
    expect(bashToolEntry.formatModelContent?.(output)).toEqual([
      {
        type: "image",
        mediaType: "image/png",
        dataUrl: tinyPng,
      },
    ]);
  });

  it("resizes image data URI stdout through ImageProcessorPort when configured", async () => {
    const tinyPng =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l2tzWQAAAABJRU5ErkJggg==";
    let capturedResizeRequest: Parameters<ImageProcessorPort["resizeToFit"]>[0] | undefined;
    const imageProcessorPort: ImageProcessorPort = {
      async resizeToFit(request) {
        capturedResizeRequest = request;
        return {
          data: Buffer.from("resized-image"),
          mediaType: "image/jpeg",
          resized: true,
        };
      },
      async prepareForModel() {
        throw new Error("prepareForModel should not be called");
      },
    };
    const executionPort: ExecutionPort = {
      async run() {
        return executionResult({
          status: "completed",
          stdout: tinyPng,
        });
      },
    };

    const output = (await bashHandler(
      {
        command: "printf image",
      } satisfies BashInput,
      contextWith(executionPort, { imageProcessorPort }),
    )) as BashOutput;

    expect(output.isImage).toBe(true);
    expect(output.stdout).toBe("data:image/jpeg;base64,cmVzaXplZC1pbWFnZQ==");
    expect(capturedResizeRequest?.maxDimension).toBe(2000);
    expect(capturedResizeRequest?.mediaType).toBe("image/png");
    expect(Buffer.from(capturedResizeRequest?.data ?? []).byteLength).toBeGreaterThan(0);
  });

  it("keeps valid image stdout as image output when optional resize fails", async () => {
    const grayAlphaPng =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
    const imageProcessorPort: ImageProcessorPort = {
      async resizeToFit() {
        throw new Error("decoder did not handle this valid png");
      },
      async prepareForModel() {
        throw new Error("prepareForModel should not be called");
      },
    };
    const executionPort: ExecutionPort = {
      async run() {
        return executionResult({
          status: "completed",
          stdout: grayAlphaPng,
        });
      },
    };

    const output = (await bashHandler(
      {
        command: "printf image",
      } satisfies BashInput,
      contextWith(executionPort, { imageProcessorPort }),
    )) as BashOutput;

    expect(output.isImage).toBe(true);
    expect(output.stdout).toBe(grayAlphaPng);
    expect(bashToolEntry.formatModelContent?.(output)).toEqual([
      {
        type: "image",
        mediaType: "image/png",
        dataUrl: grayAlphaPng,
      },
    ]);
  });

  it("falls back to text when image resize fails because the image is too large", async () => {
    const grayAlphaPng =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
    const imageProcessorPort: ImageProcessorPort = {
      async resizeToFit() {
        throw createImageProcessorError({
          code: "too_large",
          message: "Unable to fit image in provider budget",
        });
      },
      async prepareForModel() {
        throw new Error("prepareForModel should not be called");
      },
    };
    const executionPort: ExecutionPort = {
      async run() {
        return executionResult({
          status: "completed",
          stdout: grayAlphaPng,
        });
      },
    };

    const output = (await bashHandler(
      {
        command: "printf image",
      } satisfies BashInput,
      contextWith(executionPort, { imageProcessorPort }),
    )) as BashOutput;

    expect(output.isImage).toBe(false);
    expect(output.stdout).toBe(grayAlphaPng);
    expect(bashToolEntry.formatModelContent?.(output)).toBe(grayAlphaPng);
  });

  it("short-circuits successful image stdout without appending stderr text", async () => {
    const tinyPng =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l2tzWQAAAABJRU5ErkJggg==";
    const executionPort: ExecutionPort = {
      async run() {
        return executionResult({
          status: "completed",
          stderr: "warn\n",
          stdout: tinyPng,
        });
      },
    };

    const output = (await bashHandler(
      {
        command: "printf image && echo warn >&2",
      } satisfies BashInput,
      contextWith(executionPort),
    )) as BashOutput;

    expect(bashToolEntry.formatModelContent?.(output)).toEqual([
      {
        type: "image",
        mediaType: "image/png",
        dataUrl: tinyPng,
      },
    ]);
  });

  it("projects failed image Bash results as text-only provider errors", async () => {
    const tinyPng =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l2tzWQAAAABJRU5ErkJggg==";
    const executionPort: ExecutionPort = {
      async run() {
        return executionResult({
          exitCode: 7,
          status: "failed",
          stderr: "bad image command\n",
          stdout: tinyPng,
        });
      },
    };

    const output = (await bashHandler(
      {
        command: "printf image; exit 7",
      } satisfies BashInput,
      contextWith(executionPort),
    )) as BashOutput;

    expect(bashToolEntry.formatModelContent?.(output)).toBe(
      `Exit code 7\n${tinyPng}\nbad image command`,
    );
  });

  it("keeps claude-code hint lines in failed provider-error stdout", async () => {
    const stdout =
      'visible\n<claude-code-hint v="1" type="plugin" value="demo@example" />\nafter\n';
    const executionPort: ExecutionPort = {
      async run() {
        return executionResult({
          exitCode: 2,
          status: "failed",
          stderr: "bad command\n",
          stdout,
        });
      },
    };

    const output = (await bashHandler(
      {
        command: "printf hints; exit 2",
      } satisfies BashInput,
      contextWith(executionPort),
    )) as BashOutput;

    expect(output.stdout).toBe(stdout);
    expect(bashToolEntry.formatModelContent?.(output)).toBe(
      `Exit code 2\n${stdout.trimEnd()}\nbad command`,
    );
  });

  it("does not resize failed image-looking stdout before provider error projection", async () => {
    const tinyPng =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l2tzWQAAAABJRU5ErkJggg==";
    const resizeToFit = vi.fn<ImageProcessorPort["resizeToFit"]>(async () => {
      throw new Error("failed Bash output should not be resized");
    });
    const imageProcessorPort: ImageProcessorPort = {
      resizeToFit,
      async prepareForModel() {
        throw new Error("prepareForModel should not be called");
      },
    };
    const executionPort: ExecutionPort = {
      async run() {
        return executionResult({
          exitCode: 7,
          status: "failed",
          stderr: "bad image command\n",
          stdout: tinyPng,
        });
      },
    };

    const output = (await bashHandler(
      {
        command: "printf image; exit 7",
      } satisfies BashInput,
      contextWith(executionPort, { imageProcessorPort }),
    )) as BashOutput;

    expect(output.isImage).toBe(false);
    expect(output.stdout).toBe(tinyPng);
    expect(resizeToFit).not.toHaveBeenCalled();
    expect(bashToolEntry.formatModelContent?.(output)).toBe(
      `Exit code 7\n${tinyPng}\nbad image command`,
    );
  });

  it("reads artifact-backed image stdout before resizing provider-visible image output", async () => {
    const testRoot = await mkdtemp(join(tmpdir(), "zcode-bash-image-"));
    const tinyPng =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l2tzWQAAAABJRU5ErkJggg==";
    const outputPath = join(testRoot, "stdout.txt");
    await writeFile(outputPath, tinyPng, "utf8");
    let capturedResizeRequest: Parameters<ImageProcessorPort["resizeToFit"]>[0] | undefined;
    const imageProcessorPort: ImageProcessorPort = {
      async resizeToFit(request) {
        capturedResizeRequest = request;
        return {
          data: Buffer.from("resized-from-artifact"),
          mediaType: "image/webp",
          resized: true,
        };
      },
      async prepareForModel() {
        throw new Error("prepareForModel should not be called");
      },
    };
    const executionPort: ExecutionPort = {
      async run() {
        return executionResult({
          status: "completed",
          stdout: tinyPng.slice(0, 24),
          stdoutArtifactPath: outputPath,
          stdoutArtifactBytes: Buffer.byteLength(tinyPng, "utf8"),
        });
      },
    };

    try {
      const output = (await bashHandler(
        {
          command: "printf image",
        } satisfies BashInput,
        contextWith(executionPort, { imageProcessorPort }),
      )) as BashOutput;

      expect(output.isImage).toBe(true);
      expect(output.stdout).toBe("data:image/webp;base64,cmVzaXplZC1mcm9tLWFydGlmYWN0");
      expect(capturedResizeRequest?.mediaType).toBe("image/png");
      expect(Buffer.from(capturedResizeRequest?.data ?? [])).toEqual(
        Buffer.from(tinyPng.split(",")[1]!, "base64"),
      );
      expect(bashToolEntry.formatModelContent?.(output)).toEqual([
        {
          type: "image",
          mediaType: "image/webp",
          dataUrl: "data:image/webp;base64,cmVzaXplZC1mcm9tLWFydGlmYWN0",
        },
      ]);
    } finally {
      await rm(testRoot, { force: true, recursive: true });
    }
  });

  it("does not swallow cancellation while resizing Bash image stdout", async () => {
    const tinyPng =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l2tzWQAAAABJRU5ErkJggg==";
    const abortController = new AbortController();
    abortController.abort();
    const imageProcessorPort: ImageProcessorPort = {
      async resizeToFit() {
        throw new Error("resize aborted");
      },
      async prepareForModel() {
        throw new Error("prepareForModel should not be called");
      },
    };
    const executionPort: ExecutionPort = {
      async run() {
        return executionResult({
          status: "completed",
          stdout: tinyPng,
        });
      },
    };

    await expect(
      bashHandler(
        {
          command: "printf image",
        } satisfies BashInput,
        contextWith(executionPort, {
          abortSignal: abortController.signal,
          imageProcessorPort,
        }),
      ),
    ).rejects.toThrow("resize aborted");
  });

  it("闲时轮复用显式后台及超时自动后台的 Bash 生命周期", async () => {
    const runBashWithBackgroundLifecycle = vi.fn(async () => ({
      kind: "completed" as const,
      result: executionResult({ status: "completed", exitCode: 0 }),
    }));
    const run = vi.fn(async () => executionResult({ status: "completed", exitCode: 0 }));
    const executionPort: BashBackgroundLifecycleExecutionPort = {
      run,
      runBashWithBackgroundLifecycle,
    };

    await expect(
      bashHandler(
        { command: "long-running command", run_in_background: true } satisfies BashInput,
        contextWith(executionPort, { offPeakTurn: true }),
      ),
    ).resolves.toBeDefined();
    expect(runBashWithBackgroundLifecycle).toHaveBeenCalledTimes(1);

    const output = (await bashHandler(
      { command: "long-running command" } satisfies BashInput,
      contextWith(executionPort, { offPeakTurn: true }),
    )) as BashOutput;
    expect(runBashWithBackgroundLifecycle).toHaveBeenCalledTimes(2);
    expect(run).not.toHaveBeenCalled();
    expect(output.status).toBe("completed");
  });

  it("starts background execution when requested", async () => {
    let capturedRequest: ExecutionRequest | undefined;
    let capturedMode: string | undefined;
    const runBashWithBackgroundLifecycle = vi.fn(
      async (request: ExecutionRequest, lifecycle: { mode: "explicit" | "auto_on_timeout" }) => {
        capturedRequest = request;
        capturedMode = lifecycle.mode;
        return {
          kind: "backgrounded" as const,
          task: {
            taskId: "exec_bg",
            status: "running" as const,
            startedAt: new Date(),
            outputPath: "/tmp/exec_bg-stdout.log",
            stdoutPersistedOutputPath: "/tmp/exec_bg-stdout.log",
            stderrPersistedOutputPath: "/tmp/exec_bg-stderr.log",
          },
        };
      },
    );
    const executionPort: BashBackgroundLifecycleExecutionPort = {
      async run() {
        throw new Error("run should not be called");
      },
      runBashWithBackgroundLifecycle,
    };

    const output = (await bashHandler(
      {
        command: "long-running command",
        run_in_background: true,
      } satisfies BashInput,
      contextWith(executionPort),
    )) as BashOutput;

    expect(runBashWithBackgroundLifecycle).toHaveBeenCalledTimes(1);
    expect(capturedMode).toBe("explicit");
    expect(capturedRequest?.timeoutMs).toBe(120_000);
    expect(capturedRequest?.outputLimit).toEqual({
      maxInlineBytes: 30_000,
      maxBufferBytes: 30_000,
      maxPersistedBytes: 5 * 1024 * 1024 * 1024,
      persistOutput: "always",
    });
    expect(output.status).toBe("backgrounded");
    expect(output.backgroundTaskId).toBe("exec_bg");
    expect(output.persistedOutputPath).toBe("/tmp/exec_bg-stdout.log");
    expect(output.stdoutPersistedOutputPath).toBe("/tmp/exec_bg-stdout.log");
    expect(output.stderrPersistedOutputPath).toBe("/tmp/exec_bg-stderr.log");
    expect(output.interrupted).toBe(false);
    // 显式后台不是超时触发的，不记录超时。
    expect(output.timedOutAfterMs).toBeUndefined();
  });

  it("records the timeout when a foreground command is moved to the background", async () => {
    const executionPort: BashBackgroundLifecycleExecutionPort = {
      async run() {
        throw new Error("run should not be called");
      },
      runBashWithBackgroundLifecycle: vi.fn(
        async (_request: ExecutionRequest, lifecycle: { mode: string }) => {
          expect(lifecycle.mode).toBe("auto_on_timeout");
          return {
            kind: "backgrounded" as const,
            task: {
              taskId: "exec_bg",
              status: "running" as const,
              startedAt: new Date(),
              outputPath: "/tmp/exec_bg.output",
            },
          };
        },
      ),
    };

    const output = (await bashHandler(
      { command: "long-running command" } satisfies BashInput,
      contextWith(executionPort),
    )) as BashOutput;

    expect(output.status).toBe("backgrounded");
    expect(output.timedOutAfterMs).toBe(120_000);
  });

  it("keeps a decimal timeout valid in the auto-background output", async () => {
    const executionPort: BashBackgroundLifecycleExecutionPort = {
      async run() {
        throw new Error("run should not be called");
      },
      runBashWithBackgroundLifecycle: vi.fn(async () => ({
        kind: "backgrounded" as const,
        task: {
          taskId: "exec_bg_decimal",
          status: "running" as const,
          startedAt: new Date(),
          outputPath: "/tmp/exec_bg_decimal.output",
        },
      })),
    };

    const output = (await bashHandler(
      { command: "long-running command", timeout: 1500.5 } satisfies BashInput,
      contextWith(executionPort),
    )) as BashOutput;

    // 模型可以传小数 timeout，超时转后台的输出原样记录它；输出校验不能因此判工具失败。
    expect(output.timedOutAfterMs).toBe(1500.5);
    expect(BashOutputSchema.safeParse(output).success).toBe(true);
  });

  it.each([
    { inputTimeout: undefined, expected: 250 },
    { inputTimeout: 0, expected: 250 },
    { inputTimeout: "0", expected: 250 },
    { inputTimeout: 500, expected: 500 },
    { inputTimeout: "500", expected: 500 },
    { inputTimeout: 5_000, expected: 900 },
  ])(
    "uses one injected timeout policy for handler requests ($inputTimeout -> $expected)",
    async ({ inputTimeout, expected }) => {
      let capturedRequest: ExecutionRequest | undefined;
      const entry = createBashToolEntry({
        bashTimeoutPolicy: {
          defaultTimeoutMs: 250,
          maxTimeoutMs: 900,
        },
      });
      const executionPort: ExecutionPort = {
        async run(request) {
          capturedRequest = request;
          return executionResult({ status: "completed", exitCode: 0 });
        },
      };

      const toolInput = {
        command: "sleep 0",
        ...(inputTimeout === undefined ? {} : { timeout: inputTimeout }),
      };
      await entry.handler(toolInput, contextWith(executionPort));

      expect(capturedRequest?.timeoutMs).toBe(expected);
      expect(resolveTimeoutMs(entry, toolInput, 300_000)).toBe(expected + 6_000);
      expect(entry.metadata.timeoutMs).toBe(250);
      expect(entry.timeout).toMatchObject({ defaultMs: 250, maxMs: 900 });
      expect(
        (
          (entry.inputSchema.properties as Record<string, unknown>).timeout as Record<
            string,
            unknown
          >
        ).description,
      ).toBe("Optional timeout in milliseconds (max 900 for a foreground command)");
      expect(entry.metadata.description).toContain("default 250");
      expect(entry.metadata.description).toContain("max 900");
    },
  );

  it("returns separate stdout and stderr artifact paths", async () => {
    const executionPort: ExecutionPort = {
      async run() {
        return executionResult({
          status: "failed",
          stdout: "abc",
          stderr: "def",
          stdoutArtifactPath: "/tmp/stdout.log",
          stdoutArtifactBytes: 3,
          stderrArtifactPath: "/tmp/stderr.log",
          stderrArtifactBytes: 3,
        });
      },
    };

    const output = (await bashHandler(
      {
        command: "noisy command",
      } satisfies BashInput,
      contextWith(executionPort),
    )) as BashOutput;

    expect(output.persistedOutputPath).toBe("/tmp/stdout.log");
    expect(output.stdoutPersistedOutputPath).toBe("/tmp/stdout.log");
    expect(output.stderrPersistedOutputPath).toBe("/tmp/stderr.log");
    expect(output.persistedOutputSize).toBe(6);
    expect(output.stdoutPersistedOutputSize).toBe(3);
    expect(output.stderrPersistedOutputSize).toBe(3);
  });

  it("uses observed Bash bytes instead of capped artifact bytes for persisted output", async () => {
    const executionPort: ExecutionPort = {
      async run() {
        return executionResult({
          status: "completed",
          stdout: "preview",
          stdoutBytes: 80 * 1024 * 1024,
          stdoutArtifactPath: "/tmp/stdout.log",
          stdoutArtifactBytes: 64 * 1024 * 1024,
          stdoutTruncated: true,
        });
      },
    };

    const output = (await bashHandler(
      { command: "large command" } satisfies BashInput,
      contextWith(executionPort),
    )) as BashOutput;

    expect(output.persistedOutputSize).toBe(80 * 1024 * 1024);
    expect(output.stdoutPersistedOutputSize).toBe(64 * 1024 * 1024);
  });

  it("surfaces output limit failures as a Bash interpretation", async () => {
    const executionPort: ExecutionPort = {
      async run() {
        return executionResult({
          status: "failed",
          error: {
            type: "output_limit",
            message: "Execution output exceeded the persisted output limit",
          },
        });
      },
    };

    const output = (await bashHandler(
      {
        command: "yes",
      } satisfies BashInput,
      contextWith(executionPort),
    )) as BashOutput;

    expect(output.stderr).toBe("Execution output exceeded the persisted output limit");
    expect(output.returnCodeInterpretation).toBe(
      "Command stopped because output exceeded the configured limit",
    );
  });

  it("maps execution progress events to session events", async () => {
    const events: SessionEvent[] = [];
    const executionPort: ExecutionPort = {
      async run(_request, options) {
        await options?.onEvent?.({
          type: "progress",
          elapsedMs: 2100,
          pid: 123,
          stdoutBytes: 5,
          stderrBytes: 4,
          outputPreview: {
            text: "hello",
            fullText: "hello",
            totalBytes: 5,
            totalLines: 1,
            linesEstimated: false,
          },
          stdoutTail: "hello",
          stderrTail: "warn",
          timestamp: new Date("2026-05-06T00:00:00.000Z"),
        });
        return executionResult({ status: "completed", stdout: "done" });
      },
    };

    await bashHandler(
      {
        command: "long command",
      } satisfies BashInput,
      contextWith(executionPort, {
        emitEvent: async (event) => {
          events.push(event);
        },
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe(SessionEventType.ToolCallProgress);
    expect(events[0]?.payload).toMatchObject({
      elapsedMs: 2100,
      outputBytes: 9,
      pid: 123,
      stderrBytes: 4,
      stderrTail: "warn",
      stdoutBytes: 5,
      outputPreview: {
        text: "hello",
        fullText: "hello",
        totalBytes: 5,
        totalLines: 1,
        linesEstimated: false,
      },
      stdoutTail: "hello",
      toolCallId: "tool_test",
      toolName: "Bash",
    });
  });

  it("uses the posix-bash profile without an explicit session shell selection", async () => {
    let capturedRequest: ExecutionRequest | undefined;
    const executionPort: ExecutionPort = {
      async run(request) {
        capturedRequest = request;
        return executionResult({ status: "completed" });
      },
    };

    await bashHandler(
      {
        command: "dir",
      } satisfies BashInput,
      contextWith(executionPort),
    );

    expect(capturedRequest?.command).toEqual({
      mode: "shell",
      command: "dir",
      shellProfile: "posix-bash",
    });
  });

  it("passes the session Bash shell selection to the execution adapter", async () => {
    let capturedRequest: ExecutionRequest | undefined;
    const shellSelection: ExecutionShellSelection = {
      dialect: "git-bash",
      display: { name: "Git Bash" },
      id: "git-bash:C:\\Program Files\\Git\\bin\\bash.exe",
      label: "Git Bash",
      path: "C:\\Program Files\\Git\\bin\\bash.exe",
      source: "user-config",
    };
    const executionPort: ExecutionPort = {
      async run(request) {
        capturedRequest = request;
        return executionResult({ status: "completed" });
      },
    };

    await bashHandler(
      {
        command: "printf '%s\\n' \"$BASH_VERSION\"",
      } satisfies BashInput,
      contextWith(executionPort, { bashShellSelection: shellSelection }),
    );

    expect(capturedRequest?.command).toEqual({
      mode: "shell",
      command: "printf '%s\\n' \"$BASH_VERSION\"",
      shellProfile: "posix-bash",
      shellOverride: shellSelection,
    });
  });

  it("keeps embedded search provider-visible state without injecting the Bash prelude", async () => {
    let capturedRequest: ExecutionRequest | undefined;
    const backend = {
      kind: "internal-cli" as const,
      command: "zcode",
      args: ["__internal-search"],
    };
    const executionPort: ExecutionPort = {
      async run(request) {
        capturedRequest = request;
        return executionResult({ status: "completed" });
      },
    };

    await bashHandler(
      {
        command: "grep needle file.txt",
      } satisfies BashInput,
      contextWith(executionPort, {
        embeddedSearch: { enabled: true, backend },
      }),
    );

    expect(capturedRequest?.bashPrelude).toBeUndefined();
  });

  it("passes embedded search prelude for a POSIX shell selection", async () => {
    let capturedRequest: ExecutionRequest | undefined;
    const backend = {
      kind: "internal-cli" as const,
      command: "zcode",
      args: ["__internal-search"],
    };
    const shellSelection: ExecutionShellSelection = {
      dialect: "posix",
      display: { name: "bash" },
      id: "posix:/bin/bash",
      label: "bash",
      path: "/bin/bash",
      source: "auto-detected",
    };
    const executionPort: ExecutionPort = {
      async run(request) {
        capturedRequest = request;
        return executionResult({ status: "completed" });
      },
    };

    await bashHandler(
      {
        command: "grep needle file.txt",
      } satisfies BashInput,
      contextWith(executionPort, {
        bashShellSelection: shellSelection,
        embeddedSearch: { enabled: true, backend },
      }),
    );

    expect(capturedRequest?.bashPrelude).toEqual({
      kind: "embedded-search",
      backend,
    });
  });

  it("marks find and grep disabled without removing the rg prelude", async () => {
    let capturedRequest: ExecutionRequest | undefined;
    const backend = {
      kind: "native-binaries" as const,
      findCommand: "/tools/bfs",
      grepCommand: "/tools/ugrep",
      rgCommand: "/tools/rg",
    };
    const executionPort: ExecutionPort = {
      async run(request) {
        capturedRequest = request;
        return executionResult({ status: "completed" });
      },
    };

    await bashHandler(
      { command: "find . && grep needle file.txt && rg needle" } satisfies BashInput,
      contextWith(executionPort, {
        bashShellSelection: {
          dialect: "posix",
          display: { name: "bash" },
          id: "posix:/bin/bash",
          label: "bash",
          path: "/bin/bash",
          source: "auto-detected",
        },
        embeddedSearch: { enabled: true, backend, findAndGrepEnabled: false },
      }),
    );

    expect(capturedRequest?.bashPrelude).toEqual({
      kind: "embedded-search",
      backend,
      findAndGrepEnabled: false,
    });
  });

  it("does not pass embedded search prelude without a backend", async () => {
    let capturedRequest: ExecutionRequest | undefined;
    const executionPort: ExecutionPort = {
      async run(request) {
        capturedRequest = request;
        return executionResult({ status: "completed" });
      },
    };

    await bashHandler(
      {
        command: "grep needle file.txt",
      } satisfies BashInput,
      contextWith(executionPort, {
        embeddedSearch: { enabled: true },
      }),
    );

    expect(capturedRequest?.bashPrelude).toBeUndefined();
  });

  it("does not pass embedded search prelude for a CMD shell selection", async () => {
    let capturedRequest: ExecutionRequest | undefined;
    const backend = {
      kind: "internal-cli" as const,
      command: "zcode",
      args: ["__internal-search"],
    };
    const shellSelection: ExecutionShellSelection = {
      dialect: "cmd",
      display: { name: "CMD" },
      id: "cmd",
      label: "CMD",
      path: "cmd.exe",
      source: "user-config",
    };
    const executionPort: ExecutionPort = {
      async run(request) {
        capturedRequest = request;
        return executionResult({ status: "completed" });
      },
    };

    await bashHandler(
      {
        command: "grep needle file.txt",
      } satisfies BashInput,
      contextWith(executionPort, {
        bashShellSelection: shellSelection,
        embeddedSearch: { enabled: true, backend },
      }),
    );

    expect(capturedRequest?.bashPrelude).toBeUndefined();
  });

  it("passes embedded search prelude for a Windows Git Bash shell selection", async () => {
    let capturedRequest: ExecutionRequest | undefined;
    const backend = {
      kind: "internal-cli" as const,
      command: "zcode",
      args: ["__internal-search"],
    };
    const shellSelection: ExecutionShellSelection = {
      dialect: "git-bash",
      display: { name: "Git Bash" },
      id: "git-bash:C:\\Program Files\\Git\\bin\\bash.exe",
      label: "Git Bash",
      path: "C:\\Program Files\\Git\\bin\\bash.exe",
      source: "user-config",
    };
    const executionPort: ExecutionPort = {
      async run(request) {
        capturedRequest = request;
        return executionResult({ status: "completed" });
      },
    };

    await bashHandler(
      {
        command: "grep needle file.txt",
      } satisfies BashInput,
      contextWith(executionPort, {
        bashShellSelection: shellSelection,
        embeddedSearch: { enabled: true, backend },
      }),
    );

    expect(capturedRequest?.command).toMatchObject({
      shellOverride: shellSelection,
      shellProfile: "posix-bash",
    });
    expect(capturedRequest?.bashPrelude).toEqual({
      kind: "embedded-search",
      backend,
    });
  });

  it("passes a CMD session shell selection to the execution adapter request", async () => {
    let capturedRequest: ExecutionRequest | undefined;
    const shellSelection: ExecutionShellSelection = {
      dialect: "cmd",
      display: { name: "CMD" },
      id: "cmd",
      label: "CMD",
      path: "cmd.exe",
      source: "user-config",
    };
    const executionPort: ExecutionPort = {
      async run(request) {
        capturedRequest = request;
        return executionResult({ status: "completed" });
      },
    };

    await bashHandler(
      {
        command: "dir",
      } satisfies BashInput,
      contextWith(executionPort, {
        bashShellSelection: shellSelection,
      }),
    );

    expect(capturedRequest?.command).toEqual({
      mode: "shell",
      command: "dir",
      shellProfile: "posix-bash",
      shellOverride: shellSelection,
    });
  });

  it("defaults command cwd to the session cwd", async () => {
    let capturedRequest: ExecutionRequest | undefined;
    const executionPort: ExecutionPort = {
      async run(request) {
        capturedRequest = request;
        return executionResult({ status: "completed" });
      },
    };

    await bashHandler(
      {
        command: "pwd",
      } satisfies BashInput,
      contextWith(executionPort, {
        workingDirectory: projectRoot,
        workspaceRoot: projectRoot,
      }),
    );

    expect(capturedRequest?.cwd).toBe(projectRoot);
  });

  it("does not expose resolved cwd in provider-visible Bash content", async () => {
    const secretCwd = resolve(projectRoot, "secret-cwd");
    const executionPort: ExecutionPort = {
      async run() {
        return executionResult({
          status: "completed",
          exitCode: 0,
          resolvedCwd: secretCwd,
          stdout: "ok\n",
        });
      },
    };

    const output = (await bashHandler(
      { command: `cd ${secretCwd} && echo ok` } satisfies BashInput,
      contextWith(executionPort, {
        workingDirectory: projectRoot,
        workspaceRoot: projectRoot,
      }),
    )) as BashOutput;

    const content = bashToolEntry.formatModelContent?.(output);
    expect(content).toBe("ok");
    expect(JSON.stringify(output)).not.toContain("resolvedCwd");
  });

  it("formats Bash results as stdout and stderr text for the model", () => {
    const modelContent = bashToolEntry.formatModelContent?.({
      stdout: "input.tex\nmain.tex\nsynonyms.txt\n",
      stderr: "",
      interrupted: false,
      status: "completed",
      exitCode: 0,
      stdoutBytes: 31,
      stderrBytes: 0,
    } satisfies BashOutput);

    expect(modelContent).toBe("input.tex\nmain.tex\nsynonyms.txt");
  });

  it("formats Bash interrupted and persisted results with hints", () => {
    const interrupted = bashToolEntry.formatModelContent?.({
      stdout: "",
      stderr: "partial failure",
      interrupted: true,
      status: "cancelled",
    } satisfies BashOutput);

    expect(interrupted).toBe(
      "partial failure\n<error>Command was aborted before completion</error>",
    );

    const persisted = bashToolEntry.formatModelContent?.({
      stdout: "x".repeat(20_000),
      stderr: "",
      interrupted: false,
      status: "completed",
      persistedOutputPath: "/tmp/stdout.log",
      stdoutBytes: 20_000,
      stderrBytes: 0,
    } satisfies BashOutput);

    expect(persisted).toContain("<persisted-output>");
    expect(persisted).toContain("Full output saved to: /tmp/stdout.log");
    expect(persisted).toContain("Preview (first 2KB):");
    expect(persisted).toContain("</persisted-output>");
  });

  it("keeps Bash stale read hints visible without JSON serialization", () => {
    const modelContent = bashToolEntry.formatModelContent?.({
      stdout: "updated\n",
      stderr: "",
      interrupted: false,
      status: "completed",
      staleReadFileStateHint: "Previously read files changed; re-read before editing.",
    } satisfies BashOutput);

    expect(modelContent).toBe("updated\nPreviously read files changed; re-read before editing.");
  });

  it("backfills readFileState from successful cat before Edit", async () => {
    const filePath = resolve(defaultCommandRoot, ".env.example");
    const readFileState: ReadFileStateMap = new Map();
    const fileSystemPort = memoryFileSystemPort({
      [filePath]: {
        content: "FOO=bar\n",
        mtimeMs: 1000,
      },
    });
    const executionPort: ExecutionPort = {
      async run() {
        return executionResult({
          status: "completed",
          exitCode: 0,
          stdout: "FOO=bar\n",
        });
      },
    };

    await bashHandler(
      { command: "cat .env.example" },
      contextWith(executionPort, { fileSystemPort, readFileState }),
    );

    const entry = readFileState.get(createReadFileStatePathKey(filePath));
    expect(entry).toMatchObject({
      path: filePath,
      content: "FOO=bar\n",
      offset: undefined,
      limit: undefined,
      isPartialView: false,
      mtimeMs: 1000,
      sizeBytes: Buffer.byteLength("FOO=bar\n"),
    });
  });

  it("backfills ranged readFileState for head tail and sed print commands", async () => {
    const filePath = resolve(defaultCommandRoot, "fixture.txt");
    const fileSystemPort = memoryFileSystemPort({
      [filePath]: {
        content: "a\nb\nc\nd\ne\n",
        mtimeMs: 1000,
      },
    });
    const cases = [
      {
        command: "head -n 2 fixture.txt",
        expectedContent: "a\nb",
        expectedOffset: 1,
        expectedLimit: 2,
      },
      {
        command: "tail -n 2 fixture.txt",
        expectedContent: "d\ne",
        expectedOffset: 4,
        expectedLimit: 2,
      },
      {
        command: "sed -n '2,3p' fixture.txt",
        expectedContent: "b\nc",
        expectedOffset: 2,
        expectedLimit: 2,
      },
    ];

    for (const testCase of cases) {
      const readFileState: ReadFileStateMap = new Map();
      const executionPort: ExecutionPort = {
        async run() {
          return executionResult({
            status: "completed",
            exitCode: 0,
            stdout: testCase.expectedContent,
          });
        },
      };

      await bashHandler(
        { command: testCase.command },
        contextWith(executionPort, { fileSystemPort, readFileState }),
      );

      const entry = readFileState.get(createReadFileStatePathKey(filePath));
      expect(entry).toMatchObject({
        path: filePath,
        content: testCase.expectedContent,
        offset: testCase.expectedOffset,
        limit: testCase.expectedLimit,
        isPartialView: false,
      });
    }
  });

  it("backfills full readFileState for grep only when grep exits zero", async () => {
    const filePath = resolve(defaultCommandRoot, "fixture.txt");
    const fileSystemPort = memoryFileSystemPort({
      [filePath]: {
        content: "needle\nhaystack\n",
        mtimeMs: 1000,
      },
    });
    const successState: ReadFileStateMap = new Map();
    const successPort: ExecutionPort = {
      async run() {
        return executionResult({
          status: "completed",
          exitCode: 0,
          stdout: "needle\n",
        });
      },
    };

    await bashHandler(
      { command: "grep needle fixture.txt" },
      contextWith(successPort, { fileSystemPort, readFileState: successState }),
    );

    expect(successState.get(createReadFileStatePathKey(filePath))).toMatchObject({
      path: filePath,
      content: "needle\nhaystack\n",
      offset: undefined,
      limit: undefined,
    });

    const missState: ReadFileStateMap = new Map();
    const missPort: ExecutionPort = {
      async run() {
        return executionResult({
          status: "failed",
          exitCode: 1,
          stdout: "",
        });
      },
    };

    await bashHandler(
      { command: "grep missing fixture.txt" },
      contextWith(missPort, { fileSystemPort, readFileState: missState }),
    );

    expect(missState.size).toBe(0);
  });

  it("does not backfill readFileState when Bash exits with provider error", async () => {
    const filePath = resolve(defaultCommandRoot, "fixture.txt");
    const readFileState: ReadFileStateMap = new Map();
    const fileSystemPort = memoryFileSystemPort({
      [filePath]: {
        content: "visible before failure\n",
        mtimeMs: 1000,
      },
    });
    const executionPort: ExecutionPort = {
      async run() {
        return executionResult({
          status: "failed",
          exitCode: 2,
          stdout: "visible before failure\n",
          stderr: "later command failed\n",
        });
      },
    };

    await bashHandler(
      { command: "cat fixture.txt" },
      contextWith(executionPort, { fileSystemPort, readFileState }),
    );

    expect(readFileState.get(createReadFileStatePathKey(filePath))).toBeUndefined();
  });

  it("does not backfill readFileState for complex or unsafe Bash read commands", async () => {
    const filePath = resolve(defaultCommandRoot, "fixture.txt");
    const fileSystemPort = memoryFileSystemPort({
      [filePath]: {
        content: "a\nb\n",
        mtimeMs: 1000,
      },
      [resolve(defaultCommandRoot, "other.txt")]: {
        content: "c\n",
        mtimeMs: 1000,
      },
    });
    const unsafeCommands = [
      "cat fixture.txt | head",
      "cat fixture.txt > out.txt",
      'cat "$TARGET"',
      "cat fixture.txt other.txt",
      "sed -i 's/a/b/' fixture.txt",
      "head -n 0 fixture.txt",
    ];

    for (const command of unsafeCommands) {
      const readFileState: ReadFileStateMap = new Map();
      const executionPort: ExecutionPort = {
        async run() {
          return executionResult({
            status: "completed",
            exitCode: 0,
            stdout: "ignored\n",
          });
        },
      };

      await bashHandler({ command }, contextWith(executionPort, { fileSystemPort, readFileState }));

      expect(readFileState.size).toBe(0);
    }
  });

  it("emits stale read hint when a write-like Bash command modifies a previously read file", async () => {
    const filePath = resolve(defaultCommandRoot, "fixture.ts");
    const readFileState: ReadFileStateMap = new Map();
    readFileState.set(createReadFileStatePathKey(filePath), {
      path: filePath,
      content: "old\n",
      isPartialView: false,
      readAt: new Date(500),
      sourceTool: "Read",
      mtimeMs: 1000,
      sizeBytes: 4,
    });
    const fileSystemPort = memoryFileSystemPort({
      [filePath]: {
        content: "new\n",
        mtimeMs: 2000,
      },
    });
    const executionPort: ExecutionPort = {
      async run() {
        return executionResult({
          status: "completed",
          exitCode: 0,
          stdout: "formatted\n",
          startedAt: new Date(1500),
        });
      },
    };

    const output = (await bashHandler(
      { command: "pnpm format" },
      contextWith(executionPort, { fileSystemPort, readFileState }),
    )) as BashOutput;

    const expectedHint = `[This command modified 1 file you've previously read: fixture.ts. Call Read before editing.]`;
    expect(output.staleReadFileStateHint).toBe(expectedHint);
    expect(bashToolEntry.formatModelContent?.(output)).toContain(expectedHint);
  });

  it("does not emit stale hint when write-like Bash exits with provider error", async () => {
    const filePath = resolve(defaultCommandRoot, "fixture.ts");
    const readFileState: ReadFileStateMap = new Map();
    readFileState.set(createReadFileStatePathKey(filePath), {
      path: filePath,
      content: "old\n",
      isPartialView: false,
      readAt: new Date(500),
      sourceTool: "Read",
      mtimeMs: 1000,
      sizeBytes: 4,
    });
    const fileSystemPort = memoryFileSystemPort({
      [filePath]: {
        content: "new\n",
        mtimeMs: 2000,
      },
    });
    const executionPort: ExecutionPort = {
      async run() {
        return executionResult({
          status: "failed",
          exitCode: 2,
          stderr: "format failed",
          startedAt: new Date(1500),
        });
      },
    };

    const output = (await bashHandler(
      { command: "pnpm format" },
      contextWith(executionPort, { fileSystemPort, readFileState }),
    )) as BashOutput;

    expect(output.staleReadFileStateHint).toBeUndefined();
    expect(bashToolEntry.formatModelContent?.(output)).not.toContain("Call Read before editing");
  });

  it("formats stale hint paths when many read files changed", async () => {
    const changedFilePaths = Array.from({ length: 6 }, (_, index) =>
      resolve(defaultCommandRoot, `fixture-${index + 1}.ts`),
    );
    const readFileState: ReadFileStateMap = new Map();
    for (const filePath of changedFilePaths) {
      readFileState.set(createReadFileStatePathKey(filePath), {
        path: filePath,
        content: "old\n",
        isPartialView: false,
        readAt: new Date(500),
        sourceTool: "Read",
        mtimeMs: 1000,
        sizeBytes: 4,
      });
    }
    const fileSystemPort = memoryFileSystemPort(
      Object.fromEntries(
        changedFilePaths.map((filePath) => [
          filePath,
          {
            content: "new\n",
            mtimeMs: 2000,
          },
        ]),
      ),
    );
    const executionPort: ExecutionPort = {
      async run() {
        return executionResult({
          status: "completed",
          exitCode: 0,
          stdout: "formatted\n",
          startedAt: new Date(1500),
        });
      },
    };

    const output = (await bashHandler(
      { command: "pnpm format" },
      contextWith(executionPort, { fileSystemPort, readFileState }),
    )) as BashOutput;

    const expectedHint =
      "[This command modified 6 files you've previously read: fixture-1.ts, fixture-2.ts, fixture-3.ts, fixture-4.ts, fixture-5.ts and 1 more. Call Read before editing.]";
    expect(output.staleReadFileStateHint).toBe(expectedHint);
    expect(bashToolEntry.formatModelContent?.(output)).toContain(expectedHint);
  });

  it("stats stale hint candidates concurrently", async () => {
    const changedFilePaths = Array.from({ length: 3 }, (_, index) =>
      resolve(defaultCommandRoot, `fixture-${index + 1}.ts`),
    );
    const readFileState: ReadFileStateMap = new Map();
    for (const filePath of changedFilePaths) {
      readFileState.set(createReadFileStatePathKey(filePath), {
        path: filePath,
        content: "old\n",
        isPartialView: false,
        readAt: new Date(500),
        sourceTool: "Read",
        mtimeMs: 1000,
        sizeBytes: 4,
      });
    }
    const baseFileSystemPort = memoryFileSystemPort(
      Object.fromEntries(
        changedFilePaths.map((filePath) => [
          filePath,
          {
            content: "new\n",
            mtimeMs: 2000,
          },
        ]),
      ),
    );
    let statsInFlight = 0;
    let maxStatsInFlight = 0;
    const fileSystemPort: FileSystemPort = {
      ...baseFileSystemPort,
      async stat(request, options) {
        statsInFlight += 1;
        maxStatsInFlight = Math.max(maxStatsInFlight, statsInFlight);
        try {
          await Promise.resolve();
          return await baseFileSystemPort.stat(request, options);
        } finally {
          statsInFlight -= 1;
        }
      },
    };
    const executionPort: ExecutionPort = {
      async run() {
        return executionResult({
          status: "completed",
          exitCode: 0,
          stdout: "formatted\n",
          startedAt: new Date(1500),
        });
      },
    };

    await bashHandler(
      { command: "pnpm format" },
      contextWith(executionPort, { fileSystemPort, readFileState }),
    );

    expect(maxStatsInFlight).toBeGreaterThan(1);
  });

  it("accepts supported cat head tail sed and grep flag variants for read-state backfill", async () => {
    const filePath = resolve(defaultCommandRoot, "fixture.txt");
    const fileSystemPort = memoryFileSystemPort({
      [filePath]: {
        content: "a\nb\nc\nd\ne\n",
        mtimeMs: 1000,
      },
    });
    const cases = [
      {
        command: "cat -n fixture.txt",
        expectedContent: "a\nb\nc\nd\ne\n",
        expectedOffset: undefined,
        expectedLimit: undefined,
      },
      {
        command: "cat --number fixture.txt",
        expectedContent: "a\nb\nc\nd\ne\n",
        expectedOffset: undefined,
        expectedLimit: undefined,
      },
      {
        command: "head --lines=2 fixture.txt",
        expectedContent: "a\nb",
        expectedOffset: 1,
        expectedLimit: 2,
      },
      {
        command: "head -2 fixture.txt",
        expectedContent: "a\nb",
        expectedOffset: 1,
        expectedLimit: 2,
      },
      {
        command: "tail --lines 2 fixture.txt",
        expectedContent: "d\ne",
        expectedOffset: 4,
        expectedLimit: 2,
      },
      {
        command: "sed --quiet '3p' fixture.txt",
        expectedContent: "c",
        expectedOffset: 3,
        expectedLimit: 1,
      },
      {
        command: "grep -n --color=never c fixture.txt",
        expectedContent: "a\nb\nc\nd\ne\n",
        expectedOffset: undefined,
        expectedLimit: undefined,
      },
    ];

    for (const testCase of cases) {
      const readFileState: ReadFileStateMap = new Map();
      const executionPort: ExecutionPort = {
        async run() {
          return executionResult({
            status: "completed",
            exitCode: 0,
            stdout: testCase.expectedContent,
          });
        },
      };

      await bashHandler(
        { command: testCase.command },
        contextWith(executionPort, { fileSystemPort, readFileState }),
      );

      expect(readFileState.get(createReadFileStatePathKey(filePath))).toMatchObject({
        content: testCase.expectedContent,
        offset: testCase.expectedOffset,
        limit: testCase.expectedLimit,
      });
    }
  });

  it("rejects unsupported read-state backfill variants", async () => {
    const filePath = resolve(defaultCommandRoot, "fixture.txt");
    const fileSystemPort = memoryFileSystemPort({
      [filePath]: {
        content: "a\nb\nc\n",
        mtimeMs: 1000,
      },
    });
    const rejectedCommands = ["sed --expression '3p' fixture.txt", 'grep needle "*.txt"'];

    for (const command of rejectedCommands) {
      const readFileState: ReadFileStateMap = new Map();
      const executionPort: ExecutionPort = {
        async run() {
          return executionResult({
            status: "completed",
            exitCode: 0,
            stdout: "ignored\n",
          });
        },
      };

      await bashHandler({ command }, contextWith(executionPort, { fileSystemPort, readFileState }));

      expect(readFileState.size).toBe(0);
    }
  });

  it("does not backfill readFileState for files over 10MB or existing read state paths", async () => {
    const largePath = resolve(defaultCommandRoot, "large.txt");
    const existingPath = resolve(defaultCommandRoot, "existing.txt");
    const existingKey = createReadFileStatePathKey(existingPath);
    const readFileState: ReadFileStateMap = new Map([
      [
        existingKey,
        {
          path: existingPath,
          content: "old\n",
          isPartialView: false,
          readAt: new Date(500),
          sourceTool: "Read",
          mtimeMs: 1000,
          sizeBytes: 4,
        },
      ],
    ]);
    const fileSystemPort = memoryFileSystemPort({
      [largePath]: {
        content: "x".repeat(10 * 1024 * 1024 + 1),
        mtimeMs: 1000,
      },
      [existingPath]: {
        content: "new\n",
        mtimeMs: 2000,
      },
    });
    const executionPort: ExecutionPort = {
      async run(request) {
        return executionResult({
          status: "completed",
          exitCode: 0,
          stdout: request.command.command.includes("large") ? "" : "new\n",
        });
      },
    };

    await bashHandler(
      { command: "cat large.txt" },
      contextWith(executionPort, { fileSystemPort, readFileState }),
    );
    await bashHandler(
      { command: "cat existing.txt" },
      contextWith(executionPort, { fileSystemPort, readFileState }),
    );

    expect(readFileState.get(createReadFileStatePathKey(largePath))).toBeUndefined();
    expect(readFileState.get(existingKey)?.content).toBe("old\n");
  });

  it("does not backfill readFileState when Bash file read is truncated", async () => {
    const filePath = resolve(defaultCommandRoot, "fixture.txt");
    const readFileState: ReadFileStateMap = new Map();
    const fileSystemPort = memoryFileSystemPort({
      [filePath]: {
        content: "partial\n",
        mtimeMs: 1000,
        truncated: true,
      },
    });
    const executionPort: ExecutionPort = {
      async run() {
        return executionResult({
          status: "completed",
          exitCode: 0,
          stdout: "partial\n",
        });
      },
    };

    await bashHandler(
      { command: "cat fixture.txt" },
      contextWith(executionPort, { fileSystemPort, readFileState }),
    );

    expect(readFileState.get(createReadFileStatePathKey(filePath))).toBeUndefined();
  });

  it("does not backfill readFileState when Bash stdout is truncated", async () => {
    const filePath = resolve(defaultCommandRoot, "fixture.txt");
    const readFileState: ReadFileStateMap = new Map();
    const fileSystemPort = memoryFileSystemPort({
      [filePath]: {
        content: "full content hidden from model\n",
        mtimeMs: 1000,
      },
    });
    const executionPort: ExecutionPort = {
      async run() {
        return executionResult({
          status: "completed",
          exitCode: 0,
          stdout: "full",
          stdoutTruncated: true,
        });
      },
    };

    await bashHandler(
      { command: "cat fixture.txt" },
      contextWith(executionPort, { fileSystemPort, readFileState }),
    );

    expect(readFileState.get(createReadFileStatePathKey(filePath))).toBeUndefined();
  });

  it("does not reject completed Bash output when read-state parsing sees an empty path", async () => {
    const readFileState: ReadFileStateMap = new Map();
    const executionPort: ExecutionPort = {
      async run() {
        return executionResult({
          status: "completed",
          exitCode: 0,
          stdout: "",
        });
      },
    };

    await expect(
      bashHandler(
        { command: "cat ''" },
        contextWith(executionPort, {
          fileSystemPort: memoryFileSystemPort({}),
          readFileState,
        }),
      ),
    ).resolves.toMatchObject({ status: "completed" });
    expect(readFileState.size).toBe(0);
  });

  it("ignores stale hint candidates unless mtime is newer than both Bash start and read state", async () => {
    const filePath = resolve(defaultCommandRoot, "fixture.ts");
    const readFileState: ReadFileStateMap = new Map();
    readFileState.set(createReadFileStatePathKey(filePath), {
      path: filePath,
      content: "old\n",
      isPartialView: false,
      readAt: new Date(500),
      sourceTool: "Read",
      mtimeMs: 1000,
      sizeBytes: 4,
    });
    const fileSystemPort = memoryFileSystemPort({
      [filePath]: {
        content: "new\n",
        mtimeMs: 1400,
      },
    });
    const executionPort: ExecutionPort = {
      async run() {
        return executionResult({
          status: "completed",
          exitCode: 0,
          stdout: "formatted\n",
          startedAt: new Date(1500),
        });
      },
    };

    const output = (await bashHandler(
      { command: "pnpm format" },
      contextWith(executionPort, { fileSystemPort, readFileState }),
    )) as BashOutput;

    expect(output.staleReadFileStateHint).toBeUndefined();
  });

  it("ignores stale hint candidates that cannot be stat'ed", async () => {
    const filePath = resolve(defaultCommandRoot, "missing.ts");
    const readFileState: ReadFileStateMap = new Map();
    readFileState.set(createReadFileStatePathKey(filePath), {
      path: filePath,
      content: "old\n",
      isPartialView: false,
      readAt: new Date(500),
      sourceTool: "Read",
      mtimeMs: 1000,
      sizeBytes: 4,
    });
    const executionPort: ExecutionPort = {
      async run() {
        return executionResult({
          status: "completed",
          exitCode: 0,
          stdout: "formatted\n",
          startedAt: new Date(1500),
        });
      },
    };

    const output = (await bashHandler(
      { command: "pnpm format" },
      contextWith(executionPort, {
        fileSystemPort: memoryFileSystemPort({}),
        readFileState,
      }),
    )) as BashOutput;

    expect(output.staleReadFileStateHint).toBeUndefined();
  });

  it("formats background Bash output paths for the model", () => {
    const modelContent = bashToolEntry.formatModelContent?.({
      stdout: "",
      stderr: "",
      interrupted: false,
      status: "backgrounded",
      backgroundTaskId: "exec_bg",
      persistedOutputPath: "/tmp/exec_bg-stdout.log",
      stdoutPersistedOutputPath: "/tmp/exec_bg-stdout.log",
      stderrPersistedOutputPath: "/tmp/exec_bg-stderr.log",
    } satisfies BashOutput);

    expect(modelContent).toBe(
      "Command running in background with ID: exec_bg. Output is being written to: /tmp/exec_bg-stdout.log. You will be notified when it completes. To check interim output, use Read on that file path.",
    );
  });
});

function contextWith(
  executionPort: ExecutionPort,
  options: {
    abortSignal?: AbortSignal;
    bashShellSelection?: ToolExecutionContext["bashShellSelection"];
    embeddedSearch?: ToolExecutionContext["embeddedSearch"];
    emitEvent?: ToolExecutionContext["emitEvent"];
    fileSystemPort?: FileSystemPort;
    imageProcessorPort?: ImageProcessorPort;
    offPeakTurn?: boolean;
    readFileState?: ReadFileStateMap;
    runtimeScope?: ToolExecutionContext["runtimeScope"];
    setWorkingDirectory?: ToolExecutionContext["setWorkingDirectory"];
    telemetry?: ToolExecutionSpanWriter;
    workingDirectory?: string;
    workspaceRoot?: string;
  } = {},
): ToolExecutionContext {
  return {
    toolCallId: "tool_test",
    traceId: "trace_test",
    spanId: "span_test",
    abortSignal: options.abortSignal ?? new AbortController().signal,
    bashShellSelection: options.bashShellSelection,
    embeddedSearch: options.embeddedSearch,
    emitEvent: options.emitEvent,
    executionPort,
    fileSystemPort: options.fileSystemPort,
    imageProcessorPort: options.imageProcessorPort,
    offPeakTurn: options.offPeakTurn,
    readFileState: options.readFileState,
    runtimeScope: options.runtimeScope,
    setWorkingDirectory: options.setWorkingDirectory,
    telemetry: options.telemetry,
    workingDirectory: options.workingDirectory ?? defaultCommandRoot,
    workspaceRoot: options.workspaceRoot ?? defaultCommandRoot,
    sessionId: "sess_test",
    turnId: "turn_test",
  };
}

function recordingBashTelemetry(outcomes: string[]): ToolExecutionSpanWriter {
  const command: CommandExecutionSpanWriter = {
    captureCausation: () => undefined,
    finishBackgrounded() {
      outcomes.push("backgrounded");
    },
    finishCancelled() {
      outcomes.push("cancelled");
    },
    finishCompleted() {
      outcomes.push("completed");
    },
    finishFailed(stage) {
      outcomes.push(`failed:${stage}`);
    },
    markFirstOutput() {},
    markTerminationRequested() {},
    run: (execute) => execute(),
    setExitCode(exitCode) {
      outcomes.push(`exit:${exitCode}`);
    },
    setOutputBytes() {},
    setSignal() {},
    setTimedOut() {},
  };
  return {
    captureCausation: () => undefined,
    finishCancelled() {},
    finishCompleted() {},
    finishDenied() {},
    finishFailed() {},
    markPermissionRequested() {},
    run: (execute) => execute(),
    setOutputBytes() {},
    setOutputTruncated() {},
    setPermissionDecision() {},
    startCommand: () => command,
  };
}

function executionResult(options: {
  status: ExecutionResult["status"];
  exitCode?: number;
  stdout?: string;
  stdoutBytes?: number;
  stderr?: string;
  stderrBytes?: number;
  stdoutArtifactPath?: string;
  stdoutArtifactBytes?: number;
  stdoutTruncated?: boolean;
  stderrArtifactPath?: string;
  stderrArtifactBytes?: number;
  stderrTruncated?: boolean;
  error?: ExecutionResult["error"];
  resolvedCwd?: string;
  startedAt?: Date;
  completedAt?: Date;
  timedOut?: boolean;
}): ExecutionResult {
  const now = new Date();
  const startedAt = options.startedAt ?? now;
  const completedAt = options.completedAt ?? startedAt;
  return {
    status: options.status,
    exitCode: options.exitCode,
    stdout: {
      text: options.stdout ?? "",
      bytes: options.stdoutBytes ?? Buffer.byteLength(options.stdout ?? ""),
      truncated: options.stdoutTruncated ?? false,
      artifactPath: options.stdoutArtifactPath,
      artifactBytes: options.stdoutArtifactBytes,
    },
    stderr: {
      text: options.stderr ?? "",
      bytes: options.stderrBytes ?? Buffer.byteLength(options.stderr ?? ""),
      truncated: options.stderrTruncated ?? false,
      artifactPath: options.stderrArtifactPath,
      artifactBytes: options.stderrArtifactBytes,
    },
    durationMs: 1,
    timedOut: options.timedOut ?? false,
    cancelled: false,
    startedAt,
    completedAt,
    error: options.error,
    resolvedCwd: options.resolvedCwd,
  };
}

function memoryFileSystemPort(
  files: Record<
    string,
    {
      content: string;
      mtimeMs?: number;
      revisionId?: string;
      truncated?: boolean;
    }
  >,
): FileSystemPort {
  const port: Partial<FileSystemPort> = {
    async stat(request) {
      const file = files[request.path];
      if (!file) {
        throw new Error(`missing fixture file: ${request.path}`);
      }
      const sizeBytes = Buffer.byteLength(file.content);
      return {
        path: request.path,
        kind: "file",
        sizeBytes,
        mtimeMs: file.mtimeMs,
        revision: {
          id: file.revisionId ?? `${request.path}:${file.mtimeMs ?? 0}`,
          mtimeMs: file.mtimeMs,
          sizeBytes,
        },
      } satisfies FileSystemStatResult;
    },
    async readTextFile(request) {
      const file = files[request.path];
      if (!file) {
        throw new Error(`missing fixture file: ${request.path}`);
      }
      const sizeBytes = Buffer.byteLength(file.content);
      return {
        path: request.path,
        content: file.content,
        encoding: "utf8",
        bytesRead: sizeBytes,
        sizeBytes,
        truncated: file.truncated === true,
        revision: {
          id: file.revisionId ?? `${request.path}:${file.mtimeMs ?? 0}`,
          mtimeMs: file.mtimeMs,
          sizeBytes,
        },
      } satisfies FileSystemReadTextResult;
    },
  };
  return port as FileSystemPort;
}
