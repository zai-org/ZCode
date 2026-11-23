import type { BackgroundBashOutputResult } from "@zcode/shared";
// ============================================================
// Execution Port - subprocess execution boundary
// ============================================================

import type { ExecutionContext, TraceContext } from "../tracing/tracer.js";

export type ExecutionCommand =
  | {
      mode: "argv";
      file: string;
      args?: string[];
    }
  | {
      mode: "shell";
      command: string;
      shell?: true | string;
      /**
       * Internal Bash tool shell selection profile. This must not be exposed through hooks,
       * user config, or generic shell execution.
       */
      shellProfile?: "posix-bash";
      /**
       * ZCode runtime-provided Bash shell selection. Current consumers must only use
       * this when shellProfile === "posix-bash"; generic shell execution must ignore it.
       */
      shellOverride?: ExecutionShellSelection;
    };

export type ExecutionShellDialect = "cmd" | "posix" | "git-bash";

export type ExecutionShellSource = "auto-detected" | "user-config" | "legacy-fallback";

/**
 * 所有 `dialect: "cmd"` selection 的 display.name（手选 CMD 与 Windows 找不到 Git Bash 时的回落）。
 * 环境公告见到这个 Shell 名时，在 Shell 行括号里加 CMD 命令规则。
 */
export const WINDOWS_CMD_SHELL_DISPLAY_NAME = "cmd.exe";

export interface ExecutionShellDisplay {
  /**
   * Stable provider-visible shell name. Never include absolute paths here.
   * Examples: "bash", "zsh", "Git Bash", "cmd.exe", "system shell".
   */
  name: string;
}

export interface ExecutionShellSelection {
  /** Stable id from UI/settings or resolver-generated auto id. */
  id?: string;
  /** Human-readable diagnostic label. This can include more detail than display.name. */
  label?: string;
  /** Executable path when ZCode resolved a concrete shell. Omitted for legacy shell fallback. */
  path?: string;
  /**
   * Shell syntax and cwd capture wrapper semantics.
   * `legacy-shell` 是 POSIX 找不到 bash/zsh 时的 /bin/sh 回落；Windows 已不再产出，权限代码里的 Windows 分支只作兼容。
   */
  dialect: ExecutionShellDialect | "legacy-shell";
  /** Why this selection exists. */
  source: ExecutionShellSource;
  /** Provider-visible stable name. */
  display: ExecutionShellDisplay;
}

export type ExecutionShellOverride = ExecutionShellSelection;

export type ExecutionEnvBase = "inherit" | "empty";

export interface ExecutionEnvOverlay {
  base?: ExecutionEnvBase;
  set?: Record<string, string>;
  unset?: string[];
}

interface EmbeddedSearchCommandBackend {
  /**
   * Execution strategy for Bash-level embedded find/grep/rg. This is deliberately
   * below provider-visible policy so the runtime can swap the implementation later.
   */
  command: string;
  args?: string[];
  /**
   * backend 调用需要的环境变量。桌面端 Electron Helper 执行
   * zcode.cjs 时必须带 ELECTRON_RUN_AS_NODE=1，否则会按 Electron 子进程启动。
   */
  env?: Record<string, string>;
}

export interface EmbeddedSearchInternalCliBackend extends EmbeddedSearchCommandBackend {
  kind: "internal-cli";
}

export interface EmbeddedSearchArgv0DispatchBackend extends EmbeddedSearchCommandBackend {
  kind: "argv0-dispatch";
}

export interface EmbeddedSearchNativeBinariesBackend {
  kind: "native-binaries";
  findCommand: string;
  grepCommand: string;
  rgCommand: string;
}

export type EmbeddedSearchBackend =
  | EmbeddedSearchInternalCliBackend
  | EmbeddedSearchArgv0DispatchBackend
  | EmbeddedSearchNativeBinariesBackend;

export interface ExecutionEmbeddedSearchPrelude {
  kind: "embedded-search";
  backend: EmbeddedSearchBackend;
  /** false 时不定义 find/grep，只保留与原契约一致的 rg fallback。 */
  findAndGrepEnabled?: boolean;
}

export interface ExecutionSandboxPolicy {
  enabled: boolean;
  profile?: string;
  dangerouslyDisableSandbox?: boolean;
  metadata?: Record<string, unknown>;
}

export interface ExecutionOutputLimit {
  maxInlineBytes?: number;
  maxBufferBytes?: number;
  /**
   * Controls whether stdout/stderr should be persisted to execution output files.
   * 通用执行的 on_truncate 在 inline 截断后开始写盘；Bash 从 spawn 起直接写盘，
   * 此选项只控制结算后的文件保留。
   */
  persistOutput?: "none" | "on_truncate" | "always";
  /** 通用执行为每路写盘硬上限；Bash 为合并文件的软阈值，每 5 秒检查，严格超出后终止。 */
  maxPersistedBytes?: number;
  /** 通用 pipe 执行的 artifact 上限；Bash 直写保留完整文件，不使用此上限。 */
  maxArtifactBytes?: number;
  /**
   * Stop the process tree when a persisted stream reaches maxPersistedBytes.
   * 仅控制通用 collector 执行。Bash 的文件软阈值在前后台都生效，不受此开关影响。
   */
  killProcessOnPersistedLimit?: boolean;
  /**
   * 通用 collector 执行：额外保留每路最后 tailBytes 字节，结算时放进
   * {@link ExecutionStreamResult.tail}。与 inline 上限无关——inline 截断照常计数、照常读到退出，
   * 尾部不受总输出量影响。Bash 合并文件输出不使用此字段。缺席即不保留。
   */
  tailBytes?: number;
}

