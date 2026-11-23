import { spawn, type ChildProcess } from "node:child_process";
import { DEFAULT_GIT_COMMAND_TIMEOUT_MS, DEFAULT_GIT_OUTPUT_BYTES } from "../config.js";
import {
  createGitEnvironmentProvider,
  type GitEnvironmentProvider,
} from "./gitEnvironmentProvider.js";

export interface GitCommandExecutionOptions {
  cwd: string;
  args: string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
  /** 逐块回调原始输出（例如受管 worktree 创建进度）；不影响 stdout/stderr 的收集与截断。 */
  onOutput?: (chunk: { stream: "stdout" | "stderr"; text: string }) => void;
}

export interface GitCommandExecutionResult {
  binaryPath: string;
  cwd: string;
  args: string[];
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  timedOut: boolean;
  timeoutMs?: number;
  timeoutElapsedMs?: number;
  timeoutCloseDelayMs?: number;
  forceKillAttempted?: boolean;
  orphaned?: boolean;
  outputTruncated: boolean;
}

export interface GitCommandProvider {
  resolveGitBinary(): Promise<string | null>;
  run(options: GitCommandExecutionOptions): Promise<GitCommandExecutionResult>;
}

// 产品 Git 子进程的统一加固，规则见 docs/git/architecture.md「Git 子进程安全调用约定」。
// core.fsmonitor 置空：自动查询不得执行仓库配置的 fsmonitor 脚本（ZP-20261105-08）。
const PRODUCT_GIT_CONFIG_ARGS = ["-c", "core.fsmonitor="] as const;
// 输出 patch 时 Git 会执行 diff.<driver>.textconv，而 --no-ext-diff 只禁止 external diff，
// 因此两个参数必须同时带上；只带 --no-ext-diff 时，仓库里的 .gitattributes 与 .git/config 仍能启动命令。
const PATCH_OUTPUT_SUBCOMMANDS = new Set(["diff", "show", "log"]);
const PATCH_OUTPUT_GUARD_ARGS = ["--no-ext-diff", "--no-textconv"] as const;

/**
 * 生成实际 spawn 的 argv：配置前缀在前，防护参数紧跟子命令，调用方参数保持不变。
 * 调用方不再自行声明这些参数，避免新增调用点漏加。
 *
 * 只按 args[0] 识别子命令。调用方不能在子命令前加全局选项（如 ["-c", "x=y", "diff"]）：
 * 此时 args[0] 为 "-c"，不在 PATCH_OUTPUT_SUBCOMMANDS 中，防护参数不会加上。
 * 新增会输出 patch 或执行 textconv 的子命令（如 diff-tree、format-patch、blame）时，必须加入 PATCH_OUTPUT_SUBCOMMANDS。
 */
export function buildProductGitArgs(args: readonly string[]): string[] {
  const [subcommand, ...rest] = args;
  if (subcommand === undefined) return [...PRODUCT_GIT_CONFIG_ARGS];
  const guard = PATCH_OUTPUT_SUBCOMMANDS.has(subcommand) ? PATCH_OUTPUT_GUARD_ARGS : [];
  return [...PRODUCT_GIT_CONFIG_ARGS, subcommand, ...guard, ...rest];
}

const DEFAULT_TIMEOUT_KILL_GRACE_MS = 2_000;
const DEFAULT_TIMEOUT_FORCE_KILL_GRACE_MS = 2_000;
const WINDOWS_TASKKILL_TIMEOUT_MS = 2_000;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function forceKillChildProcess(child: ChildProcess, platform: NodeJS.Platform): void {
  if (platform === "win32" && typeof child.pid === "number") {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      killer.kill();
    }, WINDOWS_TASKKILL_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timer);
    };
    killer.once("error", cleanup);
    killer.once("close", cleanup);
    return;
  }

  child.kill("SIGKILL");
}

