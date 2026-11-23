import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { execFileSync } from "node:child_process";
import iconv from "iconv-lite";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";

const { statfsMock } = vi.hoisted(() => ({
  statfsMock: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  statfsMock.mockImplementation(actual.statfs);
  return {
    ...actual,
    statfs: statfsMock,
  };
});

import {
  applyResolvedShellCommandForTest,
  buildExecutionEnv,
  decodeExecutionOutputBuffer,
  NodeExecutionAdapter,
  resolveExecutionCommand,
  setResolvedShellLoginMode,
} from "../src/exec/index.js";
import {
  resolveEffectiveBashShellSelection,
  resolveWindowsGitBashShell,
} from "../src/exec/bash-shell-provider.js";
import { resolveBashMaxOutputLength } from "../src/exec/bash-output-policy.js";
import { createCwdCapturePlan, normalizeCapturedCwdForHost } from "../src/exec/cwd-capture.js";
import {
  type BackgroundExecutionSnapshot,
  type BackgroundExecutionStartResult,
  gitBashPathToWindowsPath,
  type ExecutionEvent,
  type ExecutionResult,
  type ExecutionRequest,
  type ExecutionRunOptions,
  windowsPathToGitBashPath,
} from "@zcode/contracts";
import { ZCODE_NO_PROXY_ENV_KEY, ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY } from "@zcode/shared";
import { discoverWindowsGitBash } from "@zcode/shared/node";
import * as sharedNode from "@zcode/shared/node";

const POSIX_BASH_PATH =
  process.platform === "win32"
    ? undefined
    : findExecutable(["bash", "/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash"]);
const WINDOWS_GIT_BASH_PATH =
  process.platform === "win32" ? await resolveWindowsGitBashShell(process.env) : undefined;

function findExecutable(candidates: Array<string | undefined>): string | undefined {
  return candidates.find((candidate) => candidate !== undefined && commandExists(candidate));
}

function commandExists(command: string): command is string {
  try {
    execFileSync(command, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

type BashBackgroundLifecycleCapableAdapter = NodeExecutionAdapter & {
  runBashWithBackgroundLifecycle?: (
    request: ExecutionRequest,
    lifecycle: { mode: "explicit" | "auto_on_timeout" },
    options?: ExecutionRunOptions,
  ) => Promise<
    | {
        kind: "foreground";
        result: ExecutionResult;
      }
    | {
        kind: "backgrounded";
        task: BackgroundExecutionStartResult;
      }
  >;
  waitForBackgroundTask?: (
    taskId: string,
    options?: { signal?: AbortSignal },
  ) => Promise<BackgroundExecutionSnapshot | undefined>;
};

describe("NodeExecutionAdapter", () => {
  it.each(["abort", "close"] as const)(
    "does not initialize shell snapshots when cancelled during Windows Git Bash discovery (%s)",
    async (stopMode) => {
      const root = await mkdtemp(join(tmpdir(), "zcode-discovery-cancel-"));
      const adapter = new NodeExecutionAdapter({
        outputRootDir: root,
        platform: "win32",
        processEnv: {},
      });
      const controller = new AbortController();
      const discoveryEntered = Promise.withResolvers<void>();
      const discoveryReleased =
        Promise.withResolvers<Awaited<ReturnType<typeof discoverWindowsGitBash>>>();
      const discover = vi.spyOn(sharedNode, "discoverWindowsGitBash").mockImplementation(() => {
        discoveryEntered.resolve();
        return discoveryReleased.promise;
      });
      const snapshots = (
        adapter as unknown as {
          shellInitSnapshots: { getOrCreate: () => Promise<undefined> };
        }
      ).shellInitSnapshots;
      const getOrCreate = vi.spyOn(snapshots, "getOrCreate").mockResolvedValue(undefined);
      const events: ExecutionEvent[] = [];
      let running: Promise<ExecutionResult> | undefined;
      let closing: Promise<void> | undefined;

      try {
        running = adapter.run(
          { command: { mode: "shell", command: "printf unexpected", shellProfile: "posix-bash" } },
          {
            signal: controller.signal,
            onEvent: (event) => {
              events.push(event);
            },
          },
        );
        await discoveryEntered.promise;
        if (stopMode === "abort") controller.abort();
        else closing = adapter.close();
        discoveryReleased.resolve({ path: "D:\\IsolatedGit\\bin\\bash.exe", source: "system" });

        expect(await running).toMatchObject({ status: "cancelled", cancelled: true });
        await closing;
        // 新增发现 await 期间可以取消；恢复准备时必须先检查取消，不能再启动 shell 初始化执行用户 rc。
        expect(getOrCreate).not.toHaveBeenCalled();
        expect(events.some((event) => event.type === "started")).toBe(false);
      } finally {
        discoveryReleased.resolve(undefined);
        await running;
        discover.mockRestore();
        getOrCreate.mockRestore();
        await adapter.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("auto-backgrounds a foreground command when its timeout elapses", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-exec-auto-background-"));
    const adapter = new NodeExecutionAdapter({
      outputRootDir: root,
      progressIntervalMs: 10,
      progressThresholdMs: 1,
    });
    const capable = adapter as BashBackgroundLifecycleCapableAdapter;

    try {
      const result = await capable.runBashWithBackgroundLifecycle!(
        {
          command: {
            mode: "argv",
            file: process.execPath,
            args: ["-e", "setTimeout(() => process.stdout.write('late'), 60)"],
          },
          timeoutMs: 10,
          outputLimit: {
            persistOutput: "always",
          },
          trace: {
            sessionId: "exec-auto-background-session",
            attributes: {
              toolCallId: "toolu_auto_background",
            },
          } as any,
        },
        { mode: "auto_on_timeout" },
      );

      expect(result.kind).toBe("backgrounded");
      expect(result.task.taskId).toMatch(/^exec_/u);

      const snapshot = await capable.waitForBackgroundTask!(result.task.taskId);
      expect(snapshot?.status).toBe("completed");
      expect(snapshot?.result?.stdout.text).toBe("late");
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps explicit background execution alive after its input timeout", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-exec-explicit-background-timeout-"));
    const adapter = new NodeExecutionAdapter({ outputRootDir: root });
    const capable = adapter as BashBackgroundLifecycleCapableAdapter;

    try {
      const result = await capable.runBashWithBackgroundLifecycle!(
        {
          command: {
            mode: "argv",
            file: process.execPath,
            args: ["-e", "setTimeout(() => process.stdout.write('survived'), 80)"],
          },
          timeoutMs: 5,
          trace: {
            sessionId: "exec-explicit-background-timeout-session",
            attributes: { toolCallId: "toolu_explicit_background_timeout" },
          } as any,
        },
        { mode: "explicit" },
      );

      expect(result.kind).toBe("backgrounded");
      await sleep(25);
      expect((await capable.getBackgroundTask(result.task.taskId))?.status).toBe("running");
      const snapshot = await capable.waitForBackgroundTask!(result.task.taskId);
      expect(snapshot?.status).toBe("completed");
      expect(snapshot?.result?.stdout.text).toBe("survived");
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("detaches parent abort after an explicit background commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-exec-explicit-background-detach-"));
    const adapter = new NodeExecutionAdapter({ outputRootDir: root });
    const capable = adapter as BashBackgroundLifecycleCapableAdapter;
    const parentTurn = new AbortController();

    try {
      const result = await capable.runBashWithBackgroundLifecycle!(
        {
          command: {
            mode: "argv",
            file: process.execPath,
            args: ["-e", "setTimeout(() => process.stdout.write('detached'), 70)"],
          },
          timeoutMs: 5,
          trace: {
            sessionId: "exec-explicit-background-detach-session",
            attributes: { toolCallId: "toolu_explicit_background_detach" },
          } as any,
        },
        { mode: "explicit" },
        { signal: parentTurn.signal },
      );

      expect(result.kind).toBe("backgrounded");
      parentTurn.abort();
      const snapshot = await capable.waitForBackgroundTask!(result.task.taskId);
      expect(snapshot?.status).toBe("completed");
      expect(snapshot?.result?.stdout.text).toBe("detached");
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("still allows an explicit lifecycle task to be stopped directly", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-exec-explicit-background-stop-"));
    const adapter = new NodeExecutionAdapter({ outputRootDir: root });
    const capable = adapter as BashBackgroundLifecycleCapableAdapter;

    try {
      const result = await capable.runBashWithBackgroundLifecycle!(
        {
          command: {
            mode: "argv",
            file: process.execPath,
            args: ["-e", "setTimeout(() => process.stdout.write('unexpected'), 10_000)"],
          },
          timeoutMs: 5,
        },
        { mode: "explicit" },
      );

      expect(result.kind).toBe("backgrounded");
      const stopped = await capable.cancelBackgroundTask(result.task.taskId);
      expect(stopped?.status).toBe("cancelled");
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(!POSIX_BASH_PATH || process.platform === "win32")(
    "kills a cooperative Bash descendant outside the root process group",
    async () => {
      const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-exec-cross-pgid-stop-"));
      const adapter = new NodeExecutionAdapter({
        outputRootDir,
        progressIntervalMs: 10,
        progressThresholdMs: 0,
      });
      const capable = adapter as BashBackgroundLifecycleCapableAdapter;
      let launcherPid = Number.NaN;
      let workerPid = Number.NaN;
      const workerScript = [
        "process.stdout.write('worker:' + process.pid + '\\n');",
        "setInterval(() => {}, 10_000);",
      ].join("");
      const launcherScript = [
        "const { spawn } = require('node:child_process');",
        "process.stdout.write('launcher:' + process.pid + '\\n');",
        `const worker = spawn(process.execPath, ['-e', ${JSON.stringify(workerScript)}], { stdio: ['ignore', 'inherit', 'inherit'] });`,
        "worker.on('exit', () => process.exit());",
        "setInterval(() => {}, 10_000);",
      ].join("");

      try {
        const result = await capable.runBashWithBackgroundLifecycle!(
          {
            command: {
              mode: "shell",
              command: `set -m; ${quotePosixShellArgument(process.execPath)} -e ${quotePosixShellArgument(launcherScript)} & wait`,
              shellProfile: "posix-bash",
              shellOverride: {
                dialect: "posix",
                display: { name: "bash" },
                path: POSIX_BASH_PATH!,
                source: "auto-detected",
              },
            },
          },
          { mode: "explicit" },
        );

        expect(result.kind).toBe("backgrounded");
        let runningSnapshot = await adapter.getBackgroundTask(result.task.taskId);
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const output = await readFile(result.task.outputPath!, "utf8");
          launcherPid = Number(/launcher:(\d+)/u.exec(output)?.[1]);
          workerPid = Number(/worker:(\d+)/u.exec(output)?.[1]);
          if (
            Number.isInteger(launcherPid) &&
            launcherPid > 0 &&
            Number.isInteger(workerPid) &&
            workerPid > 0
          ) {
            break;
          }
          await sleep(20);
          runningSnapshot = await adapter.getBackgroundTask(result.task.taskId);
        }

        expect(Number.isInteger(launcherPid), JSON.stringify(runningSnapshot)).toBe(true);
        expect(Number.isInteger(workerPid), JSON.stringify(runningSnapshot)).toBe(true);
        expect(Number.isInteger(runningSnapshot?.pid)).toBe(true);
        expect(readPosixProcessGroupId(launcherPid)).not.toBe(
          readPosixProcessGroupId(runningSnapshot!.pid!),
        );
        expect(isProcessAlive(launcherPid)).toBe(true);
        expect(isProcessAlive(workerPid)).toBe(true);

        await adapter.cancelBackgroundTask(result.task.taskId);
        let launcherStillRunning = true;
        let workerStillRunning = true;
        for (let attempt = 0; attempt < 120; attempt += 1) {
          launcherStillRunning = isProcessAlive(launcherPid);
          workerStillRunning = isProcessAlive(workerPid);
          if (!launcherStillRunning && !workerStillRunning) break;
          await sleep(25);
        }

        expect(launcherStillRunning).toBe(false);
        expect(workerStillRunning).toBe(false);
        let terminalSnapshot = await adapter.getBackgroundTask(result.task.taskId);
        for (let attempt = 0; attempt < 100 && !terminalSnapshot?.result; attempt += 1) {
          await sleep(20);
          terminalSnapshot = await adapter.getBackgroundTask(result.task.taskId);
        }
        expect(terminalSnapshot).toMatchObject({
          status: "cancelled",
          result: { status: "cancelled" },
        });
      } finally {
        if (Number.isInteger(workerPid) && workerPid > 0 && isProcessAlive(workerPid)) {
          process.kill(workerPid, "SIGKILL");
        }
        if (Number.isInteger(launcherPid) && launcherPid > 0 && isProcessAlive(launcherPid)) {
          process.kill(launcherPid, "SIGKILL");
        }
        await adapter.close();
        await rm(outputRootDir, { force: true, recursive: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps Bash descendant enumeration out of generic argv cancellation",
    async () => {
      const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-exec-generic-group-stop-"));
      const adapter = new NodeExecutionAdapter({ outputRootDir });
      let workerPid = Number.NaN;
      const workerScript = "setInterval(() => {}, 10_000);";
      const launcherScript = [
        "const { spawn } = require('node:child_process');",
        `const worker = spawn(process.execPath, ['-e', ${JSON.stringify(workerScript)}], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });`,
        "process.stdout.write('worker:' + worker.pid + '\\n');",
        "worker.unref();",
        "setInterval(() => {}, 10_000);",
      ].join("");

      try {
        const started = await adapter.start({
          command: {
            mode: "argv",
            file: process.execPath,
            args: ["-e", launcherScript],
          },
        });

        let runningSnapshot = await adapter.getBackgroundTask(started.taskId);
        for (let attempt = 0; attempt < 100; attempt += 1) {
          workerPid = Number(/worker:(\d+)/u.exec(runningSnapshot?.stdoutTail ?? "")?.[1]);
          if (Number.isInteger(workerPid) && workerPid > 0) break;
          await sleep(20);
          runningSnapshot = await adapter.getBackgroundTask(started.taskId);
        }

        expect(Number.isInteger(workerPid), JSON.stringify(runningSnapshot)).toBe(true);
        expect(readPosixProcessGroupId(workerPid)).not.toBe(
          readPosixProcessGroupId(runningSnapshot!.pid!),
        );

        await adapter.cancelBackgroundTask(started.taskId);
        // Bug 根因：PPID 后代枚举属于 Bash runtime；通用 ExecutionPort 必须保留
        // 原有的进程组停止边界，不能顺带获得新的跨 PGID kill 能力。
        await sleep(850);
        expect(isProcessAlive(workerPid)).toBe(true);
      } finally {
        if (Number.isInteger(workerPid) && workerPid > 0 && isProcessAlive(workerPid)) {
          process.kill(workerPid, "SIGKILL");
        }
        await adapter.close();
        await rm(outputRootDir, { force: true, recursive: true });
      }
    },
  );

  it("cancels an explicit lifecycle task when the adapter closes", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-exec-explicit-background-close-"));
    const adapter = new NodeExecutionAdapter({ outputRootDir: root });
    const capable = adapter as BashBackgroundLifecycleCapableAdapter;

    try {
      const result = await capable.runBashWithBackgroundLifecycle!(
        {
          command: {
            mode: "argv",
            file: process.execPath,
            args: ["-e", "setTimeout(() => process.stdout.write('unexpected'), 10_000)"],
          },
          timeoutMs: 5,
        },
        { mode: "explicit" },
      );

      expect(result.kind).toBe("backgrounded");
      await adapter.close();
      const snapshot = await capable.getBackgroundTask(result.task.taskId);
      expect(snapshot?.status).toBe("cancelled");
      expect(snapshot?.result?.status).toBe("cancelled");
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cancels before background commit when the parent is already aborted", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-exec-explicit-background-pre-abort-"));
    const adapter = new NodeExecutionAdapter({ outputRootDir: root });
    const capable = adapter as BashBackgroundLifecycleCapableAdapter;
    const parentTurn = new AbortController();
    parentTurn.abort();

    try {
      const result = await capable.runBashWithBackgroundLifecycle!(
        {
          command: {
            mode: "argv",
            file: process.execPath,
            args: ["-e", "setTimeout(() => process.stdout.write('unexpected'), 30)"],
          },
          timeoutMs: 5,
          trace: {
            sessionId: "exec-explicit-background-pre-abort-session",
            attributes: { toolCallId: "toolu_explicit_background_pre_abort" },
          } as any,
        },
        { mode: "explicit" },
        { signal: parentTurn.signal },
      );

      expect(result.kind).toBe("foreground");
      expect(result.result.status).toBe("cancelled");
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns an explicit spawn failure without publishing a background task", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-exec-explicit-background-spawn-fail-"));
    const adapter = new NodeExecutionAdapter({ outputRootDir: root });
    const capable = adapter as BashBackgroundLifecycleCapableAdapter;

    try {
      const result = await capable.runBashWithBackgroundLifecycle!(
        {
          command: {
            mode: "argv",
            file: join(root, "missing-executable"),
          },
          timeoutMs: 5,
          trace: {
            sessionId: "exec-explicit-background-spawn-fail-session",
            attributes: { toolCallId: "toolu_explicit_background_spawn_fail" },
          } as any,
        },
        { mode: "explicit" },
      );

      expect(result.kind).toBe("foreground");
      expect(result.result.status).toBe("spawn_error");
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("settles completion, timeout, and abort boundary races exactly once", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-exec-background-races-"));
    const adapter = new NodeExecutionAdapter({ outputRootDir: root });
    const capable = adapter as BashBackgroundLifecycleCapableAdapter;
    const backgroundTaskIds = new Set<string>();

    try {
      for (let attempt = 0; attempt < 12; attempt++) {
        const parentTurn = new AbortController();
        let outcomeCount = 0;
        let forwardedTerminalEvents = 0;
        const childDelayMs = attempt % 3 === 2 ? 5 : 12;
        const result = await capable.runBashWithBackgroundLifecycle!(
          {
            command: {
              mode: "argv",
              file: process.execPath,
              args: [
                "-e",
                `setTimeout(() => process.stdout.write('race-${attempt}'), ${childDelayMs})`,
              ],
            },
            timeoutMs: 5,
            trace: {
              sessionId: `exec-background-race-${attempt}`,
              attributes: { toolCallId: `toolu_background_race_${attempt}` },
            } as any,
          },
          { mode: "auto_on_timeout" },
          {
            signal: parentTurn.signal,
            onEvent: (event) => {
              if (event.type === "completed" || event.type === "failed") {
                forwardedTerminalEvents += 1;
              }
              if (event.type === "started" && attempt % 3 === 0) {
                queueMicrotask(() => parentTurn.abort());
              } else if (event.type === "started" && attempt % 3 === 2) {
                setTimeout(() => parentTurn.abort(), 5);
              }
            },
          },
        ).then((outcome) => {
          outcomeCount += 1;
          return outcome;
        });

        if (result.kind === "backgrounded") {
          expect(backgroundTaskIds.has(result.task.taskId)).toBe(false);
          backgroundTaskIds.add(result.task.taskId);
          const snapshot = await capable.waitForBackgroundTask!(result.task.taskId);
          expect(snapshot?.status).toBe("completed");
        } else {
          expect(["cancelled", "completed"]).toContain(result.result.status);
        }
        await sleep(5);
        expect(outcomeCount).toBe(1);
        expect(forwardedTerminalEvents).toBeLessThanOrEqual(1);
      }
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stops forwarding foreground progress after auto-backgrounding", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-exec-auto-background-progress-"));
    const adapter = new NodeExecutionAdapter({
      outputRootDir: root,
      progressIntervalMs: 5,
      progressThresholdMs: 1,
    });
    const capable = adapter as BashBackgroundLifecycleCapableAdapter;
    const progressEvents: ExecutionEvent[] = [];

    try {
      const result = await capable.runBashWithBackgroundLifecycle!(
        {
          command: {
            mode: "argv",
            file: process.execPath,
            args: [
              "-e",
              [
                "let writes = 0;",
                "const timer = setInterval(() => {",
                "  process.stdout.write(String(writes));",
                "  writes += 1;",
                "  if (writes >= 8) { clearInterval(timer); process.exit(0); }",
                "}, 20);",
              ].join(""),
            ],
          },
          timeoutMs: 25,
          outputLimit: {
            persistOutput: "always",
          },
          trace: {
            sessionId: "exec-auto-background-progress-session",
            attributes: {
              toolCallId: "toolu_auto_background_progress",
            },
          } as any,
        },
        { mode: "auto_on_timeout" },
        {
          onEvent: (event) => {
            if (event.type === "progress") progressEvents.push(event);
          },
        },
      );

      expect(result.kind).toBe("backgrounded");
      const forwardedProgressAfterBackground = progressEvents.length;
      const snapshot = await capable.waitForBackgroundTask!(result.task.taskId);
      expect(snapshot?.status).toBe("completed");
      expect(progressEvents).toHaveLength(forwardedProgressAfterBackground);
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves failed snapshots for auto-backgrounded foreground commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-exec-auto-background-fail-"));
    const adapter = new NodeExecutionAdapter({ outputRootDir: root });
    const capable = adapter as BashBackgroundLifecycleCapableAdapter;

    try {
      const result = await capable.runBashWithBackgroundLifecycle!(
        {
          command: {
            mode: "argv",
            file: process.execPath,
            args: [
              "-e",
              "setTimeout(() => { process.stderr.write('boom'); process.exit(7); }, 60)",
            ],
          },
          timeoutMs: 10,
          outputLimit: {
            persistOutput: "always",
          },
          trace: {
            sessionId: "exec-auto-background-fail-session",
            attributes: {
              toolCallId: "toolu_auto_background_fail",
            },
          } as any,
        },
        { mode: "auto_on_timeout" },
      );

      expect(result.kind).toBe("backgrounded");
      const snapshot = await capable.waitForBackgroundTask!(result.task.taskId);
      expect(snapshot?.status).toBe("failed");
      expect(snapshot?.result?.exitCode).toBe(7);
      expect(snapshot?.result?.stderr.text).toBe("boom");
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps foreground results foreground when commands finish before timeout", async () => {
    const adapter = new NodeExecutionAdapter();
    const capable = adapter as BashBackgroundLifecycleCapableAdapter;

    try {
      const result = await capable.runBashWithBackgroundLifecycle!(
        {
          command: {
            mode: "argv",
            file: process.execPath,
            args: ["-e", "process.stdout.write('ok')"],
          },
          timeoutMs: 1_000,
        },
        { mode: "auto_on_timeout" },
      );

      expect(result.kind).toBe("foreground");
      expect(result.result.status).toBe("completed");
      expect(result.result.stdout.text).toBe("ok");
    } finally {
      await adapter.close();
    }
  });

  it("removes auto-background output artifacts when foreground completion wins", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-exec-auto-background-cleanup-"));
    const adapter = new NodeExecutionAdapter({ outputRootDir: root });
    const capable = adapter as BashBackgroundLifecycleCapableAdapter;
    const stdoutPath = join(root, "cleanup-session", "cleanup-tool-stdout.log");
    const stderrPath = join(root, "cleanup-session", "cleanup-tool-stderr.log");

    try {
      const result = await capable.runBashWithBackgroundLifecycle!(
        {
          command: {
            mode: "argv",
            file: process.execPath,
            args: ["-e", "process.stdout.write('ok')"],
          },
          timeoutMs: 1_000,
          trace: {
            sessionId: "cleanup-session",
            attributes: {
              toolCallId: "cleanup-tool",
            },
          } as any,
        },
        { mode: "auto_on_timeout" },
      );

      expect(result.kind).toBe("foreground");
      expect(result.result.stdout.artifactPath).toBeUndefined();
      expect(result.result.stderr.artifactPath).toBeUndefined();
      await expect(readFile(stdoutPath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(readFile(stderrPath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("settles foreground completion when redundant artifact cleanup fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-exec-foreground-cleanup-failure-"));
    const adapter = new NodeExecutionAdapter({ outputRootDir: root });
    const capable = adapter as BashBackgroundLifecycleCapableAdapter;
    const stdoutPath = join(root, "cleanup-failure-session", "cleanup-failure-tool-stdout.log");
    const retainedFile = join(stdoutPath, "retained.log");

    vi.spyOn(adapter, "run").mockImplementation(async (_request, options) => {
      await options?.onEvent?.({
        type: "started",
        pid: 123,
        timestamp: new Date(0),
      });
      await unlink(stdoutPath);
      await mkdir(stdoutPath);
      await writeFile(retainedFile, "cleanup failed");
      return {
        status: "completed",
        exitCode: 0,
        stdout: {
          text: "ok",
          bytes: 2,
          truncated: false,
          artifactBytes: 2,
          artifactPath: stdoutPath,
          artifactTruncated: false,
        },
        stderr: { text: "", bytes: 0, truncated: false },
        durationMs: 1,
        timedOut: false,
        cancelled: false,
        startedAt: new Date(0),
        completedAt: new Date(1),
      };
    });

    try {
      const result = await capable.runBashWithBackgroundLifecycle!(
        {
          command: { mode: "argv", file: process.execPath },
          timeoutMs: 1_000,
          trace: {
            sessionId: "cleanup-failure-session",
            attributes: { toolCallId: "cleanup-failure-tool" },
          } as any,
        },
        { mode: "auto_on_timeout" },
      );

      expect(result.kind).toBe("foreground");
      expect(result.result.stdout.artifactPath).toBeUndefined();
      expect(result.result.stdout.artifactBytes).toBeUndefined();
      await expect(readFile(retainedFile, "utf8")).resolves.toBe("cleanup failed");
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("settles foreground completion with honest metadata when artifact truncation fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-exec-foreground-truncate-failure-"));
    const adapter = new NodeExecutionAdapter({ outputRootDir: root });
    const capable = adapter as BashBackgroundLifecycleCapableAdapter;
    const stdoutPath = join(root, "truncate-failure-session", "truncate-failure-tool-stdout.log");
    const retainedFile = join(stdoutPath, "retained.log");

    vi.spyOn(adapter, "run").mockImplementation(async (_request, options) => {
      await options?.onEvent?.({
        type: "started",
        pid: 123,
        timestamp: new Date(0),
      });
      await unlink(stdoutPath);
      await mkdir(stdoutPath);
      await writeFile(retainedFile, "not truncated");
      return {
        status: "completed",
        exitCode: 0,
        stdout: {
          text: "ok",
          bytes: 2,
          truncated: false,
          artifactBytes: 13,
          artifactPath: stdoutPath,
          artifactTruncated: false,
        },
        stderr: { text: "", bytes: 0, truncated: false },
        durationMs: 1,
        timedOut: false,
        cancelled: false,
        startedAt: new Date(0),
        completedAt: new Date(1),
      };
    });

    try {
      const result = await capable.runBashWithBackgroundLifecycle!(
        {
          command: { mode: "argv", file: process.execPath },
          timeoutMs: 1_000,
          outputLimit: {
            maxPersistedBytes: 4,
            persistOutput: "always",
          },
          trace: {
            sessionId: "truncate-failure-session",
            attributes: { toolCallId: "truncate-failure-tool" },
          } as any,
        },
        { mode: "auto_on_timeout" },
      );

      expect(result.kind).toBe("foreground");
      expect(result.result.stdout).toMatchObject({
        artifactBytes: 13,
        artifactPath: stdoutPath,
        artifactTruncated: false,
      });
      await expect(readFile(retainedFile, "utf8")).resolves.toBe("not truncated");
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps explicitly requested foreground output artifacts when foreground completion wins", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-exec-auto-background-preserve-"));
    const adapter = new NodeExecutionAdapter({ outputRootDir: root });
    const capable = adapter as BashBackgroundLifecycleCapableAdapter;
    const stdoutPath = join(root, "preserve-session", "preserve-tool-stdout.log");
    const stderrPath = join(root, "preserve-session", "preserve-tool-stderr.log");

    try {
      const result = await capable.runBashWithBackgroundLifecycle!(
        {
          command: {
            mode: "argv",
            file: process.execPath,
            args: ["-e", "process.stdout.write('ok')"],
          },
          timeoutMs: 1_000,
          outputLimit: {
            persistOutput: "always",
          },
          trace: {
            sessionId: "preserve-session",
            attributes: {
              toolCallId: "preserve-tool",
            },
          } as any,
        },
        { mode: "auto_on_timeout" },
      );

      expect(result.kind).toBe("foreground");
      expect(result.result.stdout.artifactPath).toBe(stdoutPath);
      await expect(readFile(stdoutPath, "utf8")).resolves.toBe("ok");
      await expect(readFile(stderrPath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not stop auto-backgrounded commands at the foreground persisted output limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-exec-auto-background-limit-"));
    const adapter = new NodeExecutionAdapter({ outputRootDir: root });
    const capable = adapter as BashBackgroundLifecycleCapableAdapter;

    try {
      const result = await capable.runBashWithBackgroundLifecycle!(
        {
          command: {
            mode: "argv",
            file: process.execPath,
            args: [
              "-e",
              [
                "let writes = 0;",
                "const timer = setInterval(() => {",
                "  process.stdout.write('x'.repeat(512));",
                "  writes += 1;",
                "  if (writes >= 200) { clearInterval(timer); process.exit(0); }",
                "}, 1);",
              ].join(""),
            ],
          },
          timeoutMs: 20,
          outputLimit: {
            maxInlineBytes: 0,
            maxPersistedBytes: 1_024,
            persistOutput: "always",
          },
          trace: {
            sessionId: "limit-session",
            attributes: {
              toolCallId: "limit-tool",
            },
          } as any,
        },
        { mode: "auto_on_timeout" },
      );

      expect(result.kind).toBe("backgrounded");
      const snapshot = await capable.waitForBackgroundTask!(result.task.taskId);
      expect(snapshot?.status).toBe("completed");
      expect(snapshot?.error).toBeUndefined();
      expect(snapshot?.result?.exitCode).toBe(0);
      expect(snapshot?.result?.stdout.artifactBytes).toBeGreaterThan(1_024);
      expect(snapshot?.result?.stdout.artifactTruncated).toBe(false);
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(!POSIX_BASH_PATH)(
    "stops foreground Bash at the periodic soft limit and removes its oversized file",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-exec-background-hard-cap-"));
      const adapter = new NodeExecutionAdapter({
        outputRootDir: root,
        progressIntervalMs: 10,
      });
      const outputLimit = 1_024;

      try {
        const result = await adapter.run(
          {
            command: {
              mode: "shell",
              command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.stdout.write('x'.repeat(4096)); setInterval(() => {}, 1000)")}`,
              shellProfile: "posix-bash",
              shellOverride: POSIX_BASH_PATH,
            },
            timeoutMs: 0,
            outputLimit: {
              maxInlineBytes: 0,
              maxPersistedBytes: outputLimit,
              persistOutput: "always",
            },
          },
          {
            onPersistedLimit: () => undefined,
            shouldStopOnPersistedLimit: () => true,
          } as ExecutionRunOptions & {
            onPersistedLimit: () => void;
            shouldStopOnPersistedLimit: () => boolean;
          },
        );

        expect(result).toMatchObject({
          status: "cancelled",
          exitCode: 137,
          cancelled: true,
          error: { type: "output_limit" },
          stdout: {
            bytes: 4096,
          },
        });
        expect(result.stdout.artifactPath).toBeUndefined();
      } finally {
        await adapter.close();
        await rm(root, { recursive: true, force: true });
      }
    },
    15_000,
  );

  it("applies the shared 5GiB watchdog policy after Bash background commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-exec-background-watchdog-"));
    const adapter = new NodeExecutionAdapter({ outputRootDir: root });
    const capable = adapter as BashBackgroundLifecycleCapableAdapter;
    let capturedRequest: ExecutionRequest | undefined;
    let sharesPersistedLimitAcrossStreams = false;
    let shouldStopOnPersistedLimit = false;

    const runSpy = vi.spyOn(adapter, "run").mockImplementation(async (request, options) => {
      capturedRequest = request;
      const internalOptions = options as ExecutionRunOptions & {
        sharePersistedOutputLimitAcrossStreams?: boolean;
        shouldStopOnPersistedLimit?: () => boolean;
      };
      await options?.onEvent?.({
        type: "started",
        pid: 123,
        timestamp: new Date(0),
      });
      shouldStopOnPersistedLimit = internalOptions.shouldStopOnPersistedLimit?.() === true;
      sharesPersistedLimitAcrossStreams =
        internalOptions.sharePersistedOutputLimitAcrossStreams === true;
      return {
        status: "completed",
        exitCode: 0,
        stdout: { text: "", bytes: 0, truncated: false },
        stderr: { text: "", bytes: 0, truncated: false },
        durationMs: 1,
        timedOut: false,
        cancelled: false,
        startedAt: new Date(0),
        completedAt: new Date(1),
      };
    });

    try {
      const result = await capable.runBashWithBackgroundLifecycle!(
        {
          command: { mode: "argv", file: process.execPath },
          timeoutMs: 5,
          outputLimit: {
            killProcessOnPersistedLimit: true,
            maxPersistedBytes: 1_024,
            persistOutput: "on_truncate",
          },
        },
        { mode: "explicit" },
      );

      expect(result.kind).toBe("backgrounded");
      expect(capturedRequest?.timeoutMs).toBe(0);
      expect(capturedRequest?.outputLimit).toMatchObject({
        killProcessOnPersistedLimit: false,
        maxPersistedBytes: 5 * 1024 * 1024 * 1024,
        persistOutput: "always",
      });
      expect(sharesPersistedLimitAcrossStreams).toBe(true);
      expect(shouldStopOnPersistedLimit).toBe(true);
      expect(runSpy).toHaveBeenCalledTimes(1);
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("normalizes a background Bash output-limit stop to killed exit 137 semantics", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-exec-background-limit-result-"));
    const adapter = new NodeExecutionAdapter({ outputRootDir: root });
    const capable = adapter as BashBackgroundLifecycleCapableAdapter;

    vi.spyOn(adapter, "run").mockImplementation(async (_request, options) => {
      const internalOptions = options as ExecutionRunOptions & {
        onPersistedLimit?: () => void;
      };
      await options?.onEvent?.({
        type: "started",
        pid: 123,
        timestamp: new Date(0),
      });
      internalOptions.onPersistedLimit?.();
      return {
        status: "failed",
        exitCode: 0,
        stdout: {
          text: "",
          bytes: 5 * 1024 * 1024 * 1024 + 1,
          truncated: true,
        },
        stderr: { text: "", bytes: 0, truncated: false },
        durationMs: 1,
        timedOut: false,
        cancelled: false,
        startedAt: new Date(0),
        completedAt: new Date(1),
      };
    });

    try {
      const result = await capable.runBashWithBackgroundLifecycle!(
        {
          command: { mode: "argv", file: process.execPath },
          outputLimit: { persistOutput: "always" },
        },
        { mode: "explicit" },
      );

      expect(result.kind).toBe("backgrounded");
      const snapshot = await capable.waitForBackgroundTask!(result.task.taskId);
      expect(snapshot?.result).toMatchObject({
        status: "cancelled",
        cancelled: true,
        timedOut: false,
        exitCode: 137,
        error: {
          type: "output_limit",
          message: "Background command killed: output file exceeded 5GB",
        },
      });
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(!POSIX_BASH_PATH)(
    "does not apply the runtime soft limit before its first check and retains the full foreground file",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-exec-bash-final-limit-"));
      const adapter = new NodeExecutionAdapter({
        outputRootDir: root,
        progressIntervalMs: 60_000,
      });
      let persistedLimitNotified = false;

      try {
        const result = await adapter.run(
          {
            command: {
              mode: "shell",
              command: "printf abc",
              shellProfile: "posix-bash",
              shellOverride: POSIX_BASH_PATH,
            },
            timeoutMs: 0,
            outputLimit: {
              maxInlineBytes: 1,
              maxPersistedBytes: 2,
              maxArtifactBytes: 1,
              persistOutput: "on_truncate",
            },
          },
          {
            onPersistedLimit: () => {
              persistedLimitNotified = true;
            },
            shouldStopOnPersistedLimit: () => false,
          } as ExecutionRunOptions & {
            onPersistedLimit: () => void;
            shouldStopOnPersistedLimit: () => boolean;
          },
        );

        expect(result).toMatchObject({
          status: "completed",
          exitCode: 0,
          timedOut: false,
          cancelled: false,
          stdout: {
            bytes: 3,
            text: "a",
            artifactBytes: 3,
            artifactTruncated: false,
          },
        });
        expect(result.error).toBeUndefined();
        expect(persistedLimitNotified).toBe(false);
        await expect(readFile(result.stdout.artifactPath!, "utf8")).resolves.toBe("abc");
      } finally {
        await adapter.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!POSIX_BASH_PATH)(
    "ignores the legacy Bash artifact cap after lifecycle completion",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-exec-lifecycle-artifact-cap-"));
      const adapter = new NodeExecutionAdapter({ outputRootDir: root });
      const capable = adapter as BashBackgroundLifecycleCapableAdapter;

      try {
        const result = await capable.runBashWithBackgroundLifecycle!(
          {
            command: {
              mode: "shell",
              command: "printf abc",
              shellProfile: "posix-bash",
              shellOverride: POSIX_BASH_PATH,
            },
            timeoutMs: 1_000,
            outputLimit: {
              maxInlineBytes: 0,
              maxPersistedBytes: 100,
              maxArtifactBytes: 1,
              persistOutput: "always",
            },
            trace: {
              sessionId: "lifecycle-artifact-cap-session",
              attributes: { toolCallId: "lifecycle-artifact-cap-tool" },
            } as any,
          },
          { mode: "auto_on_timeout" },
        );

        expect(result.kind).toBe("foreground");
        expect(result.result).toMatchObject({
          status: "completed",
          stdout: {
            bytes: 3,
            artifactBytes: 3,
            artifactTruncated: false,
          },
        });
        await expect(readFile(result.result.stdout.artifactPath!, "utf8")).resolves.toBe("abc");
      } finally {
        await adapter.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!POSIX_BASH_PATH)(
    "stops watching at root exit even when descendants later exceed the soft limit",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-exec-bash-retained-output-limit-"));
      const adapter = new NodeExecutionAdapter({
        outputRootDir: root,
        progressIntervalMs: 10,
        progressThresholdMs: 0,
      });
      try {
        const result = await adapter.run(
          {
            command: {
              mode: "shell",
              command: "(sleep 0.05; printf 0123456789; sleep 1) & printf x",
              shellProfile: "posix-bash",
              shellOverride: POSIX_BASH_PATH,
            },
            timeoutMs: 0,
            outputLimit: {
              killProcessOnPersistedLimit: true,
              maxInlineBytes: 30_000,
              maxPersistedBytes: 3,
              persistOutput: "always",
            },
          },
          {
            shouldRetainExecutionAfterRootExit: () => true,
          } as ExecutionRunOptions & {
            shouldRetainExecutionAfterRootExit: () => boolean;
          },
        );

        expect(result.status).toBe("completed");
        expect(result.error).toBeUndefined();
        expect(result.stdout.text).toBe("x");
        await sleep(1_200);
        await expect(readFile(result.stdout.artifactPath!, "utf8")).resolves.toBe("x0123456789");
      } finally {
        await adapter.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("runs argv commands without a shell and streams output events", async () => {
    const adapter = new NodeExecutionAdapter();
    const events: ExecutionEvent[] = [];

    const result = await adapter.run(
      {
        command: {
          mode: "argv",
          file: process.execPath,
          args: ["-e", "process.stdout.write('ok')"],
        },
      },
      {
        onEvent: (event) => {
          events.push(event);
        },
      },
    );

    expect(result.status).toBe("completed");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.text).toBe("ok");
    expect(events[0]?.type).toBe("started");
    expect(events.some((event) => event.type === "stdout")).toBe(true);
    expect(events.at(-1)?.type).toBe("completed");
  });

  it("captures final cwd for successful foreground shell commands when requested", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-exec-cwd-"));
    const child = join(root, " child with spaces ");
    await mkdir(child);

    try {
      const adapter = new NodeExecutionAdapter();
      const result = await adapter.run({
        command: {
          mode: "shell",
          command: `cd ${JSON.stringify(child)}`,
        },
        cwd: root,
        captureCwdAfterSuccess: true,
      });

      expect(result.status).toBe("completed");
      expect(result.exitCode).toBe(0);
      expect(result.resolvedCwd).toBe(await realpath(child));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "win32")(
    "captures final cwd for Windows cmd shell commands when requested",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-exec-win-cwd-"));
      const child = join(root, "child");
      await mkdir(child);

      try {
        const adapter = new NodeExecutionAdapter();
        const result = await adapter.run({
          command: {
            mode: "shell",
            command: `cd /d "${child}"`,
          },
          cwd: root,
          captureCwdAfterSuccess: true,
        });

        expect(result.status).toBe("completed");
        expect(result.exitCode).toBe(0);
        expect(result.resolvedCwd).toBe(await realpath(child));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("does not capture cwd for generic shell commands by default", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-exec-cwd-default-"));
    const child = join(root, "child");
    await mkdir(child);

    try {
      const adapter = new NodeExecutionAdapter();
      const result = await adapter.run({
        command: {
          mode: "shell",
          command: `cd ${JSON.stringify(child)}`,
        },
        cwd: root,
      });

      expect(result.status).toBe("completed");
      expect(result.exitCode).toBe(0);
      expect(result.resolvedCwd).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not capture cwd when the shell command exits non-zero", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-exec-cwd-fail-"));
    const child = join(root, "child");
    await mkdir(child);

    try {
      const adapter = new NodeExecutionAdapter();
      const result = await adapter.run({
        command: {
          mode: "shell",
          command: `cd ${JSON.stringify(child)}; false`,
        },
        cwd: root,
        captureCwdAfterSuccess: true,
      });

      expect(result.status).toBe("failed");
      expect(result.exitCode).toBe(1);
      expect(result.resolvedCwd).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(!POSIX_BASH_PATH)(
    "runs posix-bash shell profile commands with bash/zsh syntax",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-exec-posix-bash-"));
      const home = join(root, "home");
      await mkdir(home, { recursive: true });

      try {
        const adapter = new NodeExecutionAdapter({
          outputRootDir: root,
          processEnv: {
            ...process.env,
            HOME: home,
            SHELL: POSIX_BASH_PATH!,
          },
        });
        const result = await adapter.run({
          command: {
            mode: "shell",
            command: "cat <(printf ok)",
            shellProfile: "posix-bash",
            shellOverride: {
              dialect: "posix",
              display: { name: "bash" },
              path: POSIX_BASH_PATH!,
              source: "auto-detected",
            },
          },
        });

        expect(result.status).toBe("completed");
        expect(result.exitCode).toBe(0);
        expect(result.stdout.text).toBe("ok");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!POSIX_BASH_PATH)(
    "creates shell init snapshots with login shell and runs user commands without login",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-exec-login-mode-"));
      const home = join(root, "home");
      const bin = join(root, "bin");
      const shellLog = join(root, "shell-args.log");
      const shellWrapper = join(bin, "bash-wrapper");

      await mkdir(home, { recursive: true });
      await mkdir(bin, { recursive: true });
      await writeFile(
        shellWrapper,
        [
          "#!/usr/bin/env bash",
          'printf \'%q \' "$@" >> "$ZCODE_TEST_SHELL_LOG"',
          "printf '\\n' >> \"$ZCODE_TEST_SHELL_LOG\"",
          `exec ${JSON.stringify(POSIX_BASH_PATH!)} "$@"`,
          "",
        ].join("\n"),
        { mode: 0o755 },
      );

      try {
        const adapter = new NodeExecutionAdapter({
          outputRootDir: root,
          processEnv: {
            ...process.env,
            HOME: home,
            SHELL: shellWrapper,
            ZCODE_TEST_SHELL_LOG: shellLog,
          },
        });
        const result = await adapter.run({
          command: {
            mode: "shell",
            command: 'shopt -q login_shell; rc=$?; printf "%s" "$rc"',
            shellProfile: "posix-bash",
            shellOverride: {
              dialect: "posix",
              display: { name: "bash" },
              path: shellWrapper,
              source: "auto-detected",
            },
          },
        });

        expect(result.status).toBe("completed");
        expect(result.exitCode).toBe(0);
        expect(result.stdout.text).toBe("1");

        const invocations = (await readFile(shellLog, "utf8")).trim().split("\n");
        expect(invocations[0]).toContain("-c -l");
        expect(invocations.at(-1)).toMatch(/^-c /u);
        expect(invocations.at(-1)).not.toContain("-l ");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!POSIX_BASH_PATH)(
    "injects embedded search prelude into posix-bash shell profile commands",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-exec-embedded-search-"));
      const home = join(root, "home");
      await mkdir(home, { recursive: true });
      const shimScript = [
        "if (process.argv[1] !== 'grep') process.exit(11);",
        "process.stdout.write(`shim:${process.argv.slice(2).join('|')}`);",
      ].join("");

      try {
        const adapter = new NodeExecutionAdapter({
          outputRootDir: root,
          processEnv: {
            ...process.env,
            HOME: home,
            SHELL: POSIX_BASH_PATH!,
          },
        });
        const result = await adapter.run({
          command: {
            mode: "shell",
            command: "grep needle file.txt",
            shellProfile: "posix-bash",
            shellOverride: {
              dialect: "posix",
              display: { name: "bash" },
              path: POSIX_BASH_PATH!,
              source: "auto-detected",
            },
          },
          bashPrelude: {
            kind: "embedded-search",
            backend: {
              kind: "internal-cli",
              command: process.execPath,
              args: ["-e", shimScript],
            },
          },
        });

        expect(result.status).toBe("completed");
        expect(result.exitCode).toBe(0);
        expect(result.stdout.text).toBe("shim:needle|file.txt");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!POSIX_BASH_PATH)(
    "falls back to native grep when embedded search backend is unavailable and preserves stdin",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-exec-embedded-search-fallback-"));
      const home = join(root, "home");
      await mkdir(home, { recursive: true });

      try {
        const adapter = new NodeExecutionAdapter({
          outputRootDir: root,
          processEnv: {
            ...process.env,
            HOME: home,
            SHELL: POSIX_BASH_PATH!,
          },
        });
        const result = await adapter.run({
          command: {
            mode: "shell",
            command: "printf 'before\\nneedle from stdin\\nafter\\n' | grep needle",
            shellProfile: "posix-bash",
            shellOverride: {
              dialect: "posix",
              display: { name: "bash" },
              path: POSIX_BASH_PATH!,
              source: "auto-detected",
            },
          },
          bashPrelude: {
            kind: "embedded-search",
            backend: {
              kind: "internal-cli",
              command: join(root, "missing-zcode"),
              args: ["__internal-search"],
            },
          },
        });

        expect(result.status).toBe("completed");
        expect(result.exitCode).toBe(0);
        expect(result.stdout.text).toBe("needle from stdin\n");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!POSIX_BASH_PATH)(
    "sources shell init snapshot and skips login for the user command after creation",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-shell-init-integration-"));
      const home = join(root, "home");
      const bin = join(root, "bin");
      const shellLog = join(root, "shell-args.log");
      const shellWrapper = join(bin, "bash-wrapper");

      await mkdir(home, { recursive: true });
      await mkdir(bin, { recursive: true });
      await writeFile(
        join(home, ".bashrc"),
        "alias zcode_snapshot_alias='printf alias-from-snapshot'\n",
      );
      await writeFile(
        shellWrapper,
        [
          "#!/usr/bin/env bash",
          'printf \'%q \' "$@" >> "$ZCODE_TEST_SHELL_LOG"',
          "printf '\\n' >> \"$ZCODE_TEST_SHELL_LOG\"",
          `exec ${JSON.stringify(POSIX_BASH_PATH!)} "$@"`,
          "",
        ].join("\n"),
        { mode: 0o755 },
      );

      try {
        const adapter = new NodeExecutionAdapter({
          outputRootDir: root,
          processEnv: {
            ...process.env,
            HOME: home,
            SHELL: shellWrapper,
            ZCODE_TEST_SHELL_LOG: shellLog,
          },
        });

        const result = await adapter.run({
          command: {
            mode: "shell",
            command: "zcode_snapshot_alias",
            shellProfile: "posix-bash",
            shellOverride: {
              dialect: "posix",
              display: { name: "bash" },
              path: shellWrapper,
              source: "auto-detected",
            },
          },
          trace: {
            sessionId: "shell-init-session",
          },
        });

        expect(result.status).toBe("completed");
        expect(result.exitCode).toBe(0);
        expect(result.stdout.text).toBe("alias-from-snapshot");

        const log = await readFile(shellLog, "utf8");
        const invocations = log.trim().split("\n");
        expect(invocations[0]).toContain("-c -l");
        expect(invocations.at(-1)).toMatch(/^-c /u);
        expect(invocations.at(-1)).not.toContain("-l ");

        const snapshotSessionDir = join(root, "shell-snapshots");
        const beforeClose = await readdir(snapshotSessionDir);
        expect(beforeClose.some((file) => file.endsWith(".sh"))).toBe(true);

        await adapter.close();

        const afterClose = await readdir(snapshotSessionDir).catch((error: unknown) => {
          if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ENOENT"
          ) {
            return [];
          }
          throw error;
        });
        expect(afterClose).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!POSIX_BASH_PATH)(
    "creates shell init snapshots with the resolved shell environment",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-shell-init-env-"));
      const home = join(root, "home");
      const bin = join(root, "bin");
      const shellWrapper = join(bin, "bash-wrapper");

      await mkdir(home, { recursive: true });
      await mkdir(bin, { recursive: true });
      await writeFile(
        join(home, ".bashrc"),
        [
          'if [ "$SHELL" = "$ZCODE_EXPECTED_SHELL" ] && [ "$GIT_EDITOR" = "true" ]; then',
          "  alias zcode_env_overlay_alias='printf env-overlay-ok'",
          "fi",
          "",
        ].join("\n"),
      );
      await writeFile(
        shellWrapper,
        ["#!/usr/bin/env bash", `exec ${JSON.stringify(POSIX_BASH_PATH!)} "$@"`, ""].join("\n"),
        { mode: 0o755 },
      );

      try {
        const adapter = new NodeExecutionAdapter({
          outputRootDir: root,
          processEnv: {
            ...process.env,
            GIT_EDITOR: "stale-editor",
            HOME: home,
            SHELL: "/bin/fish",
            ZCODE_EXPECTED_SHELL: shellWrapper,
          },
        });

        const result = await adapter.run({
          command: {
            mode: "shell",
            command: "zcode_env_overlay_alias",
            shellProfile: "posix-bash",
            shellOverride: {
              dialect: "posix",
              display: { name: "bash" },
              path: shellWrapper,
              source: "auto-detected",
            },
          },
          trace: {
            sessionId: "shell-init-session",
          },
        });

        expect(result.status).toBe("completed");
        expect(result.exitCode).toBe(0);
        expect(result.stdout.text).toBe("env-overlay-ok");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!POSIX_BASH_PATH)(
    "falls back to login shell when a cached shell init snapshot file is missing",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-shell-init-missing-"));
      const home = join(root, "home");
      const bin = join(root, "bin");
      const shellLog = join(root, "shell-args.log");
      const shellWrapper = join(bin, "bash-wrapper");

      await mkdir(home, { recursive: true });
      await mkdir(bin, { recursive: true });
      await writeFile(
        join(home, ".bashrc"),
        "alias zcode_snapshot_alias='printf alias-from-snapshot'\n",
      );
      await writeFile(
        shellWrapper,
        [
          "#!/usr/bin/env bash",
          'printf \'%q \' "$@" >> "$ZCODE_TEST_SHELL_LOG"',
          "printf '\\n' >> \"$ZCODE_TEST_SHELL_LOG\"",
          `exec ${JSON.stringify(POSIX_BASH_PATH!)} "$@"`,
          "",
        ].join("\n"),
        { mode: 0o755 },
      );

      try {
        const adapter = new NodeExecutionAdapter({
          outputRootDir: root,
          processEnv: {
            ...process.env,
            HOME: home,
            SHELL: shellWrapper,
            ZCODE_TEST_SHELL_LOG: shellLog,
          },
        });

        const first = await adapter.run({
          command: {
            mode: "shell",
            command: "zcode_snapshot_alias",
            shellProfile: "posix-bash",
            shellOverride: {
              dialect: "posix",
              display: { name: "bash" },
              path: shellWrapper,
              source: "auto-detected",
            },
          },
          trace: {
            sessionId: "shell-init-session",
          },
        });

        expect(first.status).toBe("completed");
        expect(first.stdout.text).toBe("alias-from-snapshot");

        const snapshotSessionDir = join(root, "shell-snapshots");
        const snapshotFiles = await readdir(snapshotSessionDir);
        const snapshotFile = snapshotFiles.find((file) => file.endsWith(".sh"));
        expect(snapshotFile).toBeDefined();
        await unlink(join(snapshotSessionDir, snapshotFile!));

        const second = await adapter.run({
          command: {
            mode: "shell",
            command: "printf second-ok",
            shellProfile: "posix-bash",
            shellOverride: {
              dialect: "posix",
              display: { name: "bash" },
              path: shellWrapper,
              source: "auto-detected",
            },
          },
          trace: {
            sessionId: "shell-init-session",
          },
        });

        expect(second.status).toBe("completed");
        expect(second.stdout.text).toBe("second-ok");

        const invocations = (await readFile(shellLog, "utf8")).trim().split("\n");
        expect(invocations[0]).toContain("-c -l");
        expect(invocations[1]).toMatch(/^-c /u);
        expect(invocations[1]).not.toContain("-l ");
        expect(invocations[2]).toContain("-c -l");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!POSIX_BASH_PATH)(
    "does not spawn the user command when closing during shell init snapshot creation",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-shell-init-close-"));
      const bin = join(root, "bin");
      const shellLog = join(root, "shell-args.log");
      const shellWrapper = join(bin, "bash-wrapper");

      await mkdir(bin, { recursive: true });
      await writeFile(
        shellWrapper,
        [
          "#!/usr/bin/env bash",
          'printf \'%q \' "$@" >> "$ZCODE_TEST_SHELL_LOG"',
          "printf '\\n' >> \"$ZCODE_TEST_SHELL_LOG\"",
          "if [ \"$1\" = '-c' ] && [ \"$2\" = '-l' ] && printf '%s' \"$3\" | grep -q 'SNAPSHOT_FILE='; then",
          "  sleep 0.2",
          "fi",
          `exec ${JSON.stringify(POSIX_BASH_PATH!)} "$@"`,
          "",
        ].join("\n"),
        { mode: 0o755 },
      );

      try {
        const adapter = new NodeExecutionAdapter({
          outputRootDir: root,
          processEnv: {
            ...process.env,
            SHELL: shellWrapper,
            ZCODE_TEST_SHELL_LOG: shellLog,
          },
        });

        const runPromise = adapter.run({
          command: {
            mode: "shell",
            command: "printf user-command-ran",
            shellProfile: "posix-bash",
            shellOverride: {
              dialect: "posix",
              display: { name: "bash" },
              path: shellWrapper,
              source: "auto-detected",
            },
          },
          trace: {
            sessionId: "shell-init-session",
          },
        });

        await sleep(50);
        await adapter.close();
        const result = await runPromise;

        expect(result.status).toBe("cancelled");
        expect(result.stdout.text).toBe("");

        const invocations = (await readFile(shellLog, "utf8")).trim().split("\n");
        expect(invocations).toHaveLength(1);
        expect(invocations[0]).toContain("-c -l");
        expect(invocations[0]).toContain("SNAPSHOT_FILE=");

        const snapshotSessionDir = join(root, "shell-snapshots");
        const snapshotsAfterClose = await readdir(snapshotSessionDir).catch((error: unknown) => {
          if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ENOENT"
          ) {
            return [];
          }
          throw error;
        });
        expect(snapshotsAfterClose).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!POSIX_BASH_PATH)(
    "does not spawn the user command when aborted during shell init snapshot creation",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-shell-init-abort-"));
      const bin = join(root, "bin");
      const shellLog = join(root, "shell-args.log");
      const shellWrapper = join(bin, "bash-wrapper");

      await mkdir(bin, { recursive: true });
      await writeFile(
        shellWrapper,
        [
          "#!/usr/bin/env bash",
          'printf \'%q \' "$@" >> "$ZCODE_TEST_SHELL_LOG"',
          "printf '\\n' >> \"$ZCODE_TEST_SHELL_LOG\"",
          "if [ \"$1\" = '-c' ] && [ \"$2\" = '-l' ] && printf '%s' \"$3\" | grep -q 'SNAPSHOT_FILE='; then",
          "  sleep 0.2",
          "fi",
          `exec ${JSON.stringify(POSIX_BASH_PATH!)} "$@"`,
          "",
        ].join("\n"),
        { mode: 0o755 },
      );

      try {
        const adapter = new NodeExecutionAdapter({
          outputRootDir: root,
          processEnv: {
            ...process.env,
            SHELL: shellWrapper,
            ZCODE_TEST_SHELL_LOG: shellLog,
          },
        });
        const controller = new AbortController();

        const runPromise = adapter.run(
          {
            command: {
              mode: "shell",
              command: "printf user-command-ran",
              shellProfile: "posix-bash",
              shellOverride: {
                dialect: "posix",
                display: { name: "bash" },
                path: shellWrapper,
                source: "auto-detected",
              },
            },
            trace: {
              sessionId: "shell-init-session",
            },
          },
          { signal: controller.signal },
        );

        await sleep(50);
        controller.abort();
        const result = await runPromise;

        expect(result.status).toBe("cancelled");
        expect(result.stdout.text).toBe("");

        const invocations = (await readFile(shellLog, "utf8")).trim().split("\n");
        expect(invocations).toHaveLength(1);
        expect(invocations[0]).toContain("-c -l");
        expect(invocations[0]).toContain("SNAPSHOT_FILE=");

        await adapter.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!POSIX_BASH_PATH)(
    "falls back to login shell when shell init snapshot creation fails",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-shell-init-fallback-"));
      const bin = join(root, "bin");
      const shellLog = join(root, "shell-args.log");
      const shellWrapper = join(bin, "bash-wrapper");

      await mkdir(bin, { recursive: true });
      await writeFile(
        shellWrapper,
        [
          "#!/usr/bin/env bash",
          'printf \'%q \' "$@" >> "$ZCODE_TEST_SHELL_LOG"',
          "printf '\\n' >> \"$ZCODE_TEST_SHELL_LOG\"",
          "if [ \"$1\" = '-c' ] && [ \"$2\" = '-l' ] && printf '%s' \"$3\" | grep -q 'SNAPSHOT_FILE='; then",
          "  exit 42",
          "fi",
          `exec ${JSON.stringify(POSIX_BASH_PATH!)} "$@"`,
          "",
        ].join("\n"),
        { mode: 0o755 },
      );

      try {
        const adapter = new NodeExecutionAdapter({
          outputRootDir: root,
          processEnv: {
            ...process.env,
            SHELL: shellWrapper,
            ZCODE_TEST_SHELL_LOG: shellLog,
          },
        });

        const result = await adapter.run({
          command: {
            mode: "shell",
            command: "printf fallback-ok",
            shellProfile: "posix-bash",
            shellOverride: {
              dialect: "posix",
              display: { name: "bash" },
              path: shellWrapper,
              source: "auto-detected",
            },
          },
          trace: {
            sessionId: "shell-init-session",
          },
        });

        expect(result.status).toBe("completed");
        expect(result.stdout.text).toBe("fallback-ok");

        const log = await readFile(shellLog, "utf8");
        const invocations = log.trim().split("\n");
        expect(invocations[0]).toContain("-c -l");
        expect(invocations.at(-1)).toContain("-c -l");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!POSIX_BASH_PATH)(
    "keeps cwd capture after shell init snapshot source commands",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-shell-init-cwd-"));
      const home = join(root, "home");
      const child = join(root, "child");

      await mkdir(home, { recursive: true });
      await mkdir(child, { recursive: true });
      await writeFile(join(home, ".bashrc"), 'zcode_cd_child() { cd "$ZCODE_TEST_CHILD"; }\n');

      try {
        const adapter = new NodeExecutionAdapter({
          outputRootDir: root,
          processEnv: {
            ...process.env,
            HOME: home,
            SHELL: POSIX_BASH_PATH!,
            ZCODE_TEST_CHILD: child,
          },
        });

        const result = await adapter.run({
          command: {
            mode: "shell",
            command: "zcode_cd_child",
            shellProfile: "posix-bash",
            shellOverride: {
              dialect: "posix",
              display: { name: "bash" },
              path: POSIX_BASH_PATH!,
              source: "auto-detected",
            },
          },
          captureCwdAfterSuccess: true,
          cwd: root,
          trace: {
            sessionId: "shell-init-session",
          },
        });

        expect(result.status).toBe("completed");
        expect(result.exitCode).toBe(0);
        expect(result.resolvedCwd).toBe(await realpath(child));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!POSIX_BASH_PATH)(
    "runs posix-bash shell profile commands with bash-specific syntax when bash is the user shell",
    async () => {
      const adapter = new NodeExecutionAdapter({
        processEnv: {
          ...process.env,
          SHELL: POSIX_BASH_PATH ?? "/bin/bash",
        },
      });
      const result = await adapter.run({
        command: {
          mode: "shell",
          command: [
            "arr=(a b)",
            "printf '%s\\n' \"${arr[1]}\"",
            "false | true",
            "printf '%s\\n' \"${PIPESTATUS[0]} ${PIPESTATUS[1]}\"",
            "[[ -n x ]] && printf '%s\\n' ok",
          ].join("\n"),
          shellProfile: "posix-bash",
        },
      });

      expect(result.status).toBe("completed");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.text).toBe("b\n1 0\nok\n");
    },
  );

  it.skipIf(process.platform !== "win32" || !WINDOWS_GIT_BASH_PATH)(
    "runs Bash syntax through Git Bash on Windows",
    async () => {
      const adapter = new NodeExecutionAdapter();
      const result = await adapter.run({
        command: {
          mode: "shell",
          shellProfile: "posix-bash",
          command: [
            "arr=(a b)",
            "printf 'array=%s\\n' \"${arr[1]}\"",
            "cat <(printf process)",
          ].join("\n"),
        },
        captureCwdAfterSuccess: true,
        timeoutMs: 5000,
      });

      expect(result.status).toBe("completed");
      expect(result.stdout.text).toContain("array=b");
      expect(result.stdout.text).toContain("process");
    },
  );

  it.skipIf(process.platform !== "win32" || !WINDOWS_GIT_BASH_PATH)(
    "writes Windows Git Bash stdout and stderr directly to one canonical output",
    async () => {
      const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-exec-git-bash-merged-"));
      const adapter = new NodeExecutionAdapter({ outputRootDir });

      try {
        const result = await adapter.run({
          command: {
            mode: "shell",
            shellProfile: "posix-bash",
            command:
              "printf 'stdout-1\\n'; sleep 0.05; printf 'stderr-1\\n' >&2; sleep 0.05; printf 'stdout-2\\n'",
          },
          outputLimit: {
            maxInlineBytes: 30_000,
            maxPersistedBytes: 64 * 1024 * 1024,
            persistOutput: "always",
          },
          trace: {
            sessionId: "git-bash-merged-session",
            attributes: { toolCallId: "git-bash-merged-tool" },
          } as any,
        });

        const outputPath = join(
          outputRootDir,
          "git-bash-merged-session",
          "git-bash-merged-tool-stdout.log",
        );
        expect(result.status).toBe("completed");
        expect(result.stdout.text).toBe("stdout-1\nstderr-1\nstdout-2\n");
        expect(result.stderr).toEqual({ text: "", bytes: 0, truncated: false });
        expect(result.stdout.artifactPath).toBe(outputPath);
        await expect(readFile(outputPath, "utf8")).resolves.toBe(result.stdout.text);
        await expect(
          stat(join(outputRootDir, "git-bash-merged-session", "git-bash-merged-tool-stderr.log")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await adapter.close();
        await rm(outputRootDir, { force: true, recursive: true });
      }
    },
  );

  it("creates a cmd-compatible cwd capture wrapper for Windows shell commands", () => {
    const windowsPlan = createCwdCapturePlan(
      {
        command: {
          mode: "shell",
          command: "cd C:\\repo",
        },
        captureCwdAfterSuccess: true,
      },
      { dialect: "cmd", platform: "win32" },
    );

    expect(windowsPlan.cwdFilePath).toBeDefined();
    expect(windowsPlan.command).toMatchObject({
      mode: "shell",
    });
    expect(windowsPlan.command.command).toContain("cd C:\\repo");
    expect(windowsPlan.command.command).toContain('set "__zcode_status=%ERRORLEVEL%"');
    expect(windowsPlan.command.command).toContain('if "%__zcode_status%"=="0" cd > "');
    expect(windowsPlan.command.command).toContain("exit /b %__zcode_status%");
  });

  it("does not create a cwd capture wrapper for argv commands", () => {
    const argvPlan = createCwdCapturePlan(
      {
        command: {
          mode: "argv",
          file: "pwd",
        },
        captureCwdAfterSuccess: true,
      },
      { dialect: "posix", platform: "darwin" },
    );

    expect(argvPlan).toEqual({
      command: {
        mode: "argv",
        file: "pwd",
      },
    });
  });

  it("preserves shell profile when creating a cwd capture wrapper", () => {
    const plan = createCwdCapturePlan(
      {
        command: {
          mode: "shell",
          command: "pwd",
          shellProfile: "posix-bash",
        },
        captureCwdAfterSuccess: true,
      },
      { dialect: "posix", platform: "linux" },
    );

    expect(plan.command.mode).toBe("shell");
    if (plan.command.mode === "shell") {
      expect(plan.command.shellProfile).toBe("posix-bash");
      expect(plan.command.command).toContain("pwd");
      expect(plan.command.command).toContain("__zcode_status=$?");
    }
  });

  it("uses POSIX cwd capture syntax for Windows Git Bash", () => {
    const plan = createCwdCapturePlan(
      {
        command: {
          mode: "shell",
          command: "cd subdir",
          shellProfile: "posix-bash",
        },
        captureCwdAfterSuccess: true,
      },
      { dialect: "git-bash", platform: "win32" },
    );

    expect(plan.command.mode).toBe("shell");
    if (plan.command.mode === "shell") {
      expect(plan.command.command).toContain("__zcode_status=$?");
      expect(plan.command.command).toContain("pwd -P >");
      expect(plan.command.command).not.toContain("%ERRORLEVEL%");
    }
  });

  it("normalizes captured Git Bash cwd back to a Windows host path", () => {
    expect(normalizeCapturedCwdForHost("/c/path/to/repo", "git-bash")).toBe("C:\\path\\to\\repo");
    expect(normalizeCapturedCwdForHost("C:\\path\\to\\repo", "cmd")).toBe("C:\\path\\to\\repo");
  });

  it("emits progress events with elapsed time, byte counts, and tail output", async () => {
    const adapter = new NodeExecutionAdapter({
      progressIntervalMs: 5,
      progressThresholdMs: 1,
    });
    const events: ExecutionEvent[] = [];

    const result = await adapter.run(
      {
        command: {
          mode: "argv",
          file: process.execPath,
          args: [
            "-e",
            "process.stdout.write('first'); setTimeout(() => process.stdout.write('second'), 30); setTimeout(() => {}, 70)",
          ],
        },
      },
      {
        onEvent: (event) => {
          events.push(event);
        },
      },
    );

    const progress = events.find(
      (event): event is Extract<ExecutionEvent, { type: "progress" }> =>
        event.type === "progress" && event.stdoutBytes > 0,
    );

    expect(result.status).toBe("completed");
    expect(progress).toBeDefined();
    expect(progress?.elapsedMs).toBeGreaterThan(0);
    expect(progress?.stdoutBytes).toBeGreaterThan(0);
    expect(progress?.stdoutTail).toContain("first");
  });

  it("applies cwd and env overlay through spawn options", async () => {
    const adapter = new NodeExecutionAdapter();
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "zcode-exec-")));
    const previousUnsetValue = process.env.ZCODE_EXEC_UNSET;
    process.env.ZCODE_EXEC_UNSET = "remove-me";

    try {
      const result = await adapter.run({
        command: {
          mode: "argv",
          file: process.execPath,
          args: [
            "-e",
            [
              "process.stdout.write(JSON.stringify({",
              "cwd: process.cwd(),",
              "value: process.env.ZCODE_EXEC_TEST,",
              "unset: process.env.ZCODE_EXEC_UNSET ?? null",
              "}))",
            ].join(""),
          ],
        },
        cwd,
        env: {
          base: "inherit",
          set: {
            ZCODE_EXEC_TEST: "yes",
          },
          unset: ["ZCODE_EXEC_UNSET"],
        },
      });
      const parsed = JSON.parse(result.stdout.text) as {
        cwd: string;
        value?: string;
        unset: string | null;
      };

      expect(result.status).toBe("completed");
      expect(parsed.cwd).toBe(cwd);
      expect(parsed.value).toBe("yes");
      expect(parsed.unset).toBeNull();
    } finally {
      if (previousUnsetValue === undefined) {
        delete process.env.ZCODE_EXEC_UNSET;
      } else {
        process.env.ZCODE_EXEC_UNSET = previousUnsetValue;
      }
      await rm(cwd, { force: true, recursive: true });
    }
  });

  it("deduplicates Windows environment keys when applying overlays", () => {
    const env = buildExecutionEnv(
      {
        base: "inherit",
        set: {
          PATH: "C:\\next-bin",
        },
        unset: ["temp"],
      },
      {
        platform: "win32",
        processEnv: {
          Path: "C:\\base-bin",
          TEMP: "C:\\Temp",
          ZCODE_KEEP: "yes",
        },
      },
    );

    expect(env.PATH).toBe("C:\\next-bin");
    expect(env.Path).toBeUndefined();
    expect(env.TEMP).toBeUndefined();
    expect(env.ZCODE_KEEP).toBe("yes");
  });

  it("injects configured network egress variables for subprocesses", () => {
    const env = buildExecutionEnv(
      {
        base: "empty",
      },
      {
        network: {
          caCertFile: "/tmp/zcode-ca.pem",
          httpProxy: "127.0.0.1:8888",
          noProxy: "localhost,127.0.0.1",
        },
        platform: "linux",
        processEnv: {
          HTTP_PROXY: "http://shell-proxy:8080",
          NODE_EXTRA_CA_CERTS: "/tmp/shell-ca.pem",
        },
      },
    );

    expect(env.HTTP_PROXY).toBe("http://127.0.0.1:8888");
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:8888");
    expect(env.ALL_PROXY).toBe("http://127.0.0.1:8888");
    expect(env.http_proxy).toBe("http://127.0.0.1:8888");
    expect(env.https_proxy).toBe("http://127.0.0.1:8888");
    expect(env.all_proxy).toBe("http://127.0.0.1:8888");
    expect(env.NO_PROXY).toBe("localhost,127.0.0.1");
    expect(env.no_proxy).toBe("localhost,127.0.0.1");
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/tmp/zcode-ca.pem");
    expect(env.SSL_CERT_FILE).toBe("/tmp/zcode-ca.pem");
    expect(env.REQUESTS_CA_BUNDLE).toBe("/tmp/zcode-ca.pem");
    expect(env.CURL_CA_BUNDLE).toBe("/tmp/zcode-ca.pem");
    expect(env.GIT_SSL_CAINFO).toBe("/tmp/zcode-ca.pem");
  });

  it("ignores ambient standard proxy and CA env for subprocesses", () => {
    const env = buildExecutionEnv(undefined, {
      network: {},
      platform: "linux",
      processEnv: {
        NODE_ENV: "development",
        http_proxy: "http://shell-proxy:8080",
        NODE_EXTRA_CA_CERTS: "/tmp/shell-ca.pem",
        no_proxy: ".example.test",
        PATH: "/usr/bin:/bin",
      },
    });

    expect(env.NODE_ENV).toBeUndefined();
    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.http_proxy).toBeUndefined();
    expect(env.NO_PROXY).toBeUndefined();
    expect(env.no_proxy).toBeUndefined();
    expect(env.NODE_EXTRA_CA_CERTS).toBeUndefined();
    expect(env.SSL_CERT_FILE).toBeUndefined();
    expect(env.REQUESTS_CA_BUNDLE).toBeUndefined();
    expect(env.CURL_CA_BUNDLE).toBeUndefined();
    expect(env.GIT_SSL_CAINFO).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin:/bin");
  });

  it("restores captured user proxy and CA env for inherited subprocesses", () => {
    const env = buildExecutionEnv(undefined, {
      network: {},
      platform: "linux",
      processEnv: {
        [ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY]: JSON.stringify({
          NODE_EXTRA_CA_CERTS: "/tmp/shell-ca.pem",
          http_proxy: "http://shell-proxy:8080",
          no_proxy: ".example.test",
          npm_config_proxy: "http://npm-proxy:8080",
        }),
        NODE_ENV: "development",
        PATH: "/usr/bin:/bin",
      },
    });

    expect(env.NODE_ENV).toBeUndefined();
    expect(env[ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY]).toBeUndefined();
    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.http_proxy).toBe("http://shell-proxy:8080");
    expect(env.NO_PROXY).toBeUndefined();
    expect(env.no_proxy).toBe(".example.test");
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/tmp/shell-ca.pem");
    expect(env.npm_config_proxy).toBe("http://npm-proxy:8080");
    expect(env.PATH).toBe("/usr/bin:/bin");
  });

  it("does not restore captured user env when command base is empty", () => {
    const env = buildExecutionEnv(
      {
        base: "empty",
      },
      {
        network: {},
        platform: "linux",
        processEnv: {
          [ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY]: JSON.stringify({
            HTTP_PROXY: "http://shell-proxy:8080",
            NODE_EXTRA_CA_CERTS: "/tmp/shell-ca.pem",
          }),
        },
      },
    );

    expect(env[ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY]).toBeUndefined();
    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.NODE_EXTRA_CA_CERTS).toBeUndefined();
  });

  it("derives subprocess proxy and CA env from explicit ZCode runtime keys", () => {
    const env = buildExecutionEnv(
      {
        base: "empty",
      },
      {
        network: {},
        platform: "linux",
        processEnv: {
          ZCODE_AGENT_CA_CERT: "/tmp/zcode-ca.pem",
          ZCODE_HTTP_PROXY: "127.0.0.1:8888",
          [ZCODE_NO_PROXY_ENV_KEY]: "localhost,127.0.0.1",
        },
      },
    );

    expect(env.HTTP_PROXY).toBe("http://127.0.0.1:8888");
    expect(env.http_proxy).toBe("http://127.0.0.1:8888");
    expect(env.NO_PROXY).toBe("localhost,127.0.0.1");
    expect(env.no_proxy).toBe("localhost,127.0.0.1");
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/tmp/zcode-ca.pem");
    expect(env.SSL_CERT_FILE).toBe("/tmp/zcode-ca.pem");
    expect(env.REQUESTS_CA_BUNDLE).toBe("/tmp/zcode-ca.pem");
    expect(env.CURL_CA_BUNDLE).toBe("/tmp/zcode-ca.pem");
    expect(env.GIT_SSL_CAINFO).toBe("/tmp/zcode-ca.pem");
  });

  it("lets per-command env overlays override injected network env", () => {
    const env = buildExecutionEnv(
      {
        base: "empty",
        set: {
          HTTP_PROXY: "http://command-proxy:8080",
        },
        unset: ["SSL_CERT_FILE"],
      },
      {
        network: {
          caCertFile: "/tmp/zcode-ca.pem",
          httpProxy: "http://zcode-proxy:8080",
        },
        platform: "linux",
        processEnv: {},
      },
    );

    expect(env.HTTP_PROXY).toBe("http://command-proxy:8080");
    expect(env.HTTPS_PROXY).toBe("http://zcode-proxy:8080");
    expect(env.SSL_CERT_FILE).toBeUndefined();
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/tmp/zcode-ca.pem");
  });

  it("adds a UTF-8 locale for subprocess text output when the parent locale is C", () => {
    const env = buildExecutionEnv(undefined, {
      platform: "darwin",
      processEnv: {
        LANG: "C",
        LC_ALL: "",
        LC_CTYPE: "POSIX",
        PATH: "/usr/bin:/bin",
      },
    });

    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.LC_ALL).toBe("en_US.UTF-8");
    expect(env.LC_CTYPE).toBe("en_US.UTF-8");
    expect(env.PYTHONIOENCODING).toBe("utf-8");
    expect(env.PYTHONUTF8).toBe("1");
  });

  it.skipIf(process.platform === "win32")(
    "keeps unicode path text from POSIX tools even when the parent locale is C",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-exec-cn-"));
      const dir = join(root, "草稿");
      const file = join(dir, "file.txt");
      await mkdir(dir, { recursive: true });
      await writeFile(file, "a\nb\n");
      const adapter = new NodeExecutionAdapter({
        processEnv: {
          ...process.env,
          LANG: "C",
          LC_ALL: "",
          LC_CTYPE: "C",
        },
      });

      try {
        const result = await adapter.run({
          command: {
            mode: "argv",
            file: "wc",
            args: ["-l", file],
          },
        });

        expect(result.status).toBe("completed");
        expect(result.stdout.text).toContain("草稿");
        expect(result.stdout.text).not.toContain("??");
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    },
  );

  it("decodes Windows legacy Chinese output without corrupting UTF-8 output", () => {
    const legacy = iconv.encode("草稿", "gb18030");
    const westernLegacy = iconv.encode("é", "cp1252");
    const utf8 = Buffer.from("草稿", "utf8");

    expect(decodeExecutionOutputBuffer(legacy, "gb18030")).toBe("草稿");
    expect(decodeExecutionOutputBuffer(westernLegacy, "cp1252")).toBe("é");
    expect(decodeExecutionOutputBuffer(utf8, "gb18030")).toBe("草稿");
  });

  it.skipIf(!POSIX_BASH_PATH)("can rewrite posix-bash commands without -l", async () => {
    const command = await resolveExecutionCommand(
      {
        mode: "shell",
        command: "echo before",
        shellProfile: "posix-bash",
        shellOverride: {
          dialect: "posix",
          display: { name: "bash" },
          path: POSIX_BASH_PATH!,
          source: "auto-detected",
        },
      },
      {
        env: process.env,
        platform: process.platform,
      },
    );

    expect(command.args).toEqual(["-c", "-l", "echo before"]);

    const withoutLogin = setResolvedShellLoginMode(command, false);
    expect(withoutLogin.args).toEqual(["-c", "echo before"]);

    const rewritten = applyResolvedShellCommandForTest(withoutLogin, "echo after");
    expect(rewritten.args).toEqual(["-c", "echo after"]);
  });

  it("resolves Windows .cmd argv commands through cmd.exe", async () => {
    const resolved = await resolveExecutionCommand(
      {
        mode: "argv",
        file: "pnpm",
        args: ["--version"],
      },
      {
        cwd: "C:\\repo",
        env: {
          ComSpec: "C:\\Windows\\System32\\cmd.exe",
          Path: "C:\\tools;C:\\other",
          PATHEXT: ".COM;.EXE;.BAT;.CMD",
        },
        exists: (path) => path === "C:\\tools\\pnpm.cmd",
        platform: "win32",
      },
    );

    expect(resolved).toEqual({
      args: ["/d", "/s", "/c", "C:\\tools\\pnpm.cmd --version"],
      cwdDialect: "cmd",
      file: "C:\\Windows\\System32\\cmd.exe",
      shell: false,
    });
  });

  it("quotes Windows .cmd argv arguments without requiring git-bash", async () => {
    const resolved = await resolveExecutionCommand(
      {
        mode: "argv",
        file: "pnpm",
        args: ["run", "say hi", "A&B", "100%done", "caret^value", "pipe|value"],
      },
      {
        cwd: "C:\\repo",
        env: {
          ComSpec: "C:\\Windows\\System32\\cmd.exe",
          Path: "C:\\Program Files\\node tools",
          PATHEXT: ".COM;.EXE;.BAT;.CMD",
        },
        exists: (path) => path === "C:\\Program Files\\node tools\\pnpm.cmd",
        platform: "win32",
      },
    );

    expect(resolved).toEqual({
      args: [
        "/d",
        "/s",
        "/c",
        '"C:\\Program Files\\node tools\\pnpm.cmd" run "say hi" "A^&B" "100^%done" "caret^^value" "pipe^|value"',
      ],
      cwdDialect: "cmd",
      file: "C:\\Windows\\System32\\cmd.exe",
      shell: false,
    });
  });

  it("resolves a Windows command from a quoted PATH entry", async () => {
    const resolved = await resolveExecutionCommand(
      { mode: "argv", file: "pnpm", args: ["install"] },
      {
        cwd: "C:\\repo",
        env: {
          ComSpec: "C:\\Windows\\System32\\cmd.exe",
          Path: '"C:\\Program Files\\node tools";C:\\Windows',
          PATHEXT: ".COM;.EXE;.BAT;.CMD",
        },
        exists: (path) => path === "C:\\Program Files\\node tools\\pnpm.cmd",
        platform: "win32",
      },
    );

    expect(resolved.args.at(-1)).toBe('"C:\\Program Files\\node tools\\pnpm.cmd" install');
  });

  it("keeps Windows .exe argv commands shell-free after PATH resolution", async () => {
    const resolved = await resolveExecutionCommand(
      {
        mode: "argv",
        file: "tool",
        args: ["run"],
      },
      {
        env: {
          PATH: "C:\\tools",
          PATHEXT: ".EXE;.CMD",
        },
        exists: (path) => path === "C:\\tools\\tool.exe",
        platform: "win32",
      },
    );

    expect(resolved).toEqual({
      args: ["run"],
      cwdDialect: "cmd",
      file: "C:\\tools\\tool.exe",
      shell: false,
    });
  });

  it("uses ComSpec as the default Windows shell", async () => {
    const resolved = await resolveExecutionCommand(
      {
        mode: "shell",
        command: "dir",
      },
      {
        env: {
          COMSPEC: "C:\\Windows\\System32\\cmd.exe",
        },
        platform: "win32",
      },
    );

    expect(resolved).toEqual({
      args: [],
      cwdDialect: "cmd",
      file: "dir",
      shell: "C:\\Windows\\System32\\cmd.exe",
    });
  });

  it("keeps generic Windows shell commands on the legacy shell path", async () => {
    const resolved = await resolveExecutionCommand(
      {
        mode: "shell",
        command: "dir",
        shellOverride: {
          dialect: "git-bash",
          id: "git-bash:C:\\Program Files\\Git\\bin\\bash.exe",
          label: "Git Bash",
          path: "C:\\Program Files\\Git\\bin\\bash.exe",
          source: "user-config",
        },
      },
      {
        env: {
          COMSPEC: "C:\\Windows\\System32\\cmd.exe",
          SHELL: "C:\\Program Files\\Git\\bin\\bash.exe",
        },
        exists: () => {
          throw new Error("Git Bash resolver should not run without shellProfile");
        },
        platform: "win32",
      },
    );

    expect(resolved).toEqual({
      args: [],
      cwdDialect: "cmd",
      file: "dir",
      shell: "C:\\Windows\\System32\\cmd.exe",
    });
  });

  it("keeps generic POSIX shell commands on the legacy Node shell path", async () => {
    const resolved = await resolveExecutionCommand(
      {
        mode: "shell",
        command: "echo ok",
      },
      {
        env: {
          PATH: "/bin:/usr/bin",
          SHELL: "/bin/bash",
        },
        exists: () => {
          throw new Error("posix shell resolver should not run without shellProfile");
        },
        platform: "linux",
      },
    );

    expect(resolved).toEqual({
      args: [],
      cwdDialect: "posix",
      file: "echo ok",
      shell: true,
    });
  });

  it("uses a valid user-configured Windows Git Bash override before auto detection", async () => {
    const resolved = await resolveExecutionCommand(
      {
        mode: "shell",
        command: "printf 'ok\\n'",
        shellProfile: "posix-bash",
        shellOverride: {
          dialect: "git-bash",
          id: "git-bash:D:\\Tools\\Git\\bin\\bash.exe",
          label: "Git Bash",
          path: "D:\\Tools\\Git\\bin\\bash.exe",
          source: "user-config",
        },
      },
      {
        env: {
          COMSPEC: "C:\\Windows\\System32\\cmd.exe",
          PATH: "C:\\Windows\\System32",
        },
        exists: (path) =>
          path === "D:\\Tools\\Git\\bin\\bash.exe" ||
          path === "C:\\Program Files\\Git\\bin\\bash.exe",
        platform: "win32",
      },
    );

    expect(resolved).toMatchObject({
      args: ["-c", "-l", expect.any(String)],
      cwdDialect: "git-bash",
      file: "D:\\Tools\\Git\\bin\\bash.exe",
      shell: false,
    });
  });

  it("falls back to auto detection when the user-configured shell no longer exists", async () => {
    const resolved = await resolveExecutionCommand(
      {
        mode: "shell",
        command: "printf 'ok\\n'",
        shellProfile: "posix-bash",
        shellOverride: {
          dialect: "git-bash",
          id: "git-bash:D:\\Missing\\bash.exe",
          label: "Git Bash",
          path: "D:\\Missing\\bash.exe",
          source: "user-config",
        },
      },
      {
        env: {
          COMSPEC: "C:\\Windows\\System32\\cmd.exe",
          PATH: "C:\\Windows\\System32",
        },
        exists: (path) => path === "C:\\Program Files\\Git\\bin\\bash.exe",
        platform: "win32",
      },
    );

    expect(resolved).toMatchObject({
      cwdDialect: "git-bash",
      file: "C:\\Program Files\\Git\\bin\\bash.exe",
      shell: false,
    });
  });

  it("resolves Windows Git Bash from the default Program Files path for posix-bash", async () => {
    const resolved = await resolveExecutionCommand(
      {
        mode: "shell",
        command: "printf 'ok\\n'",
        shellProfile: "posix-bash",
      },
      {
        env: {
          COMSPEC: "C:\\Windows\\System32\\cmd.exe",
          PATH: "C:\\Windows\\System32",
        },
        exists: (path) => path === "C:\\Program Files\\Git\\bin\\bash.exe",
        platform: "win32",
      },
    );

    expect(resolved).toMatchObject({
      args: ["-c", "-l", expect.any(String)],
      cwdDialect: "git-bash",
      file: "C:\\Program Files\\Git\\bin\\bash.exe",
      shell: false,
    });
  });

  it("resolves Windows Git Bash from git.exe on PATH", async () => {
    const resolved = await resolveExecutionCommand(
      {
        mode: "shell",
        command: "printf 'ok\\n'",
        shellProfile: "posix-bash",
      },
      {
        env: {
          COMSPEC: "C:\\Windows\\System32\\cmd.exe",
          PATH: "D:\\Apps\\Git\\cmd",
        },
        exists: (path) =>
          path === "D:\\Apps\\Git\\cmd\\git.exe" || path === "D:\\Apps\\Git\\bin\\bash.exe",
        platform: "win32",
      },
    );

    expect(resolved).toMatchObject({
      args: ["-c", "-l", expect.any(String)],
      cwdDialect: "git-bash",
      file: "D:\\Apps\\Git\\bin\\bash.exe",
      shell: false,
    });
  });

  it("uses a valid user-configured Windows cmd override before auto detection", async () => {
    const resolved = await resolveExecutionCommand(
      {
        mode: "shell",
        command: "dir",
        shellProfile: "posix-bash",
        shellOverride: {
          dialect: "cmd",
          id: "cmd:C:\\Windows\\System32\\cmd.exe",
          label: "CMD",
          path: "C:\\Windows\\System32\\cmd.exe",
          source: "user-config",
        },
      },
      {
        env: {
          COMSPEC: "C:\\Windows\\System32\\cmd.exe",
          PATH: "C:\\Windows\\System32",
        },
        exists: (path) =>
          path === "C:\\Windows\\System32\\cmd.exe" ||
          path === "C:\\Program Files\\Git\\bin\\bash.exe",
        platform: "win32",
      },
    );

    expect(resolved).toEqual({
      args: [],
      cwdDialect: "cmd",
      file: "dir",
      shell: "C:\\Windows\\System32\\cmd.exe",
    });
  });

  it("uses the cmd.exe fallback override before auto Git Bash detection", async () => {
    const resolved = await resolveExecutionCommand(
      {
        mode: "shell",
        command: "dir",
        shellProfile: "posix-bash",
        shellOverride: {
          dialect: "cmd",
          id: "cmd:cmd.exe",
          label: "CMD",
          path: "cmd.exe",
          source: "user-config",
        },
      },
      {
        env: {
          PATH: "C:\\Program Files\\Git\\cmd",
        },
        exists: (path) => path === "C:\\Program Files\\Git\\bin\\bash.exe",
        platform: "win32",
      },
    );

    expect(resolved).toEqual({
      args: [],
      cwdDialect: "cmd",
      file: "dir",
      shell: "cmd.exe",
    });
  });

  it("falls back to ComSpec when Windows Git Bash cannot be resolved", async () => {
    const resolved = await resolveExecutionCommand(
      {
        mode: "shell",
        command: "dir",
        shellProfile: "posix-bash",
      },
      {
        env: {
          COMSPEC: "C:\\Windows\\System32\\cmd.exe",
          PATH: "C:\\tools",
          SHELL: "C:\\Program Files\\Git\\bin\\bash.exe",
        },
        exists: () => false,
        platform: "win32",
      },
    );

    expect(resolved).toEqual({
      args: [],
      cwdDialect: "cmd",
      file: "dir",
      shell: "C:\\Windows\\System32\\cmd.exe",
    });
  });

  it("keeps CMD parentheses and metacharacters unchanged in the Bash fallback", async () => {
    const command = "if exist input.txt (echo yes) else (echo no) & echo done";
    const resolved = await resolveExecutionCommand(
      {
        mode: "shell",
        command,
        shellProfile: "posix-bash",
      },
      {
        env: {
          COMSPEC: "C:\\Windows\\System32\\cmd.exe",
          PATH: "C:\\tools",
        },
        exists: () => false,
        platform: "win32",
      },
    );

    expect(resolved).toEqual({
      args: [],
      cwdDialect: "cmd",
      file: command,
      shell: "C:\\Windows\\System32\\cmd.exe",
    });
  });

  it("converts Windows and Git Bash paths in both directions", () => {
    expect(windowsPathToGitBashPath("C:\\repo\\sub")).toBe("/c/repo/sub");
    expect(windowsPathToGitBashPath("C:/repo/sub")).toBe("/c/repo/sub");
    expect(windowsPathToGitBashPath("C:repo\\sub")).toBe("C:repo/sub");
    expect(windowsPathToGitBashPath("\\\\server\\share\\repo")).toBe("//server/share/repo");
    expect(gitBashPathToWindowsPath("/c/repo/sub")).toBe("C:\\repo\\sub");
    expect(gitBashPathToWindowsPath("/cygdrive/d/repo")).toBe("D:\\repo");
    expect(gitBashPathToWindowsPath("//server/share/repo")).toBe("\\\\server\\share\\repo");
  });

  it.skipIf(process.platform === "win32")(
    "resolves posix-bash shell commands through bash without Node shell wrapping",
    async () => {
      const resolved = await resolveExecutionCommand(
        {
          mode: "shell",
          command: "echo ok",
          shellProfile: "posix-bash",
        },
        {
          env: {
            PATH: "/custom/bin",
            SHELL: "/bin/bash",
          },
          exists: (path) => path === "/bin/bash",
          platform: "linux",
        },
      );

      expect(resolved).toEqual({
        args: ["-c", "-l", "echo ok"],
        cwdDialect: "posix",
        envOverlay: {
          GIT_EDITOR: "true",
          SHELL: "/bin/bash",
        },
        file: "/bin/bash",
        shell: false,
        usesLoginShell: true,
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "prefers zsh for posix-bash shell commands when the user shell is not bash",
    async () => {
      const resolution = await resolveEffectiveBashShellSelection({
        env: {
          PATH: "/zsh/bin:/bash/bin",
          SHELL: "/bin/fish",
        },
        exists: (path) => path === "/zsh/bin/zsh" || path === "/bash/bin/bash",
        platform: "darwin",
      });
      const resolved = await resolveExecutionCommand(
        {
          mode: "shell",
          command: "echo ok",
          shellProfile: "posix-bash",
        },
        {
          env: {
            PATH: "/zsh/bin:/bash/bin",
            SHELL: "/bin/fish",
          },
          exists: (path) => path === "/zsh/bin/zsh" || path === "/bash/bin/bash",
          platform: "darwin",
        },
      );

      expect(resolution.selection).toMatchObject({
        dialect: "posix",
        display: { name: "zsh" },
        path: "/zsh/bin/zsh",
        source: "auto-detected",
      });
      expect(resolution.provider?.file).toBe("/zsh/bin/zsh");
      expect(resolved.file).toBe("/zsh/bin/zsh");
      expect(resolved.args).toEqual(["-c", "-l", "echo ok"]);
      expect(resolved.shell).toBe(false);
      expect(resolved.envOverlay).toMatchObject({
        SHELL: "/zsh/bin/zsh",
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "falls back to fixed POSIX shell directories for posix-bash commands",
    async () => {
      const resolved = await resolveExecutionCommand(
        {
          mode: "shell",
          command: "echo ok",
          shellProfile: "posix-bash",
        },
        {
          env: {
            PATH: "/custom/bin",
            SHELL: "/bin/fish",
          },
          exists: (path) => path === "/usr/bin/bash",
          platform: "linux",
        },
      );

      expect(resolved).toMatchObject({
        args: ["-c", "-l", "echo ok"],
        file: "/usr/bin/bash",
        shell: false,
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "uses the provided auto-detected shell snapshot instead of re-detecting POSIX shells",
    async () => {
      const resolved = await resolveExecutionCommand(
        {
          mode: "shell",
          command: "echo ok",
          shellOverride: {
            dialect: "posix",
            display: { name: "zsh" },
            id: "auto:zsh",
            label: "zsh",
            path: "/snapshot/bin/zsh",
            source: "auto-detected",
          },
          shellProfile: "posix-bash",
        },
        {
          env: {
            PATH: "/current/bin",
            SHELL: "/bin/fish",
          },
          exists: (path) => path === "/current/bin/bash",
          platform: "linux",
        },
      );

      expect(resolved).toMatchObject({
        args: ["-c", "-l", "echo ok"],
        file: "/snapshot/bin/zsh",
        shell: false,
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "falls back to the legacy shell command when posix-bash cannot resolve bash or zsh",
    async () => {
      const resolution = await resolveEffectiveBashShellSelection({
        env: {
          PATH: "/no-shells",
          SHELL: "/bin/fish",
        },
        exists: () => false,
        platform: "linux",
      });
      const resolved = await resolveExecutionCommand(
        {
          mode: "shell",
          command: "echo ok",
          shellProfile: "posix-bash",
        },
        {
          env: {
            PATH: "/no-shells",
            SHELL: "/bin/fish",
          },
          exists: () => false,
          platform: "linux",
        },
      );

      expect(resolution.selection).toMatchObject({
        dialect: "legacy-shell",
        display: { name: "system shell" },
        source: "legacy-fallback",
      });
      expect(resolution.provider).toBeUndefined();
      expect(resolved).toEqual({
        args: [],
        cwdDialect: "posix",
        file: "echo ok",
        shell: true,
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "preserves a legacy shell snapshot instead of re-detecting POSIX shells",
    async () => {
      const resolved = await resolveExecutionCommand(
        {
          mode: "shell",
          command: "echo ok",
          shellOverride: {
            dialect: "legacy-shell",
            display: { name: "system shell" },
            source: "legacy-fallback",
          },
          shellProfile: "posix-bash",
        },
        {
          env: {
            PATH: "/current/bin",
            SHELL: "/bin/fish",
          },
          exists: (path) => path === "/current/bin/bash",
          platform: "linux",
        },
      );

      expect(resolved).toEqual({
        args: [],
        cwdDialect: "posix",
        file: "echo ok",
        shell: true,
      });
    },
  );

  it("describes auto-detected Windows Git Bash as the effective Bash shell", async () => {
    const resolution = await resolveEffectiveBashShellSelection({
      env: {
        PATH: "",
      },
      exists: (path) => path === "C:\\Program Files\\Git\\bin\\bash.exe",
      platform: "win32",
    });

    expect(resolution.selection).toMatchObject({
      dialect: "git-bash",
      display: { name: "Git Bash" },
      path: "C:\\Program Files\\Git\\bin\\bash.exe",
      source: "auto-detected",
    });
    expect(resolution.provider).toMatchObject({
      dialect: "git-bash",
      file: "C:\\Program Files\\Git\\bin\\bash.exe",
      shell: false,
    });
  });

  it("describes the Windows fallback without Git Bash as CMD on ComSpec", async () => {
    const resolution = await resolveEffectiveBashShellSelection({
      env: {
        COMSPEC: "C:\\Windows\\System32\\cmd.exe",
        PATH: "C:\\tools",
      },
      exists: () => false,
      platform: "win32",
    });

    expect(resolution.selection).toEqual({
      dialect: "cmd",
      display: { name: "cmd.exe" },
      id: "auto:cmd",
      label: "cmd.exe",
      path: "C:\\Windows\\System32\\cmd.exe",
      source: "auto-detected",
    });
    expect(resolution.provider).toMatchObject({
      dialect: "cmd",
      file: "C:\\Windows\\System32\\cmd.exe",
      shell: "C:\\Windows\\System32\\cmd.exe",
    });
  });

  it("uses bare cmd.exe for the Windows fallback when ComSpec is missing", async () => {
    const resolution = await resolveEffectiveBashShellSelection({
      env: { PATH: "" },
      exists: () => false,
      platform: "win32",
    });
    const resolved = await resolveExecutionCommand(
      { mode: "shell", command: "dir", shellProfile: "posix-bash" },
      { env: { PATH: "" }, exists: () => false, platform: "win32" },
    );

    expect(resolution.selection).toMatchObject({
      dialect: "cmd",
      display: { name: "cmd.exe" },
      path: "cmd.exe",
    });
    expect(resolved).toEqual({ args: [], cwdDialect: "cmd", file: "dir", shell: "cmd.exe" });
  });

  it("uses the auto-detected Windows CMD snapshot instead of re-reading ComSpec", async () => {
    // 子代理与每次 Bash 调用都把 runtime selection 作为 shellOverride 传入，这是 Windows 回落的主路径。
    const { selection } = await resolveEffectiveBashShellSelection({
      env: { ComSpec: "C:\\Windows\\System32\\cmd.exe", PATH: "" },
      exists: () => false,
      platform: "win32",
    });
    const resolved = await resolveExecutionCommand(
      { mode: "shell", command: "dir", shellOverride: selection, shellProfile: "posix-bash" },
      {
        env: { ComSpec: "D:\\other\\cmd.exe", PATH: "" },
        exists: (path) => path === "C:\\Program Files\\Git\\bin\\bash.exe",
        platform: "win32",
      },
    );

    expect(resolved).toEqual({
      args: [],
      cwdDialect: "cmd",
      file: "dir",
      shell: "C:\\Windows\\System32\\cmd.exe",
    });
  });

  it("uses the provided auto-detected Windows Git Bash snapshot instead of re-detecting", async () => {
    const resolved = await resolveExecutionCommand(
      {
        mode: "shell",
        command: "pwd",
        shellOverride: {
          dialect: "git-bash",
          display: { name: "Git Bash" },
          id: "auto:git-bash",
          label: "Git Bash",
          path: "D:\\Git\\bin\\bash.exe",
          source: "auto-detected",
        },
        shellProfile: "posix-bash",
      },
      {
        env: {
          PATH: "",
        },
        exists: (path) => path === "C:\\Program Files\\Git\\bin\\bash.exe",
        platform: "win32",
      },
    );

    expect(resolved).toMatchObject({
      args: ["-c", "-l", "pwd"],
      file: "D:\\Git\\bin\\bash.exe",
      shell: false,
    });
  });

  it("keeps explicit Windows CMD selection ahead of auto-detected Git Bash", async () => {
    const resolution = await resolveEffectiveBashShellSelection({
      env: {
        PATH: "",
      },
      exists: (path) => path === "cmd.exe" || path === "C:\\Program Files\\Git\\bin\\bash.exe",
      override: {
        dialect: "cmd",
        display: { name: "CMD" },
        id: "cmd",
        label: "CMD",
        path: "cmd.exe",
        source: "user-config",
      },
      platform: "win32",
    });

    expect(resolution.selection).toMatchObject({
      dialect: "cmd",
      display: { name: "cmd.exe" },
      path: "cmd.exe",
      source: "user-config",
    });
    expect(resolution.provider).toMatchObject({
      dialect: "cmd",
      file: "cmd.exe",
      shell: "cmd.exe",
    });
  });

  it("returns non-zero exits as structured failed results", async () => {
    const adapter = new NodeExecutionAdapter();

    const result = await adapter.run({
      command: {
        mode: "argv",
        file: process.execPath,
        args: ["-e", "process.stderr.write('bad'); process.exit(7)"],
      },
    });

    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(7);
    expect(result.stderr.text).toBe("bad");
  });

  it("keeps the Agent alive when a successful child closes stdin before a large write", async () => {
    const adapter = new NodeExecutionAdapter();

    const result = await adapter.run({
      command: {
        mode: "argv",
        file: process.execPath,
        args: ["-e", "process.stdin.destroy(); setTimeout(() => process.exit(0), 20);"],
      },
      stdin: "x".repeat(1024 * 1024),
    });

    expect(result.status).toBe("completed");
    expect(result.exitCode).toBe(0);
    expect(result.error).toBeUndefined();
  });

  it("preserves a non-zero exit when the child closes stdin before a large write", async () => {
    const adapter = new NodeExecutionAdapter();

    const result = await adapter.run({
      command: {
        mode: "argv",
        file: process.execPath,
        args: ["-e", "process.stdin.destroy(); setTimeout(() => process.exit(7), 20);"],
      },
      stdin: "x".repeat(1024 * 1024),
    });

    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(7);
  });

  it("delivers a large stdin payload when the child consumes it", async () => {
    const adapter = new NodeExecutionAdapter();
    const stdin = "你好, ZCode!\n".repeat(100_000);

    const result = await adapter.run({
      command: {
        mode: "argv",
        file: process.execPath,
        args: [
          "-e",
          [
            "let bytes = 0;",
            "process.stdin.on('data', chunk => { bytes += chunk.length; });",
            "process.stdin.on('end', () => process.stdout.write(String(bytes)));",
          ].join(" "),
        ],
      },
      stdin,
    });

    expect(result.status).toBe("completed");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.text).toBe(String(Buffer.byteLength(stdin)));
  });

  it("stops commands with a structured timeout result", async () => {
    const adapter = new NodeExecutionAdapter();

    const result = await adapter.run({
      command: {
        mode: "argv",
        file: process.execPath,
        args: ["-e", "setTimeout(() => {}, 5000)"],
      },
      timeoutMs: 50,
    });

    expect(result.status).toBe("timed_out");
    expect(result.timedOut).toBe(true);
    expect(result.cancelled).toBe(false);
    expect(result.error).toEqual({
      type: "timeout",
      message: "Command timed out after 50ms",
    });
  });

  it("timeout 只约束子进程运行阶段，准备较慢的命令不会未启动就被判 timed_out", async () => {
    // 回归：protected-resource sandbox 时代计时器被提前到准备阶段（覆盖 capability probe），
    // sandbox 撤除后该行为一度被保留——shell 初始化较慢或 timeout 较短时，命令还没 spawn
    // 就返回 timed_out。计时器必须在 spawn 之后才启动。
    const adapter = new NodeExecutionAdapter();
    const internals = adapter as unknown as {
      prepareChildSpawn: (request: unknown) => Promise<unknown>;
    };
    const originalPrepare = internals.prepareChildSpawn.bind(adapter);
    internals.prepareChildSpawn = async (request: unknown) => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return originalPrepare(request);
    };

    const result = await adapter.run({
      command: {
        mode: "argv",
        file: process.execPath,
        args: ["-e", "process.exit(0)"],
      },
      timeoutMs: 60,
    });

    expect(result.status).toBe("completed");
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
  });

  it("stops commands with a structured cancellation result", async () => {
    const adapter = new NodeExecutionAdapter();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    const result = await adapter.run(
      {
        command: {
          mode: "argv",
          file: process.execPath,
          args: ["-e", "setTimeout(() => {}, 5000)"],
        },
      },
      {
        signal: controller.signal,
      },
    );

    expect(result.status).toBe("cancelled");
    expect(result.cancelled).toBe(true);
    expect(result.timedOut).toBe(false);
  });

  it("closes running background tasks during adapter shutdown", async () => {
    const adapter = new NodeExecutionAdapter();

    const started = await adapter.start({
      command: {
        mode: "argv",
        file: process.execPath,
        args: ["-e", "setTimeout(() => {}, 10_000)"],
      },
    });

    await adapter.close();

    const snapshot = await adapter.getBackgroundTask(started.taskId);
    expect(snapshot?.status).toBe("cancelled");
    expect(snapshot?.result?.status).toBe("cancelled");
  });

  it.skipIf(process.platform === "win32")(
    "kills child processes in the same process group when shutting down",
    async () => {
      const adapter = new NodeExecutionAdapter();
      let childPidText = "";
      const script = [
        "const { spawn } = require('node:child_process');",
        "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)'], { stdio: 'ignore' });",
        "process.stdout.write(String(child.pid));",
        "setTimeout(() => {}, 10_000);",
      ].join(" ");

      const runPromise = adapter.run(
        {
          command: {
            mode: "argv",
            file: process.execPath,
            args: ["-e", script],
          },
        },
        {
          onEvent: (event) => {
            if (event.type === "stdout") {
              childPidText += event.text;
            }
          },
        },
      );

      let childPid = Number.NaN;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const trimmed = childPidText.trim();
        childPid = Number(trimmed);
        if (trimmed.length > 0 && Number.isInteger(childPid) && childPid > 0) {
          break;
        }
        await sleep(20);
      }

      expect(Number.isInteger(childPid)).toBe(true);
      expect(childPid).toBeGreaterThan(0);

      await adapter.close();
      const result = await runPromise;
      expect(result.status).toBe("cancelled");

      let childStillRunning = true;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        childStillRunning = isProcessAlive(childPid);
        if (!childStillRunning) {
          break;
        }
        await sleep(20);
      }

      expect(childStillRunning).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps inherited-pipe descendants owned until background shutdown",
    async () => {
      const adapter = new NodeExecutionAdapter();
      let output = "";
      let descendantPid = Number.NaN;
      const descendantScript = [
        "process.on('SIGTERM', () => {});",
        "setInterval(() => {}, 10_000);",
      ].join("");
      const wrapperScript = [
        "const { spawn } = require('node:child_process');",
        `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { stdio: ['ignore', 'inherit', 'inherit'] });`,
        "process.stdout.write(`descendant:${child.pid}\\n`);",
        "child.unref();",
      ].join("");

      try {
        const started = await adapter.start(
          {
            command: {
              mode: "argv",
              file: process.execPath,
              args: ["-e", wrapperScript],
            },
          },
          {
            onEvent: (event) => {
              if (event.type === "stdout") output += event.text;
            },
          },
        );

        for (let attempt = 0; attempt < 100; attempt += 1) {
          descendantPid = Number(/descendant:(\d+)/u.exec(output)?.[1]);
          if (Number.isInteger(descendantPid) && descendantPid > 0) break;
          await sleep(20);
        }
        expect(Number.isInteger(descendantPid)).toBe(true);

        // 超过旧实现的一秒 drain 窗口后仍应由 execution 持有，而不是伪 completed。
        await sleep(1_100);
        expect((await adapter.getBackgroundTask(started.taskId))?.status).toBe("running");

        await adapter.close();

        const snapshot = await adapter.getBackgroundTask(started.taskId);
        expect(snapshot?.status).toBe("cancelled");
        expect(snapshot?.result?.status).toBe("cancelled");
        expect(isProcessAlive(descendantPid)).toBe(false);
      } finally {
        if (Number.isInteger(descendantPid) && descendantPid > 0 && isProcessAlive(descendantPid)) {
          process.kill(descendantPid, "SIGKILL");
        }
        await adapter.close();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "cleans inherited-pipe descendants after the foreground drain deadline",
    async () => {
      const adapter = new NodeExecutionAdapter();
      let descendantPid = Number.NaN;
      const descendantScript = "setInterval(() => {}, 10_000);";
      const wrapperScript = [
        "const { spawn } = require('node:child_process');",
        `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { stdio: ['ignore', 'inherit', 'inherit'] });`,
        "process.stdout.write(`descendant:${child.pid}\\n`);",
        "child.unref();",
      ].join("");

      try {
        const result = await adapter.run({
          command: {
            mode: "argv",
            file: process.execPath,
            args: ["-e", wrapperScript],
          },
        });
        descendantPid = Number(/descendant:(\d+)/u.exec(result.stdout.text)?.[1]);

        expect(result.status).toBe("completed");
        expect(Number.isInteger(descendantPid)).toBe(true);
        expect(isProcessAlive(descendantPid)).toBe(false);
      } finally {
        if (Number.isInteger(descendantPid) && descendantPid > 0 && isProcessAlive(descendantPid)) {
          process.kill(descendantPid, "SIGKILL");
        }
        await adapter.close();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "releases inherited pipes when a descendant escapes the original process group",
    async () => {
      const adapter = new NodeExecutionAdapter();
      let descendantPid = Number.NaN;
      const descendantScript = "setInterval(() => {}, 10_000);";
      const wrapperScript = [
        "const { spawn } = require('node:child_process');",
        `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });`,
        "process.stdout.write(`descendant:${child.pid}\\n`);",
        "child.unref();",
      ].join("");

      try {
        const startedAt = Date.now();
        const result = await adapter.run({
          command: {
            mode: "argv",
            file: process.execPath,
            args: ["-e", wrapperScript],
          },
        });
        descendantPid = Number(/descendant:(\d+)/u.exec(result.stdout.text)?.[1]);

        expect(result.status).toBe("completed");
        expect(Number.isInteger(descendantPid)).toBe(true);
        expect(Date.now() - startedAt).toBeLessThan(4_000);
        // 已脱离原 PGID 的第三方进程无法由纯 Node 可靠寻址，但不能继续用 pipe 保活 CLI。
        expect(isProcessAlive(descendantPid)).toBe(true);
      } finally {
        if (Number.isInteger(descendantPid) && descendantPid > 0 && isProcessAlive(descendantPid)) {
          process.kill(descendantPid, "SIGKILL");
        }
        await adapter.close();
      }
    },
  );

  it.skipIf(!POSIX_BASH_PATH)(
    "removes a precreated Bash output file when cancelled before spawn",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-exec-bash-pre-spawn-cancel-"));
      const parentTurn = new AbortController();
      parentTurn.abort();
      const adapter = new NodeExecutionAdapter({ outputRootDir: root });
      const capable = adapter as BashBackgroundLifecycleCapableAdapter;

      try {
        const result = await capable.runBashWithBackgroundLifecycle!(
          {
            command: {
              mode: "shell",
              command: "printf unexpected",
              shellProfile: "posix-bash",
              shellOverride: {
                dialect: "posix",
                display: { name: "bash" },
                path: POSIX_BASH_PATH!,
                source: "auto-detected",
              },
            },
            outputLimit: {
              maxInlineBytes: 30_000,
              maxPersistedBytes: 64 * 1024 * 1024,
              persistOutput: "always",
            },
            trace: {
              sessionId: "bash-pre-spawn-cancel-session",
              attributes: { toolCallId: "bash-pre-spawn-cancel-tool" },
            } as any,
          },
          { mode: "explicit" },
          { signal: parentTurn.signal },
        );

        expect(result.kind).toBe("foreground");
        expect(result.result.status).toBe("cancelled");
        await expect(
          stat(
            join(root, "bash-pre-spawn-cancel-session", "bash-pre-spawn-cancel-tool-stdout.log"),
          ),
        ).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await adapter.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!POSIX_BASH_PATH)(
    "writes Bash stdout and stderr directly to one canonical output",
    async () => {
      const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-exec-bash-merged-"));
      const home = join(outputRootDir, "home");
      await mkdir(home, { recursive: true });
      const processEnv = {
        ...process.env,
        HOME: home,
        SHELL: POSIX_BASH_PATH!,
      };
      delete processEnv.BASH_MAX_OUTPUT_LENGTH;
      const adapter = new NodeExecutionAdapter({ outputRootDir, processEnv });

      try {
        const result = await adapter.run({
          command: {
            mode: "shell",
            command:
              "printf 'stdout-1\\n'; sleep 0.05; printf 'stderr-1\\n' >&2; sleep 0.05; printf 'stdout-2\\n'",
            shellProfile: "posix-bash",
            shellOverride: {
              dialect: "posix",
              display: { name: "bash" },
              path: POSIX_BASH_PATH!,
              source: "auto-detected",
            },
          },
          outputLimit: {
            maxInlineBytes: 30_000,
            maxPersistedBytes: 64 * 1024 * 1024,
            persistOutput: "always",
          },
          trace: {
            sessionId: "bash-merged-session",
            attributes: { toolCallId: "bash-merged-tool" },
          } as any,
        });

        const outputPath = join(
          outputRootDir,
          "bash-merged-session",
          "bash-merged-tool-stdout.log",
        );
        expect(result.status).toBe("completed");
        expect(result.stdout.text).toBe("stdout-1\nstderr-1\nstdout-2\n");
        expect(result.stderr).toEqual({ text: "", bytes: 0, truncated: false });
        expect(result.stdout.artifactPath).toBe(outputPath);
        await expect(readFile(outputPath, "utf8")).resolves.toBe(result.stdout.text);
        expect((await stat(outputPath)).mode & 0o777).toBe(0o600);
        await expect(
          stat(join(outputRootDir, "bash-merged-session", "bash-merged-tool-stderr.log")),
        ).rejects.toMatchObject({ code: "ENOENT" });

        const failed = await adapter.run({
          command: {
            mode: "shell",
            command: "printf 'before\\n'; printf 'failure\\n' >&2; exit 7",
            shellProfile: "posix-bash",
            shellOverride: {
              dialect: "posix",
              display: { name: "bash" },
              path: POSIX_BASH_PATH!,
              source: "auto-detected",
            },
          },
          outputLimit: {
            maxInlineBytes: 30_000,
            maxPersistedBytes: 64 * 1024 * 1024,
            persistOutput: "on_truncate",
          },
          trace: {
            sessionId: "bash-merged-session",
            attributes: { toolCallId: "bash-merged-failed-tool" },
          } as any,
        });
        expect(failed).toMatchObject({
          status: "failed",
          exitCode: 7,
          stdout: {
            text: "before\nfailure\n",
          },
          stderr: {
            text: "",
            bytes: 0,
          },
        });
      } finally {
        await adapter.close();
        await rm(outputRootDir, { force: true, recursive: true });
      }
    },
  );

  it.skipIf(!POSIX_BASH_PATH)(
    "reports filesystem diagnostics for empty failed Bash output",
    async () => {
      const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-exec-bash-output-lost-"));
      const adapter = new NodeExecutionAdapter({ outputRootDir });
      const capable = adapter as BashBackgroundLifecycleCapableAdapter;
      const cases = [
        {
          id: "disk-full",
          statfs: {
            bavail: 9n,
            bfree: 9n,
            blocks: 10n,
            bsize: 1024n * 1024n,
            ffree: 10_000n,
            files: 10_000n,
            type: 0n,
          },
          diagnostic: (outputDirectory: string) =>
            `Command output was lost: the temp filesystem at ${outputDirectory} is full (9MB free). The child process's stdout/stderr writes failed with ENOSPC. Free up space on this filesystem.`,
        },
        {
          id: "inode-full",
          statfs: {
            bavail: 100n,
            bfree: 100n,
            blocks: 100n,
            bsize: 1024n * 1024n,
            ffree: 999n,
            files: 10_000n,
            type: 0n,
          },
          diagnostic: (outputDirectory: string) =>
            `Command output was lost: the temp filesystem at ${outputDirectory} is out of inodes (999 free). The child process's stdout/stderr writes failed with ENOSPC. Free up space on this filesystem.`,
        },
      ];

      try {
        for (const testCase of cases) {
          statfsMock.mockResolvedValueOnce(testCase.statfs);
          const result = await capable.runBashWithBackgroundLifecycle!(
            {
              command: {
                mode: "shell",
                command: "exit 7",
                shellProfile: "posix-bash",
                shellOverride: {
                  dialect: "posix",
                  display: { name: "bash" },
                  path: POSIX_BASH_PATH!,
                  source: "auto-detected",
                },
              },
              timeoutMs: 5_000,
              outputLimit: {
                maxInlineBytes: 30_000,
                maxPersistedBytes: 64 * 1024 * 1024,
                persistOutput: "on_truncate",
              },
              trace: {
                sessionId: `bash-${testCase.id}-session`,
                attributes: { toolCallId: `bash-${testCase.id}-tool` },
              } as any,
            },
            { mode: "auto_on_timeout" },
          );

          const outputDirectory = join(outputRootDir, `bash-${testCase.id}-session`);
          expect(result.kind).toBe("foreground");
          expect(result.result).toMatchObject({
            status: "failed",
            exitCode: 7,
            stdout: {
              text: testCase.diagnostic(outputDirectory),
            },
            stderr: {
              text: "",
              bytes: 0,
            },
          });
          expect(result.result.stdout.artifactPath).toBeUndefined();
          expect(statfsMock).toHaveBeenCalledWith(outputDirectory, { bigint: true });
        }
      } finally {
        await adapter.close();
        await rm(outputRootDir, { force: true, recursive: true });
      }
    },
  );

  it.skipIf(!POSIX_BASH_PATH)(
    "retains a secure zero-byte Bash artifact when persistence is always",
    async () => {
      const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-exec-bash-empty-artifact-"));
      const adapter = new NodeExecutionAdapter({ outputRootDir });

      try {
        const result = await adapter.run({
          command: {
            mode: "shell",
            command: ":",
            shellProfile: "posix-bash",
            shellOverride: {
              dialect: "posix",
              display: { name: "bash" },
              path: POSIX_BASH_PATH!,
              source: "auto-detected",
            },
          },
          outputLimit: {
            maxInlineBytes: 30_000,
            maxPersistedBytes: 64 * 1024 * 1024,
            persistOutput: "always",
          },
          trace: {
            sessionId: "bash-empty-artifact-session",
            attributes: { toolCallId: "bash-empty-artifact-tool" },
          } as any,
        });

        const outputPath = join(
          outputRootDir,
          "bash-empty-artifact-session",
          "bash-empty-artifact-tool-stdout.log",
        );
        expect(result).toMatchObject({
          status: "completed",
          stdout: {
            artifactBytes: 0,
            artifactPath: outputPath,
            artifactTruncated: false,
            bytes: 0,
            text: "",
            truncated: false,
          },
        });
        await expect(readFile(outputPath, "utf8")).resolves.toBe("");
        expect((await stat(outputPath)).mode & 0o777).toBe(0o600);
      } finally {
        await adapter.close();
        await rm(outputRootDir, { force: true, recursive: true });
      }
    },
  );

  it.skipIf(!POSIX_BASH_PATH)(
    "settles Bash output preparation failures before spawning",
    async () => {
      const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-exec-bash-output-prepare-"));
      const blockedSessionPath = join(outputRootDir, "blocked-session");
      await writeFile(blockedSessionPath, "not a directory");
      const adapter = new NodeExecutionAdapter({ outputRootDir });
      const capable = adapter as BashBackgroundLifecycleCapableAdapter;
      const events: ExecutionEvent[] = [];

      try {
        const result = await capable.runBashWithBackgroundLifecycle!(
          {
            command: {
              mode: "shell",
              command: "printf unexpected",
              shellProfile: "posix-bash",
              shellOverride: {
                dialect: "posix",
                display: { name: "bash" },
                path: POSIX_BASH_PATH!,
                source: "auto-detected",
              },
            },
            outputLimit: {
              maxInlineBytes: 30_000,
              maxPersistedBytes: 64 * 1024 * 1024,
              persistOutput: "always",
            },
            trace: {
              sessionId: "blocked-session",
              attributes: { toolCallId: "blocked-tool" },
            } as any,
          },
          { mode: "auto_on_timeout" },
          {
            onEvent: (event) => {
              events.push(event);
            },
          },
        );

        expect(result.kind).toBe("foreground");
        expect(result.result.status).toBe("spawn_error");
        expect(result.result.error?.message).toContain("blocked-session");
        expect(events.some((event) => event.type === "started")).toBe(false);
      } finally {
        await adapter.close();
        await rm(outputRootDir, { force: true, recursive: true });
      }
    },
  );

  it.skipIf(!POSIX_BASH_PATH)("settles a Bash artifact open failure before spawning", async () => {
    const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-exec-bash-output-open-"));
    const outputPath = join(outputRootDir, "open-failure-session", "open-failure-tool-stdout.log");
    await mkdir(outputPath, { recursive: true });
    const adapter = new NodeExecutionAdapter({ outputRootDir });

    try {
      const result = await adapter.run({
        command: {
          mode: "shell",
          command: "printf output",
          shellProfile: "posix-bash",
          shellOverride: {
            dialect: "posix",
            display: { name: "bash" },
            path: POSIX_BASH_PATH!,
            source: "auto-detected",
          },
        },
        outputLimit: {
          maxInlineBytes: 1,
          maxPersistedBytes: 64,
          persistOutput: "on_truncate",
        },
        trace: {
          sessionId: "open-failure-session",
          attributes: { toolCallId: "open-failure-tool" },
        } as any,
      });

      expect(result.status).toBe("spawn_error");
      expect(result.stdout.artifactPath).toBeUndefined();
      expect(result.stdout.bytes).toBe(0);
      expect(result.error?.message).toContain("open-failure-tool-stdout.log");
    } finally {
      await adapter.close();
      await rm(outputRootDir, { force: true, recursive: true });
    }
  });

  it.skipIf(!POSIX_BASH_PATH)("does not create a parent WriteStream for Bash output", async () => {
    const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-exec-bash-output-write-"));
    const outputPath = join(
      outputRootDir,
      "write-failure-session",
      "write-failure-tool-stdout.log",
    );
    const probePath = join(outputRootDir, "file-handle-probe");
    const probeHandle = await open(probePath, "w");
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle) as {
      createWriteStream: typeof probeHandle.createWriteStream;
    };
    await probeHandle.close();
    await unlink(probePath);

    const createWriteStreamSpy = vi.spyOn(fileHandlePrototype, "createWriteStream");
    const adapter = new NodeExecutionAdapter({ outputRootDir });
    const capable = adapter as BashBackgroundLifecycleCapableAdapter;

    try {
      const launch = await capable.runBashWithBackgroundLifecycle!(
        {
          command: {
            mode: "shell",
            command: "printf first; sleep 0.2; printf second",
            shellProfile: "posix-bash",
            shellOverride: {
              dialect: "posix",
              display: { name: "bash" },
              path: POSIX_BASH_PATH!,
              source: "auto-detected",
            },
          },
          outputLimit: {
            maxInlineBytes: 30_000,
            maxPersistedBytes: 64 * 1024 * 1024,
            persistOutput: "always",
          },
          trace: {
            sessionId: "write-failure-session",
            attributes: { toolCallId: "write-failure-tool" },
          } as any,
        },
        { mode: "explicit" },
      );

      expect(launch.kind).toBe("backgrounded");
      if (launch.kind !== "backgrounded") throw new Error("Expected background launch");
      const snapshot = await capable.waitForBackgroundTask!(launch.task.taskId);

      expect(snapshot).toMatchObject({
        outputPath,
        status: "completed",
        stdoutPersistedOutputPath: outputPath,
      });
      expect(snapshot?.result?.stdout.text).toBe("firstsecond");
      expect(snapshot?.result?.stdout.artifactPath).toBe(outputPath);
      expect(createWriteStreamSpy).not.toHaveBeenCalled();
      await expect(readFile(outputPath, "utf8")).resolves.toBe("firstsecond");
    } finally {
      createWriteStreamSpy.mockRestore();
      await adapter.close();
      await rm(outputRootDir, { force: true, recursive: true });
    }
  });

  it.skipIf(!POSIX_BASH_PATH || process.platform === "win32")(
    "rejects a symlinked Bash canonical output path",
    async () => {
      const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-exec-bash-output-symlink-"));
      const sessionDir = join(outputRootDir, "symlink-session");
      const targetPath = join(outputRootDir, "target.log");
      const outputPath = join(sessionDir, "symlink-tool-stdout.log");
      await mkdir(sessionDir, { recursive: true });
      await writeFile(targetPath, "preserved");
      await symlink(targetPath, outputPath);
      const adapter = new NodeExecutionAdapter({ outputRootDir });

      try {
        const result = await adapter.run({
          command: {
            mode: "shell",
            command: "printf overwritten",
            shellProfile: "posix-bash",
            shellOverride: {
              dialect: "posix",
              display: { name: "bash" },
              path: POSIX_BASH_PATH!,
              source: "auto-detected",
            },
          },
          outputLimit: {
            maxInlineBytes: 30_000,
            maxPersistedBytes: 64,
            persistOutput: "always",
          },
          trace: {
            sessionId: "symlink-session",
            attributes: { toolCallId: "symlink-tool" },
          } as any,
        });

        expect(result.status).toBe("spawn_error");
        await expect(readFile(targetPath, "utf8")).resolves.toBe("preserved");
      } finally {
        await adapter.close();
        await rm(outputRootDir, { force: true, recursive: true });
      }
    },
  );

  it.skipIf(!POSIX_BASH_PATH || process.platform === "win32")(
    "does not kill descendants when the Bash root exits normally",
    async () => {
      const adapter = new NodeExecutionAdapter();
      let descendantPid = Number.NaN;

      try {
        const result = await adapter.run({
          command: {
            mode: "shell",
            command:
              "(trap '' TERM HUP; while :; do sleep 10; done) & printf 'descendant:%s\\n' \"$!\"",
            shellProfile: "posix-bash",
            shellOverride: {
              dialect: "posix",
              display: { name: "bash" },
              path: POSIX_BASH_PATH!,
              source: "auto-detected",
            },
          },
        });
        descendantPid = Number(/descendant:(\d+)/u.exec(result.stdout.text)?.[1]);

        expect(result.status).toBe("completed");
        expect(Number.isInteger(descendantPid)).toBe(true);
        // Bash 工具在 root 进程退出时结算，正常完成不主动清理后代；测试自行收尾。
        expect(isProcessAlive(descendantPid)).toBe(true);
      } finally {
        if (Number.isInteger(descendantPid) && descendantPid > 0 && isProcessAlive(descendantPid)) {
          process.kill(descendantPid, "SIGKILL");
        }
        await adapter.close();
      }
    },
  );

  it.skipIf(!POSIX_BASH_PATH && !WINDOWS_GIT_BASH_PATH)(
    "settles the background task at root exit before late descendant output",
    async () => {
      const bashPath = POSIX_BASH_PATH ?? WINDOWS_GIT_BASH_PATH!;
      const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-exec-bash-descendant-progress-"));
      const adapter = new NodeExecutionAdapter({
        outputRootDir,
        progressIntervalMs: 50,
        progressThresholdMs: 0,
      });
      const capable = adapter as BashBackgroundLifecycleCapableAdapter;

      try {
        const result = await capable.runBashWithBackgroundLifecycle!(
          {
            command: {
              mode: "shell",
              command: "(sleep 0.5; printf late) & printf early",
              shellProfile: "posix-bash",
              shellOverride: {
                dialect: "posix",
                display: { name: "bash" },
                path: bashPath,
                source: "auto-detected",
              },
            },
            outputLimit: {
              maxInlineBytes: 30_000,
              maxPersistedBytes: 64 * 1024 * 1024,
              persistOutput: "always",
            },
            trace: {
              sessionId: "bash-descendant-progress-session",
              attributes: { toolCallId: "bash-descendant-progress-tool" },
            } as any,
          },
          { mode: "explicit" },
        );

        expect(result.kind).toBe("backgrounded");
        const completed = await capable.waitForBackgroundTask!(result.task.taskId);
        expect(completed).toMatchObject({
          status: "completed",
          result: {
            stdout: {
              text: "early",
            },
          },
        });

        expect(result.task.outputPath).toBeTypeOf("string");
        await sleep(600);
        await expect(readFile(result.task.outputPath!, "utf8")).resolves.toBe("earlylate");
      } finally {
        await adapter.close();
        await rm(outputRootDir, { force: true, recursive: true });
      }
    },
  );

  it("keeps generic argv stdout and stderr separate", async () => {
    const adapter = new NodeExecutionAdapter();
    try {
      const result = await adapter.run({
        command: {
          mode: "argv",
          file: process.execPath,
          args: ["-e", "process.stdout.write('stdout'); process.stderr.write('stderr')"],
        },
      });

      expect(result.stdout.text).toBe("stdout");
      expect(result.stderr.text).toBe("stderr");
    } finally {
      await adapter.close();
    }
  });

  it.skipIf(!POSIX_BASH_PATH)(
    "deletes redundant Bash files and keeps complete retained files without losing observed size",
    async () => {
      const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-exec-bash-cap-"));
      const processEnv = { ...process.env };
      delete processEnv.BASH_MAX_OUTPUT_LENGTH;
      const adapter = new NodeExecutionAdapter({ outputRootDir, processEnv });
      const shellOverride = {
        dialect: "posix" as const,
        display: { name: "bash" },
        path: POSIX_BASH_PATH!,
        source: "auto-detected" as const,
      };

      try {
        const smallResult = await adapter.run({
          command: {
            mode: "shell",
            command: "printf ok",
            shellProfile: "posix-bash",
            shellOverride,
          },
          outputLimit: {
            maxInlineBytes: 3,
            maxPersistedBytes: 4,
            maxArtifactBytes: 4,
            persistOutput: "on_truncate",
          },
          trace: {
            sessionId: "bash-cap-session",
            attributes: { toolCallId: "bash-small-tool" },
          } as any,
        });
        const smallPath = join(outputRootDir, "bash-cap-session", "bash-small-tool-stdout.log");
        expect(smallResult.stdout).toMatchObject({
          text: "ok",
          bytes: 2,
          truncated: false,
        });
        expect(smallResult.stdout.artifactPath).toBeUndefined();
        await expect(stat(smallPath)).rejects.toMatchObject({ code: "ENOENT" });

        const largeResult = await adapter.run({
          command: {
            mode: "shell",
            command: "printf abcdef",
            shellProfile: "posix-bash",
            shellOverride,
          },
          outputLimit: {
            maxInlineBytes: 3,
            maxPersistedBytes: 4,
            maxArtifactBytes: 4,
            persistOutput: "on_truncate",
          },
          trace: {
            sessionId: "bash-cap-session",
            attributes: { toolCallId: "bash-large-tool" },
          } as any,
        });

        expect(largeResult.stdout).toMatchObject({
          text: "abc",
          bytes: 6,
          truncated: true,
          artifactBytes: 6,
          artifactTruncated: false,
        });
        await expect(readFile(largeResult.stdout.artifactPath!, "utf8")).resolves.toBe("abcdef");
      } finally {
        await adapter.close();
        await rm(outputRootDir, { force: true, recursive: true });
      }
    },
  );

  it.skipIf(!POSIX_BASH_PATH)(
    "allows a short Bash command to finish before the first soft-limit check",
    async () => {
      const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-exec-bash-limit-"));
      const processEnv = { ...process.env };
      delete processEnv.BASH_MAX_OUTPUT_LENGTH;
      const adapter = new NodeExecutionAdapter({
        outputRootDir,
        processEnv,
        progressIntervalMs: 5,
        progressThresholdMs: 0,
      });

      try {
        const result = await adapter.run({
          command: {
            mode: "shell",
            command: "printf abcdef",
            shellProfile: "posix-bash",
            shellOverride: {
              dialect: "posix",
              display: { name: "bash" },
              path: POSIX_BASH_PATH!,
              source: "auto-detected",
            },
          },
          timeoutMs: 5_000,
          outputLimit: {
            killProcessOnPersistedLimit: true,
            maxInlineBytes: 3,
            maxPersistedBytes: 4,
            persistOutput: "always",
          },
          trace: {
            sessionId: "bash-watchdog-session",
            attributes: { toolCallId: "bash-watchdog-tool" },
          } as any,
        });

        expect(result).toMatchObject({
          status: "completed",
          stdout: {
            text: "abc",
            bytes: 6,
            artifactBytes: 6,
            artifactTruncated: false,
          },
        });
        await expect(readFile(result.stdout.artifactPath!, "utf8")).resolves.toBe("abcdef");
        expect(result.error).toBeUndefined();
      } finally {
        await adapter.close();
        await rm(outputRootDir, { force: true, recursive: true });
      }
    },
  );

  it("parses BASH_MAX_OUTPUT_LENGTH within its documented bounds", () => {
    expect(resolveBashMaxOutputLength({}, 30_000)).toBe(30_000);
    expect(resolveBashMaxOutputLength({}, 120)).toBe(120);
    expect(resolveBashMaxOutputLength({ BASH_MAX_OUTPUT_LENGTH: "  " }, 120)).toBe(30_000);
    expect(resolveBashMaxOutputLength({ BASH_MAX_OUTPUT_LENGTH: "4096suffix" })).toBe(4096);
    expect(resolveBashMaxOutputLength({ BASH_MAX_OUTPUT_LENGTH: "invalid" })).toBe(30_000);
    expect(resolveBashMaxOutputLength({ BASH_MAX_OUTPUT_LENGTH: "0" })).toBe(30_000);
    expect(resolveBashMaxOutputLength({ BASH_MAX_OUTPUT_LENGTH: "-1" })).toBe(30_000);
    expect(resolveBashMaxOutputLength({ BASH_MAX_OUTPUT_LENGTH: "200000" })).toBe(150_000);
  });

  it.skipIf(!POSIX_BASH_PATH)(
    "applies BASH_MAX_OUTPUT_LENGTH when reading the Bash output file",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-exec-bash-env-limit-"));
      const adapter = new NodeExecutionAdapter({
        outputRootDir: root,
        processEnv: {
          ...process.env,
          BASH_MAX_OUTPUT_LENGTH: "4suffix",
        },
      });

      try {
        const result = await adapter.run({
          command: {
            mode: "shell",
            command: "printf abcdef",
            shellProfile: "posix-bash",
            shellOverride: {
              dialect: "posix",
              display: { name: "bash" },
              path: POSIX_BASH_PATH!,
              source: "auto-detected",
            },
          },
          outputLimit: {
            maxInlineBytes: 100,
            maxPersistedBytes: 64,
            persistOutput: "on_truncate",
          },
          trace: {
            sessionId: "bash-env-limit-session",
            attributes: { toolCallId: "bash-env-limit-tool" },
          } as any,
        });

        expect(result.stdout).toMatchObject({
          text: "abcd",
          bytes: 6,
          truncated: true,
          artifactBytes: 6,
        });
      } finally {
        await adapter.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!POSIX_BASH_PATH)(
    "keeps the 30000-byte Bash boundary inline and persists byte 30001",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-exec-bash-default-limit-"));
      const processEnv = { ...process.env };
      delete processEnv.BASH_MAX_OUTPUT_LENGTH;
      const adapter = new NodeExecutionAdapter({
        outputRootDir: root,
        processEnv,
      });

      try {
        for (const size of [30_000, 30_001]) {
          const result = await adapter.run({
            command: {
              mode: "shell",
              command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('x'.repeat(${size}))"`,
              shellProfile: "posix-bash",
              shellOverride: {
                dialect: "posix",
                display: { name: "bash" },
                path: POSIX_BASH_PATH!,
                source: "auto-detected",
              },
            },
            outputLimit: {
              maxInlineBytes: 30_000,
              maxPersistedBytes: 64 * 1024 * 1024,
              persistOutput: "on_truncate",
            },
            trace: {
              sessionId: "bash-default-limit-session",
              attributes: { toolCallId: `bash-default-limit-${size}` },
            } as any,
          });

          expect(result.stdout.bytes).toBe(size);
          expect(result.stdout.text).toHaveLength(30_000);
          expect(result.stdout.truncated).toBe(size > 30_000);
          expect(result.stdout.artifactPath !== undefined).toBe(size > 30_000);
        }
      } finally {
        await adapter.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("truncates inline output while preserving observed byte counts", async () => {
    const adapter = new NodeExecutionAdapter();

    const result = await adapter.run({
      command: {
        mode: "argv",
        file: process.execPath,
        args: ["-e", "process.stdout.write('abcdef')"],
      },
      outputLimit: {
        maxInlineBytes: 3,
      },
    });

    expect(result.stdout.text).toBe("abc");
    expect(result.stdout.bytes).toBe(6);
    expect(result.stdout.truncated).toBe(true);
  });

  it("persists full stream output once inline output is truncated", async () => {
    const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-exec-output-"));
    const adapter = new NodeExecutionAdapter({ outputRootDir });

    try {
      const result = await adapter.run({
        command: {
          mode: "argv",
          file: process.execPath,
          args: ["-e", "process.stdout.write('abcdef')"],
        },
        outputLimit: {
          maxInlineBytes: 3,
          persistOutput: "on_truncate",
        },
        trace: {
          traceId: "trace-output" as never,
          sessionId: "session-output" as never,
          attributes: {
            toolCallId: "tool-output",
          },
        },
      });

      expect(result.stdout.text).toBe("abc");
      expect(result.stdout.truncated).toBe(true);
      expect(result.stdout.artifactPath).toBeDefined();
      expect(result.stdout.artifactBytes).toBe(6);
      await expect(readFile(result.stdout.artifactPath!, "utf8")).resolves.toBe("abcdef");
    } finally {
      await rm(outputRootDir, { force: true, recursive: true });
    }
  });

  it("uses the ZCode storage root for persisted output when no output root is injected", async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), "zcode-exec-storage-root-"));
    const adapter = new NodeExecutionAdapter({
      processEnv: {
        ...process.env,
        ZCODE_STORAGE_DIR: storageRoot,
      },
    });

    try {
      const result = await adapter.run({
        command: {
          mode: "argv",
          file: process.execPath,
          args: ["-e", "process.stdout.write('abcdef')"],
        },
        outputLimit: {
          maxInlineBytes: 3,
          persistOutput: "on_truncate",
        },
        trace: {
          traceId: "trace-storage-root" as never,
          sessionId: "session-storage-root" as never,
          attributes: {
            toolCallId: "tool-storage-root",
          },
        },
      });

      expect(result.stdout.artifactPath).toBe(
        join(storageRoot, "cli", "exec", "session-storage-root", "tool-storage-root-stdout.log"),
      );
      await expect(readFile(result.stdout.artifactPath!, "utf8")).resolves.toBe("abcdef");
    } finally {
      await rm(storageRoot, { force: true, recursive: true });
    }
  });

  it("caps persisted stream output while continuing to drain the child", async () => {
    const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-exec-output-"));
    const adapter = new NodeExecutionAdapter({ outputRootDir });

    try {
      const result = await adapter.run({
        command: {
          mode: "argv",
          file: process.execPath,
          args: ["-e", "process.stdout.write('abcdef')"],
        },
        outputLimit: {
          maxInlineBytes: 3,
          maxPersistedBytes: 4,
          persistOutput: "on_truncate",
        },
      });

      expect(result.status).toBe("completed");
      expect(result.stdout.bytes).toBe(6);
      expect(result.stdout.artifactBytes).toBe(4);
      expect(result.stdout.artifactTruncated).toBe(true);
      await expect(readFile(result.stdout.artifactPath!, "utf8")).resolves.toBe("abcd");
    } finally {
      await rm(outputRootDir, { force: true, recursive: true });
    }
  });

  it("kills the process when persisted output reaches a watchdog limit", async () => {
    const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-exec-output-"));
    const adapter = new NodeExecutionAdapter({ outputRootDir });

    try {
      const result = await adapter.run({
        command: {
          mode: "argv",
          file: process.execPath,
          args: ["-e", "process.stdout.write('x'.repeat(100)); setTimeout(() => {}, 5000)"],
        },
        timeoutMs: 5000,
        outputLimit: {
          maxInlineBytes: 0,
          maxPersistedBytes: 4,
          persistOutput: "always",
          killProcessOnPersistedLimit: true,
        },
      });

      expect(result.status).toBe("failed");
      expect(result.error?.type).toBe("output_limit");
      expect(result.stdout.bytes).toBe(100);
      expect(result.stdout.artifactBytes).toBe(4);
      expect(result.stdout.artifactTruncated).toBe(true);
      await expect(readFile(result.stdout.artifactPath!, "utf8")).resolves.toBe("xxxx");
    } finally {
      await rm(outputRootDir, { force: true, recursive: true });
    }
  });

  it("shares one persisted watchdog limit across stdout and stderr", async () => {
    const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-exec-aggregate-output-"));
    const adapter = new NodeExecutionAdapter({ outputRootDir });

    try {
      const result = await adapter.run(
        {
          command: {
            mode: "argv",
            file: process.execPath,
            args: [
              "-e",
              "process.stdout.write('a'.repeat(8)); process.stderr.write('b'.repeat(8)); setTimeout(() => {}, 5000)",
            ],
          },
          timeoutMs: 5000,
          outputLimit: {
            maxInlineBytes: 0,
            maxPersistedBytes: 10,
            persistOutput: "always",
            killProcessOnPersistedLimit: true,
          },
        },
        {
          sharePersistedOutputLimitAcrossStreams: true,
        } as ExecutionRunOptions & {
          sharePersistedOutputLimitAcrossStreams: boolean;
        },
      );

      expect(result.status).toBe("failed");
      expect(result.error?.type).toBe("output_limit");
      expect((result.stdout.artifactBytes ?? 0) + (result.stderr.artifactBytes ?? 0)).toBe(10);
      const [stdoutArtifact, stderrArtifact] = await Promise.all([
        readFile(result.stdout.artifactPath!),
        readFile(result.stderr.artifactPath!),
      ]);
      expect(stdoutArtifact.byteLength + stderrArtifact.byteLength).toBe(10);
    } finally {
      await adapter.close();
      await rm(outputRootDir, { force: true, recursive: true });
    }
  });

  it("tracks background executions until completion", async () => {
    const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-exec-background-"));
    const adapter = new NodeExecutionAdapter({ outputRootDir });

    try {
      const started = await adapter.start({
        command: {
          mode: "argv",
          file: process.execPath,
          args: ["-e", "setTimeout(() => process.stdout.write('bg'), 25)"],
        },
        outputLimit: {
          persistOutput: "always",
        },
        trace: {
          traceId: "trace-bg" as never,
          sessionId: "session-bg" as never,
          attributes: {
            toolCallId: "tool-bg",
          },
        },
      });

      expect(started.status).toBe("running");
      expect(started.outputPath).toBe(join(outputRootDir, "session-bg", "tool-bg-stdout.log"));
      expect(started.stdoutPersistedOutputPath).toBe(started.outputPath);
      expect(started.stderrPersistedOutputPath).toBe(
        join(outputRootDir, "session-bg", "tool-bg-stderr.log"),
      );
      await expect(readFile(started.stdoutPersistedOutputPath!, "utf8")).resolves.toBe("");
      await expect(readFile(started.stderrPersistedOutputPath!, "utf8")).resolves.toBe("");

      let snapshot = await adapter.getBackgroundTask(started.taskId);
      for (let attempt = 0; attempt < 20 && snapshot?.status === "running"; attempt++) {
        await sleep(20);
        snapshot = await adapter.getBackgroundTask(started.taskId);
      }

      expect(snapshot?.status).toBe("completed");
      expect(snapshot?.outputPath).toBe(started.outputPath);
      expect(snapshot?.stdoutPersistedOutputPath).toBe(started.stdoutPersistedOutputPath);
      expect(snapshot?.stderrPersistedOutputPath).toBe(started.stderrPersistedOutputPath);
      expect(snapshot?.result?.stdout.text).toBe("bg");
      await expect(readFile(started.stdoutPersistedOutputPath!, "utf8")).resolves.toBe("bg");
    } finally {
      await rm(outputRootDir, { force: true, recursive: true });
    }
  });

  it("does not capture cwd for background shell executions", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-exec-background-cwd-"));
    const child = join(root, "child");
    await mkdir(child);
    const adapter = new NodeExecutionAdapter();

    try {
      const started = await adapter.start({
        command: {
          mode: "shell",
          command: `cd ${JSON.stringify(child)}; printf bg`,
        },
        cwd: root,
        captureCwdAfterSuccess: true,
      });

      let snapshot = await adapter.getBackgroundTask(started.taskId);
      for (let attempt = 0; attempt < 20 && snapshot?.status === "running"; attempt++) {
        await sleep(20);
        snapshot = await adapter.getBackgroundTask(started.taskId);
      }

      expect(snapshot?.status).toBe("completed");
      expect(snapshot?.result?.stdout.text).toBe("bg");
      expect(snapshot?.result?.resolvedCwd).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(!POSIX_BASH_PATH)(
    "runs posix-bash shell profile commands in background executions",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-exec-bg-bash-"));
      const home = join(root, "home");
      await mkdir(home, { recursive: true });

      try {
        const adapter = new NodeExecutionAdapter({
          outputRootDir: root,
          processEnv: {
            ...process.env,
            HOME: home,
            SHELL: POSIX_BASH_PATH!,
          },
        });

        const started = await adapter.start({
          command: {
            mode: "shell",
            command: "cat <(printf bg)",
            shellProfile: "posix-bash",
            shellOverride: {
              dialect: "posix",
              display: { name: "bash" },
              path: POSIX_BASH_PATH!,
              source: "auto-detected",
            },
          },
          captureCwdAfterSuccess: true,
        });

        let snapshot = await adapter.getBackgroundTask(started.taskId);
        for (let attempt = 0; attempt < 50 && snapshot?.status === "running"; attempt++) {
          await sleep(20);
          snapshot = await adapter.getBackgroundTask(started.taskId);
        }

        expect(snapshot?.status).toBe("completed");
        expect(snapshot?.result?.stdout.text).toBe("bg");
        expect(snapshot?.result?.resolvedCwd).toBeUndefined();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!POSIX_BASH_PATH)(
    "keeps one canonical Bash output file across explicit background commit",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-exec-bg-bash-output-"));
      const home = join(root, "home");
      await mkdir(home, { recursive: true });
      const adapter = new NodeExecutionAdapter({
        outputRootDir: root,
        processEnv: {
          ...process.env,
          HOME: home,
          SHELL: POSIX_BASH_PATH!,
        },
        progressIntervalMs: 5,
        progressThresholdMs: 1,
      });
      const capable = adapter as BashBackgroundLifecycleCapableAdapter;

      try {
        const result = await capable.runBashWithBackgroundLifecycle!(
          {
            command: {
              mode: "shell",
              command: "printf 'out\\n'; printf 'err\\n' >&2; sleep 0.05; printf 'done\\n'",
              shellProfile: "posix-bash",
              shellOverride: {
                dialect: "posix",
                display: { name: "bash" },
                path: POSIX_BASH_PATH!,
                source: "auto-detected",
              },
            },
            outputLimit: {
              maxInlineBytes: 30_000,
              maxPersistedBytes: 64 * 1024 * 1024,
              persistOutput: "on_truncate",
            },
            trace: {
              sessionId: "bash-background-output-session",
              attributes: { toolCallId: "bash-background-output-tool" },
            } as any,
          },
          { mode: "explicit" },
        );

        expect(result.kind).toBe("backgrounded");
        expect(result.task.outputPath).toBe(result.task.stdoutPersistedOutputPath);
        expect(result.task.stderrPersistedOutputPath).toBeUndefined();
        await expect(readFile(result.task.outputPath!, "utf8")).resolves.toBeDefined();

        await vi.waitFor(async () => {
          expect(await readFile(result.task.outputPath!, "utf8")).toContain("out");
        });
        const snapshot = await capable.waitForBackgroundTask!(result.task.taskId);
        expect(snapshot?.status).toBe("completed");
        expect(snapshot?.stdoutPersistedOutputPath).toBe(result.task.outputPath);
        expect(snapshot?.stderrPersistedOutputPath).toBeUndefined();
        expect(snapshot?.result?.stdout.text).toBe("out\nerr\ndone\n");
        expect(snapshot?.result?.stderr).toEqual({
          text: "",
          bytes: 0,
          truncated: false,
        });
        await expect(readFile(result.task.outputPath!, "utf8")).resolves.toBe("out\nerr\ndone\n");
      } finally {
        await adapter.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("updates background snapshots with progress output", async () => {
    const adapter = new NodeExecutionAdapter({
      progressIntervalMs: 10,
      progressTailBytes: 128,
      progressThresholdMs: 1,
    });

    const started = await adapter.start({
      command: {
        mode: "argv",
        file: process.execPath,
        args: ["-e", "process.stdout.write('ready'); setTimeout(() => {}, 1000)"],
      },
    });

    let snapshot = await adapter.getBackgroundTask(started.taskId);
    for (let attempt = 0; attempt < 50 && snapshot?.stdoutBytes !== 5; attempt++) {
      await sleep(20);
      snapshot = await adapter.getBackgroundTask(started.taskId);
    }

    expect(snapshot?.status).toBe("running");
    expect(snapshot?.stdoutBytes).toBe(5);
    expect(snapshot?.stdoutTail).toBe("ready");

    const cancelled = await adapter.cancelBackgroundTask(started.taskId);
    expect(cancelled?.status).toBe("cancelled");
  });
});

describe("Windows Git Bash discovery", () => {
  const fixedBashPath = "C:\\Program Files\\Git\\bin\\bash.exe";
  const fixedX86BashPath = "C:\\Program Files (x86)\\Git\\bin\\bash.exe";

  function installationFiles(root: string): string[] {
    return [
      win32.join(root, "bin", "bash.exe"),
      win32.join(root, "cmd", "git.exe"),
      win32.join(root, "git-bash.exe"),
    ];
  }

  function discoveryFixture(
    env: NodeJS.ProcessEnv,
    executables: string[],
    textFiles: Record<string, string> = {},
  ) {
    const availablePaths = new Set(executables);
    // 回归测试必须隔离真实注册表和 Scoop 配置，避免当前机器的 Git 安装掩盖漏检。
    const isExecutable = vi.fn((path: string) => availablePaths.has(path));
    const readRegistryInstallRoots = vi.fn(async (): Promise<string[]> => []);
    const readTextFile = vi.fn(async (path: string): Promise<string> => {
      if (Object.hasOwn(textFiles, path)) return textFiles[path]!;
      throw Object.assign(new Error("Missing fixture file"), { code: "ENOENT" });
    });
    return {
      env,
      platform: "win32",
      isExecutable,
      readRegistryInstallRoots,
      readTextFile,
    };
  }

  it("keeps legacy fixed directories ahead of PATH and added installation roots", async () => {
    const customRoot = "D:\\PortableGit";
    const fixture = discoveryFixture(
      { PATH: win32.join(customRoot, "cmd"), GIT_INSTALL_ROOT: customRoot },
      [fixedBashPath, fixedX86BashPath, ...installationFiles(customRoot)],
    );

    expect(await discoverWindowsGitBash(fixture)).toEqual({
      path: fixedBashPath,
      source: "system",
    });
    expect(fixture.readRegistryInstallRoots).not.toHaveBeenCalled();
    expect(fixture.readTextFile).not.toHaveBeenCalled();
  });

  it("keeps the legacy x86 fixed directory without requiring new layout markers", async () => {
    const fixture = discoveryFixture({ PATH: "" }, [fixedX86BashPath]);

    expect(await discoverWindowsGitBash(fixture)).toEqual({
      path: fixedX86BashPath,
      source: "system",
    });
  });

  it.each(["PATH", "Path", "pAtH"])(
    "handles quoted PATH entries, empty entries and the %s environment key",
    async (pathKey) => {
      const root = "D:\\Git With Spaces";
      const bashPath = win32.join(root, "bin", "bash.exe");
      const fixture = discoveryFixture(
        { [pathKey]: `;;"";"${win32.join(root, "cmd")}";;`, pAtHeXt: ".EXE;.CMD" },
        [win32.join(root, "cmd", "git.exe"), bashPath],
      );

      // 原 PATH 推导只检查 Git 和 Bash，不能因新增布局校验而要求旧安装提供启动器。
      expect(await discoverWindowsGitBash(fixture)).toEqual({ path: bashPath, source: "path" });
      expect(fixture.isExecutable).not.toHaveBeenCalledWith("git.exe");
      expect(fixture.isExecutable).not.toHaveBeenCalledWith("bash.exe");
    },
  );

  it("continues after the first PATH Git has no Bash and finds the next installation", async () => {
    const root = "E:\\WorkingGit";
    const bashPath = win32.join(root, "bin", "bash.exe");
    const fixture = discoveryFixture({ PATH: `D:\\BrokenGit\\cmd;${win32.join(root, "cmd")}` }, [
      "D:\\BrokenGit\\cmd\\git.exe",
      win32.join(root, "cmd", "git.exe"),
      bashPath,
    ]);

    expect(await discoverWindowsGitBash(fixture)).toEqual({ path: bashPath, source: "path" });
    expect(fixture.isExecutable).toHaveBeenCalledWith("D:\\BrokenGit\\bin\\bash.exe");
  });

  it("keeps PATH ahead of newly discovered system installation roots", async () => {
    const pathRoot = "D:\\PathGit";
    const fixture = discoveryFixture(
      { PATH: win32.join(pathRoot, "cmd"), GIT_INSTALL_ROOT: "E:\\ConfiguredGit" },
      [...installationFiles(pathRoot), ...installationFiles("E:\\ConfiguredGit")],
    );

    expect(await discoverWindowsGitBash(fixture)).toEqual({
      path: win32.join(pathRoot, "bin", "bash.exe"),
      source: "path",
    });
  });

  it.each(["GIT_INSTALL_ROOT", "git_install_root"])(
    "discovers a complete installation from %s",
    async (key) => {
      const root = "E:\\CustomGit";
      const fixture = discoveryFixture({ [key]: root }, installationFiles(root));

      expect(await discoverWindowsGitBash(fixture)).toEqual({
        path: win32.join(root, "bin", "bash.exe"),
        source: "system",
      });
    },
  );

  it.each(["ProgramFiles", "ProgramFiles(x86)", "pRoGrAmFiLeS"])(
    "discovers Git when the system %s directory is relocated",
    async (key) => {
      const programsRoot = "E:\\System Programs";
      const root = win32.join(programsRoot, "Git");
      const fixture = discoveryFixture({ [key]: programsRoot }, installationFiles(root));

      expect(await discoverWindowsGitBash(fixture)).toEqual({
        path: win32.join(root, "bin", "bash.exe"),
        source: "system",
      });
    },
  );

  it("uses injected official installation roots and skips a stale installation record", async () => {
    const root = "E:\\OfficialGit";
    const fixture = discoveryFixture({}, installationFiles(root));
    fixture.readRegistryInstallRoots.mockResolvedValue(["D:\\RemovedGit", root]);

    expect(await discoverWindowsGitBash(fixture)).toEqual({
      path: win32.join(root, "bin", "bash.exe"),
      source: "system",
    });
    expect(fixture.readRegistryInstallRoots).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: "SCOOP user root", env: { SCOOP: "D:\\ScoopUser" }, root: "D:\\ScoopUser" },
    {
      label: "SCOOP_GLOBAL root",
      env: { SCOOP_GLOBAL: "E:\\ScoopGlobal" },
      root: "E:\\ScoopGlobal",
    },
    {
      label: "case-insensitive Scoop key",
      env: { scoop: "D:\\ScoopLower" },
      root: "D:\\ScoopLower",
    },
    {
      label: "default user root",
      env: { USERPROFILE: "D:\\Users\\dev" },
      root: "D:\\Users\\dev\\scoop",
    },
    {
      label: "explicit global root under ProgramData",
      env: { ProgramData: "E:\\ProgramData", SCOOP_GLOBAL: "E:\\ProgramData\\scoop" },
      root: "E:\\ProgramData\\scoop",
    },
  ])("discovers Scoop Git from $label", async ({ env, root }) => {
    const gitRoot = win32.join(root, "apps", "git", "current");
    const fixture = discoveryFixture(env, installationFiles(gitRoot));

    expect(await discoverWindowsGitBash(fixture)).toEqual({
      path: win32.join(gitRoot, "bin", "bash.exe"),
      source: "system",
    });
  });

  it.each([
    { configKey: "ROOT_PATH", location: "xdg" },
    { configKey: "GLOBAL_PATH", location: "xdg" },
    { configKey: "ROOT_PATH", location: "profile" },
    { configKey: "GLOBAL_PATH", location: "profile" },
    { configKey: "root_path", location: "xdg" },
    { configKey: "global_path", location: "profile" },
  ])(
    "reads Scoop $configKey from the $location config location",
    async ({ configKey, location }) => {
      const root = "E:\\ConfiguredScoop";
      const gitRoot = win32.join(root, "apps", "git", "current");
      const env: NodeJS.ProcessEnv = { USERPROFILE: "D:\\Users\\dev" };
      if (location === "xdg") env.XDG_CONFIG_HOME = "D:\\UserConfig";
      const configPath =
        location === "xdg"
          ? "D:\\UserConfig\\scoop\\config.json"
          : "D:\\Users\\dev\\.config\\scoop\\config.json";
      const fixture = discoveryFixture(env, installationFiles(gitRoot), {
        [configPath]: JSON.stringify({ [configKey]: root }),
      });

      expect(await discoverWindowsGitBash(fixture)).toEqual({
        path: win32.join(gitRoot, "bin", "bash.exe"),
        source: "system",
      });
      expect(fixture.readTextFile).toHaveBeenCalledWith(configPath);
    },
  );

  it("infers a custom Scoop root from PATH shims without Scoop environment variables", async () => {
    const root = "E:\\CustomPackageRoot";
    const gitRoot = win32.join(root, "apps", "git", "current");
    const fixture = discoveryFixture({ Path: `"${win32.join(root, "shims")}"` }, [
      win32.join(root, "shims", "git.exe"),
      ...installationFiles(gitRoot),
    ]);

    // shims 中的 Git 代理不是安装根；只用父目录线索，绝不执行代理读取目标。
    expect(await discoverWindowsGitBash(fixture)).toEqual({
      path: win32.join(gitRoot, "bin", "bash.exe"),
      source: "path",
    });
  });

  it.each([
    {
      label: "ChocolateyToolsLocation",
      env: { ChocolateyToolsLocation: "E:\\ChocoTools" },
      root: "E:\\ChocoTools",
    },
    {
      label: "legacy ChocolateyBinRoot",
      env: { ChocolateyBinRoot: "D:\\LegacyTools" },
      root: "D:\\LegacyTools",
    },
    {
      label: "legacy chocolatey_bin_root",
      env: { chocolatey_bin_root: "D:\\OldTools" },
      root: "D:\\OldTools",
    },
    {
      label: "explicit tools root on SystemDrive",
      env: { SystemDrive: "E:", ChocolateyToolsLocation: "E:\\tools" },
      root: "E:\\tools",
    },
  ])("discovers Chocolatey PortableGit from $label", async ({ env, root }) => {
    const gitRoot = win32.join(root, "git");
    const fixture = discoveryFixture(env, installationFiles(gitRoot));

    expect(await discoverWindowsGitBash(fixture)).toEqual({
      path: win32.join(gitRoot, "bin", "bash.exe"),
      source: "system",
    });
  });

  it.each([
    {
      label: "global Scoop under ProgramData",
      root: "E:\\ProgramData\\scoop\\apps\\git\\current",
    },
    { label: "portable Git under SystemDrive tools", root: "E:\\tools\\git" },
  ])("ignores an unhinted shared installation in $label", async ({ root }) => {
    const fixture = discoveryFixture(
      { USERPROFILE: "D:\\Users\\dev", ProgramData: "E:\\ProgramData", SystemDrive: "E:" },
      installationFiles(root),
    );

    // 共享目录的三文件布局可被伪造；仅知道系统目录位置不能授权自动执行其中的 Bash。
    expect(await discoverWindowsGitBash(fixture)).toBeUndefined();
    expect(fixture.isExecutable).not.toHaveBeenCalledWith(win32.join(root, "bin", "bash.exe"));
    const resolution = await resolveEffectiveBashShellSelection({
      env: fixture.env,
      platform: fixture.platform,
      exists: fixture.isExecutable,
      gitBashDiscovery: {
        readRegistryInstallRoots: fixture.readRegistryInstallRoots,
        readTextFile: fixture.readTextFile,
      },
    });
    expect(resolution.selection.dialect).toBe("cmd");
  });

  it.each(["missing", "blank", "stale", "read-failure"])(
    "does not restore shared directory defaults when installation clues are %s",
    async (kind) => {
      const env: NodeJS.ProcessEnv = {
        USERPROFILE: "D:\\Users\\dev",
        ProgramData: "E:\\ProgramData",
        SystemDrive: "E:",
      };
      if (kind === "blank") Object.assign(env, { SCOOP_GLOBAL: " ", ChocolateyToolsLocation: "" });
      if (kind === "stale") {
        Object.assign(env, {
          SCOOP_GLOBAL: "D:\\RemovedScoop",
          ChocolateyToolsLocation: "D:\\RemovedTools",
        });
      }
      const fixture = discoveryFixture(env, [
        ...installationFiles("E:\\ProgramData\\scoop\\apps\\git\\current"),
        ...installationFiles("E:\\tools\\git"),
      ]);
      if (kind === "read-failure") {
        fixture.readRegistryInstallRoots.mockRejectedValue(new Error("Registry unavailable"));
        fixture.readTextFile.mockRejectedValue(new Error("Config unavailable"));
      }
      expect(await discoverWindowsGitBash(fixture)).toBeUndefined();
    },
  );

  it.each(["scoop-config", "scoop-path", "chocolatey-path"])(
    "keeps an explicitly referenced shared installation via %s",
    async (kind) => {
      const root =
        kind === "chocolatey-path"
          ? "E:\\tools\\git"
          : "E:\\ProgramData\\scoop\\apps\\git\\current";
      const env: NodeJS.ProcessEnv = { USERPROFILE: "D:\\Users\\dev" };
      const textFiles: Record<string, string> = {};
      if (kind === "scoop-config") {
        textFiles["D:\\Users\\dev\\.config\\scoop\\config.json"] = JSON.stringify({
          GLOBAL_PATH: "E:\\ProgramData\\scoop",
        });
      } else {
        env.PATH =
          kind === "scoop-path" ? "E:\\ProgramData\\scoop\\shims" : win32.join(root, "bin");
      }
      const fixture = discoveryFixture(
        env,
        [
          ...installationFiles(root),
          ...(kind === "chocolatey-path" ? [win32.join(root, "bin", "git.exe")] : []),
        ],
        textFiles,
      );
      expect(await discoverWindowsGitBash(fixture)).toEqual({
        path: win32.join(root, "bin", "bash.exe"),
        source: kind === "scoop-config" ? "system" : "path",
      });
    },
  );

  it.each(["bin\\bash.exe", "cmd\\git.exe", "git-bash.exe"])(
    "rejects an added installation root missing %s",
    async (missingFile) => {
      const root = "D:\\IncompleteGit";
      const fixture = discoveryFixture(
        { GIT_INSTALL_ROOT: root },
        installationFiles(root).filter((path) => path !== win32.join(root, missingFile)),
      );

      expect(await discoverWindowsGitBash(fixture)).toBeUndefined();
    },
  );

  it("continues from stale environment roots to a valid later installation", async () => {
    const root = "E:\\ScoopGlobal\\apps\\git\\current";
    const fixture = discoveryFixture(
      {
        GIT_INSTALL_ROOT: "D:\\RemovedGit",
        SCOOP: "D:\\RemovedScoop",
        SCOOP_GLOBAL: "E:\\ScoopGlobal",
      },
      installationFiles(root),
    );

    expect(await discoverWindowsGitBash(fixture)).toEqual({
      path: win32.join(root, "bin", "bash.exe"),
      source: "system",
    });
  });

  it.each(["ENOENT", "EACCES"])(
    "continues after registry and Scoop config reads fail with %s",
    async (code) => {
      const root = "E:\\ChocoTools\\git";
      const fixture = discoveryFixture(
        { USERPROFILE: "D:\\Users\\dev", ChocolateyToolsLocation: "E:\\ChocoTools" },
        installationFiles(root),
      );
      const readError = Object.assign(new Error("Unavailable fixture source"), { code });
      fixture.readRegistryInstallRoots.mockRejectedValue(readError);
      fixture.readTextFile.mockRejectedValue(readError);

      expect(await discoverWindowsGitBash(fixture)).toEqual({
        path: win32.join(root, "bin", "bash.exe"),
        source: "system",
      });
      expect(fixture.readRegistryInstallRoots).toHaveBeenCalled();
      expect(fixture.readTextFile).toHaveBeenCalledWith(
        "D:\\Users\\dev\\.config\\scoop\\config.json",
      );
    },
  );

  it("continues after a malformed Scoop config to a valid Chocolatey root", async () => {
    const root = "E:\\ChocoTools\\git";
    const fixture = discoveryFixture(
      { XDG_CONFIG_HOME: "D:\\UserConfig", ChocolateyToolsLocation: "E:\\ChocoTools" },
      installationFiles(root),
      { "D:\\UserConfig\\scoop\\config.json": "{invalid-json" },
    );

    expect(await discoverWindowsGitBash(fixture)).toEqual({
      path: win32.join(root, "bin", "bash.exe"),
      source: "system",
    });
  });

  it("does not accept arbitrary WSL, MSYS2 or Cygwin Bash executables", async () => {
    const bashPaths = [
      "C:\\Windows\\System32\\bash.exe",
      "D:\\msys64\\usr\\bin\\bash.exe",
      "D:\\cygwin64\\bin\\bash.exe",
    ];
    const fixture = discoveryFixture(
      { PATH: bashPaths.map((path) => win32.dirname(path)).join(";"), SHELL: bashPaths[1] },
      bashPaths,
    );

    expect(await discoverWindowsGitBash(fixture)).toBeUndefined();
  });

  it("uses a PATH Git Bash launcher only as a layout clue and returns bin Bash", async () => {
    const root = "E:\\PortableGit";
    const fixture = discoveryFixture({ PATH: `"${root}"` }, installationFiles(root));

    expect(await discoverWindowsGitBash(fixture)).toEqual({
      path: win32.join(root, "bin", "bash.exe"),
      source: "path",
    });
  });

  it("does not return git-bash.exe when the corresponding bin Bash is missing", async () => {
    const root = "E:\\LauncherOnly";
    const fixture = discoveryFixture({ PATH: root, GIT_INSTALL_ROOT: root }, [
      win32.join(root, "git-bash.exe"),
      win32.join(root, "cmd", "git.exe"),
    ]);

    expect(await discoverWindowsGitBash(fixture)).toBeUndefined();
  });

  it("awaits an asynchronous executable probe", async () => {
    const fixture = discoveryFixture({}, []);
    const isExecutable = vi.fn(async (path: string) => path === fixedX86BashPath);

    expect(await discoverWindowsGitBash({ ...fixture, isExecutable })).toEqual({
      path: fixedX86BashPath,
      source: "system",
    });
    expect(isExecutable).toHaveBeenCalledWith(fixedBashPath);
    expect(isExecutable).toHaveBeenCalledWith(fixedX86BashPath);
  });

  it("maps a discovered Scoop installation to the effective selection and execution provider", async () => {
    const scoopRoot = "E:\\ScoopUser";
    const root = win32.join(scoopRoot, "apps", "git", "current");
    const bashPath = win32.join(root, "bin", "bash.exe");
    const fixture = discoveryFixture({ SCOOP: scoopRoot }, installationFiles(root));
    const options = {
      env: fixture.env,
      platform: fixture.platform,
      exists: fixture.isExecutable,
      gitBashDiscovery: {
        readRegistryInstallRoots: fixture.readRegistryInstallRoots,
        readTextFile: fixture.readTextFile,
      },
    };

    const resolution = await resolveEffectiveBashShellSelection(options);
    expect(resolution.selection).toMatchObject({
      dialect: "git-bash",
      display: { name: "Git Bash" },
      path: bashPath,
      source: "auto-detected",
    });
    expect(resolution.provider).toEqual({
      dialect: "git-bash",
      envOverlay: { GIT_EDITOR: "true", SHELL: bashPath },
      file: bashPath,
      shell: false,
    });
    expect(
      await resolveExecutionCommand(
        { mode: "shell", command: "printf ok", shellProfile: "posix-bash" },
        options,
      ),
    ).toMatchObject({
      args: ["-c", "-l", "printf ok"],
      cwdDialect: "git-bash",
      envOverlay: { GIT_EDITOR: "true", SHELL: bashPath },
      file: bashPath,
      shell: false,
    });
  });

  it.each(["user-config", "auto-detected"] as const)(
    "does not read installation sources for a valid %s shell selection",
    async (source) => {
      const bashPath = "E:\\SelectedGit\\bin\\bash.exe";
      const fixture = discoveryFixture({ SCOOP: "D:\\OtherScoop" }, [bashPath]);
      const override = {
        dialect: "git-bash" as const,
        display: { name: "Git Bash" },
        path: bashPath,
        source,
      };
      const options = {
        env: fixture.env,
        platform: fixture.platform,
        exists: fixture.isExecutable,
        gitBashDiscovery: {
          readRegistryInstallRoots: fixture.readRegistryInstallRoots,
          readTextFile: fixture.readTextFile,
        },
      };

      // 用户选择和 runtime 快照已有确定的路径；异步发现不能重新读取安装来源覆盖它。
      const resolution = await resolveEffectiveBashShellSelection({ ...options, override });
      expect(resolution.selection).toMatchObject(override);
      expect(resolution.provider).toMatchObject({ file: bashPath, shell: false });
      expect(
        await resolveExecutionCommand(
          {
            mode: "shell",
            command: "printf ok",
            shellProfile: "posix-bash",
            shellOverride: override,
          },
          options,
        ),
      ).toMatchObject({ file: bashPath, shell: false });
      expect(fixture.readRegistryInstallRoots).not.toHaveBeenCalled();
      expect(fixture.readTextFile).not.toHaveBeenCalled();
      if (source === "auto-detected") expect(fixture.isExecutable).not.toHaveBeenCalled();
    },
  );

  it.each(["linux", "darwin"])("does not probe any Windows source on %s", async (platform) => {
    const fixture = discoveryFixture(
      { PATH: "C:\\Program Files\\Git\\cmd", GIT_INSTALL_ROOT: "C:\\Program Files\\Git" },
      [fixedBashPath],
    );

    expect(await discoverWindowsGitBash({ ...fixture, platform })).toBeUndefined();
    expect(fixture.isExecutable).not.toHaveBeenCalled();
    expect(fixture.readRegistryInstallRoots).not.toHaveBeenCalled();
    expect(fixture.readTextFile).not.toHaveBeenCalled();
  });
});

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }

  if (process.platform === "win32") {
    return true;
  }

  try {
    const state = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
    }).trim();
    return state.length > 0 && !state.startsWith("Z");
  } catch {
    return false;
  }
}

function quotePosixShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function readPosixProcessGroupId(pid: number): number {
  return Number(
    execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).trim(),
  );
}