export interface ExecutionRequest {
  command: ExecutionCommand;
  /** Normalized absolute cwd. Bash resolves omitted or relative cwd values from the session cwd. */
  cwd?: string;
  /**
   * Internal Bash prelude used by the Bash tool only. This must never be accepted from
   * user hooks or generic command runners.
   */
  bashPrelude?: ExecutionEmbeddedSearchPrelude;
  /**
   * Internal state capture. Defaults to false and must only be enabled by the Bash tool for
   * foreground executions. This must not be used for hooks or generic shell commands.
   */
  captureCwdAfterSuccess?: boolean;
  env?: ExecutionEnvOverlay;
  stdin?: string | Uint8Array;
  timeoutMs?: number;
  outputLimit?: ExecutionOutputLimit;
  sandbox?: ExecutionSandboxPolicy;
  trace?: TraceContext;
}

export type ExecutionStatus = "completed" | "failed" | "timed_out" | "cancelled" | "spawn_error";

export type ExecutionFailureType =
  | "spawn_error"
  | "timeout"
  | "cancelled"
  | "sandbox_violation"
  | "output_limit"
  | "unknown";

export interface ExecutionFailure {
  type: ExecutionFailureType;
  message: string;
  cause?: unknown;
}

export interface ExecutionStreamResult {
  text: string;
  bytes: number;
  truncated: boolean;
  artifactPath?: string;
  artifactBytes?: number;
  artifactTruncated?: boolean;
  /** 请求了 {@link ExecutionOutputLimit.tailBytes} 时，该路最后 tailBytes 字节（字节边界切，解码后首字符可能是 U+FFFD）。 */
  tail?: string;
}

export interface ExecutionResult {
  status: ExecutionStatus;
  exitCode?: number;
  signal?: string;
  stdout: ExecutionStreamResult;
  stderr: ExecutionStreamResult;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
  startedAt: Date;
  completedAt: Date;
  pid?: number;
  error?: ExecutionFailure;
  /** Internal runtime state captured after a successful command; never provider-visible output. */
  resolvedCwd?: string;
}

/** 单次有界尾读计算的 Bash 进度，不持有完整命令输出。 */
export interface ExecutionOutputPreview {
  text: string;
  fullText: string;
  totalLines: number;
  totalBytes: number;
  linesEstimated: boolean;
}

/** Bash 只发送 started/progress/completed/failed；逐 chunk 输出事件仅用于 pipe 执行。 */
export type ExecutionEvent =
  | {
      type: "started";
      pid?: number;
      timestamp: Date;
    }
  | {
      type: "stdout" | "stderr";
      chunk: Uint8Array;
      text: string;
      timestamp: Date;
    }
  | {
      type: "progress";
      elapsedMs: number;
      pid?: number;
      stdoutBytes: number;
      stderrBytes: number;
      outputPreview?: ExecutionOutputPreview;
      stdoutTail?: string;
      stderrTail?: string;
      timestamp: Date;
    }
  | {
      type: "completed";
      result: ExecutionResult;
      timestamp: Date;
    }
  | {
      type: "failed";
      error: ExecutionFailure;
      timestamp: Date;
    };

export interface ExecutionRunOptions {
  signal?: AbortSignal;
  onEvent?: (event: ExecutionEvent) => void | Promise<void>;
  context?: ExecutionContext;
}

export type BackgroundExecutionStatus = "running" | ExecutionStatus;

export interface BackgroundExecutionStartResult {
  taskId: string;
  status: "running";
  startedAt: Date;
  pid?: number;
  outputPath?: string;
  stderrPersistedOutputPath?: string;
  stdoutPersistedOutputPath?: string;
}

export interface BackgroundExecutionSnapshot {
  taskId: string;
  status: BackgroundExecutionStatus;
  startedAt: Date;
  completedAt?: Date;
  pid?: number;
  stderrBytes?: number;
  stderrTail?: string;
  stdoutBytes?: number;
  stdoutTail?: string;
  outputPath?: string;
  stderrPersistedOutputPath?: string;
  stdoutPersistedOutputPath?: string;
  result?: ExecutionResult;
  error?: ExecutionFailure;
}

export interface AdbExecutableRequest {
  file: string;
  cwd: string;
  workspaceRoot: string;
}

export type AdbExecutableResolution =
  | { status: "resolved"; path: string }
  | { status: "workspace" | "missing" };

export interface ExecutionPort {
  /** 只解析和校验，不启动子进程；返回可直接执行的工作区外 canonical 绝对路径。 */
  resolveAdbExecutable?(request: AdbExecutableRequest): Promise<AdbExecutableResolution>;
  run(request: ExecutionRequest, options?: ExecutionRunOptions): Promise<ExecutionResult>;
  start?(
    request: ExecutionRequest,
    options?: ExecutionRunOptions,
  ): Promise<BackgroundExecutionStartResult>;
  getBackgroundTask?(taskId: string): Promise<BackgroundExecutionSnapshot | undefined>;
  /** 只读已登记的后台 Bash，固定读取文件尾部 8 KiB。 */
  readBackgroundBashOutput?(taskId: string, sessionId: string): Promise<BackgroundBashOutputResult>;
  cancelBackgroundTask?(taskId: string): Promise<BackgroundExecutionSnapshot | undefined>;
  close?(): Promise<void>;
}