export function createGitCommandProvider(options?: {
  environmentProvider?: GitEnvironmentProvider;
  platform?: NodeJS.Platform;
  timeoutKillGraceMs?: number;
  timeoutForceKillGraceMs?: number;
}): GitCommandProvider {
  const environmentProvider = options?.environmentProvider ?? createGitEnvironmentProvider();
  const platform = options?.platform ?? process.platform;
  const timeoutKillGraceMs = options?.timeoutKillGraceMs ?? DEFAULT_TIMEOUT_KILL_GRACE_MS;
  const timeoutForceKillGraceMs =
    options?.timeoutForceKillGraceMs ?? DEFAULT_TIMEOUT_FORCE_KILL_GRACE_MS;

  return {
    async resolveGitBinary(): Promise<string | null> {
      return await environmentProvider.resolveGitBinary();
    },

    async run(command: GitCommandExecutionOptions): Promise<GitCommandExecutionResult> {
      const gitBinary = await environmentProvider.resolveGitBinary();
      if (!gitBinary) {
        throw new Error("Git binary is not available");
      }
      const binaryPath = gitBinary;

      const timeoutMs = command.timeoutMs ?? DEFAULT_GIT_COMMAND_TIMEOUT_MS;
      const maxOutputBytes = command.maxOutputBytes ?? DEFAULT_GIT_OUTPUT_BYTES;
      const env = {
        ...environmentProvider.createCommandEnv(),
        ...command.env,
      };
      const startedAt = Date.now();

      return await new Promise<GitCommandExecutionResult>((resolve) => {
        let stdout = "";
        let stderr = "";
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let timedOut = false;
        let timeoutElapsedMs: number | undefined;
        let forceKillAttempted = false;
        let orphaned = false;
        let outputTruncated = false;
        let settled = false;

        const child = spawn(binaryPath, buildProductGitArgs(command.args), {
          cwd: command.cwd,
          env,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });

        function buildResult(
          exitCode: number | null,
          signal: NodeJS.Signals | null,
        ): GitCommandExecutionResult {
          const durationMs = Date.now() - startedAt;
          return {
            binaryPath,
            cwd: command.cwd,
            args: command.args,
            stdout,
            stderr,
            exitCode,
            signal,
            durationMs,
            timedOut,
            timeoutMs,
            timeoutElapsedMs,
            timeoutCloseDelayMs:
              timedOut && timeoutElapsedMs !== undefined
                ? Math.max(durationMs - timeoutElapsedMs, 0)
                : undefined,
            forceKillAttempted,
            orphaned,
            outputTruncated,
          };
        }

        function settle(result: GitCommandExecutionResult): void {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          child.stdout?.off("data", appendStdoutChunk);
          child.stderr?.off("data", appendStderrChunk);
          child.removeAllListeners("error");
          child.removeAllListeners("close");
          if (result.orphaned) {
            // Windows 上 Git helper/filter 可能拖住 stdout/stderr 句柄，
            // 如果超时后仍未 close，先断开本进程对管道和子进程句柄的引用，避免 checkpoint 继续卡住主链路。
            child.stdout?.destroy();
            child.stderr?.destroy();
            child.unref();
          }
          resolve(result);
        }

        async function handleTimeout(): Promise<void> {
          if (settled) {
            return;
          }
          timedOut = true;
          timeoutElapsedMs = Date.now() - startedAt;
          child.kill();

          await wait(timeoutKillGraceMs);
          if (settled) {
            return;
          }

          forceKillAttempted = true;
          forceKillChildProcess(child, platform);

          await wait(timeoutForceKillGraceMs);
          if (settled) {
            return;
          }

          orphaned = true;
          settle(buildResult(null, null));
        }

        const timer = setTimeout(() => {
          void handleTimeout();
        }, timeoutMs);

        const appendChunk = (chunk: Buffer, target: "stdout" | "stderr") => {
          if (outputTruncated) {
            return;
          }

          const byteLength = chunk.byteLength;
          const currentBytes = target === "stdout" ? stdoutBytes : stderrBytes;
          if (currentBytes + byteLength > maxOutputBytes) {
            outputTruncated = true;
            child.kill();
            return;
          }

          const text = chunk.toString("utf-8");
          command.onOutput?.({ stream: target, text });
          if (target === "stdout") {
            stdout += text;
            stdoutBytes += byteLength;
          } else {
            stderr += text;
            stderrBytes += byteLength;
          }
        };

        const appendStdoutChunk = (chunk: Buffer) => appendChunk(chunk, "stdout");
        const appendStderrChunk = (chunk: Buffer) => appendChunk(chunk, "stderr");

        child.once("error", (error) => {
          // 当 cwd 被并发删除或运行环境瞬时缺失 git 时，spawn 会直接抛错进入 "error" 事件。
          // 之前这里 reject 会在某些 fire-and-forget 调用链里变成 unhandled rejection，
          // 进而让 Vitest 出现整批超时假红。这里统一降级为“命令失败结果”，
          // 由上层按既有 ensureGitCommandSucceeded 语义处理，避免把异常泄漏成进程级未捕获拒绝。
          stderr = error instanceof Error ? error.message : String(error);
          settle(buildResult(-2, null));
        });
        child.stdout?.on("data", appendStdoutChunk);
        child.stderr?.on("data", appendStderrChunk);
        child.once("close", (exitCode, signal) => {
          settle(buildResult(exitCode, signal));
        });
      });
    },
  };
}
