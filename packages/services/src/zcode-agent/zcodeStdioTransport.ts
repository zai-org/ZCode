import type { WindowsRuntimeHost } from "#src/windows-runtime-host/contract.js";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { Emitter } from "@zcode/rpc";
import type { ZCodeProtocolMessage } from "@zcode/shared";
import { zcodeProtocolMessageSchema } from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import type {
  ZCodeProtocolTransport,
  ZCodeProtocolTransportClosedEvent,
} from "./zcodeProtocolTransport.js";
import {
  captureProcessGroupSnapshot,
  captureExitedRootDescendantsSnapshotAsync,
  captureProcessTreeSnapshotAsync,
  terminateProcessTree,
  terminateProcessTreeAndWait,
} from "#src/process/processTreeTerminator.js";
import type { ProcessTreeSnapshot } from "#src/process/processTreeTerminator.js";
import { AgentStderrCollector, EXIT_STDERR_DRAIN_MS } from "./agentStderrCollector.js";

interface ZCodeStdioTransportOptions {
  windowsRuntime?: WindowsRuntimeHost;
  onStderrLine?: (line: string) => void;
  ownedProcessGroupId?: number;
  ownedProcessStartedAtMs?: number;
}

const STDIO_EOF_EXIT_WAIT_MS = 1_800;
const DISPOSE_STDERR_DRAIN_MS = 3_250;
const E2E_COVERAGE_STDIO_EOF_EXIT_WAIT_MS = 5_000;
const PROCESS_TREE_FORCE_AFTER_MS = 2_000;
const processTreeLogger = createServiceLogger("zcode-agent-process-tree");

export class ZCodeStdioTransport implements ZCodeProtocolTransport {
  readonly kind = "stdio" as const;

  private readonly messageEmitter = new Emitter<ZCodeProtocolMessage>();
  private readonly closeEmitter = new Emitter<ZCodeProtocolTransportClosedEvent>();
  private readonly stderrCollector: AgentStderrCollector;
  private readonly stdoutDecoder = new StringDecoder("utf8");
  // 当前未完成行的分片；只在遇到 LF 时 join 一次，见 handleStdoutData 注释。
  private stdoutPendingChunks: string[] = [];
  private stdoutFlushed = false;
  private readersDisposed = false;
  private disposed = false;
  private closed = false;
  private disposeAndWaitPromise: Promise<void> | undefined;
  private cleanupProcessTreeSnapshot: ProcessTreeSnapshot | undefined;
  private cleanupAttemptCount = 0;
  private childExitedAtMs: number | undefined;

  readonly onMessage = this.messageEmitter.event;
  readonly onClose = this.closeEmitter.event;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly options?: ZCodeStdioTransportOptions,
  ) {
    this.stderrCollector = new AgentStderrCollector(child.stderr, options?.onStderrLine);

    // ZCode Protocol stdio 帧边界只认 LF。Node readline 会把 U+2028/U+2029
    // 当作换行，模型文本包含这类字符时会把合法 JSON 字符串切成半帧。
    child.stdout.on("data", this.handleStdoutData);
    child.stdout.once("end", this.handleStdoutEnd);
    child.stdout.once("close", this.handleStdoutEnd);
    child.stdin.on("error", (error) => this.handleStreamError("stdin", error));
    child.stdout.on("error", (error) => this.handleStreamError("stdout", error));
    const onRootExit = (code: number | null, signal: NodeJS.Signals | null) => {
      this.childExitedAtMs = Date.now();
      this.fireClose({ code, signal });
      this.disposeReaders();
      void this.waitForStderrDrain();
    };
    if (options?.windowsRuntime) options.windowsRuntime.onRootExit(onRootExit);
    else child.once("exit", onRootExit);
    child.once("error", (error) => {
      this.fireClose({ reason: error.message });
      this.disposeReaders();
      void this.waitForStderrDrain();
    });
  }

  async send(message: ZCodeProtocolMessage): Promise<void> {
    if (this.disposed || this.closed || this.child.killed || !this.child.stdin.writable) {
      throw new Error("ZCode agent stdio transport is closed");
    }
    const frame = `${JSON.stringify(message)}\n`;
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(frame, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  dispose(): void {
    if (this.options?.windowsRuntime || process.platform === "win32") {
      void this.disposeAndWait().catch((error) =>
        processTreeLogger.warn("runtime Job cleanup incomplete", { error: String(error) }),
      );
      return;
    }
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.disposeLocalResources();
    void this.stderrCollector.waitForDrain(DISPOSE_STDERR_DRAIN_MS);
    if (!this.hasChildExited()) {
      // POSIX 下 agent wrapper 可能继续拉起 runtime/MCP 子进程，
      // 只 kill 父进程会留下后代进程或短时间锁住 workspace cwd。
      const ownedProcessGroupId = this.options?.ownedProcessGroupId;
      terminateProcessTree(this.child, ownedProcessGroupId ? { ownedProcessGroupId } : {});
    }
  }

  disposeAndWait(options?: { deadlineAtMs?: number }): Promise<void> {
    if (!this.disposeAndWaitPromise) {
      const inFlight = this.disposeAndWaitOnce(options?.deadlineAtMs).finally(() => {
        if (this.disposeAndWaitPromise === inFlight) {
          this.disposeAndWaitPromise = undefined;
        }
      });
      this.disposeAndWaitPromise = inFlight;
    }
    return this.disposeAndWaitPromise;
  }

  waitForStderrDrain(): Promise<void> {
    return this.stderrCollector.waitForDrain();
  }

  private async disposeAndWaitOnce(deadlineAtMs?: number): Promise<void> {
    if (!this.disposed) {
      this.disposed = true;
      this.disposeLocalResources();
    }
    if (this.options?.windowsRuntime) {
      const deadline = deadlineAtMs ?? Date.now() + DISPOSE_STDERR_DRAIN_MS;
      await this.options.windowsRuntime.close(deadline);
      await this.stderrCollector.waitForDrain(
        Math.max(0, Math.min(EXIT_STDERR_DRAIN_MS, deadline - Date.now())),
      );
      return;
    }
    this.cleanupAttemptCount += 1;
    const cleanupStartedAtMs = Date.now();
    const forceBudgetMs = this.cleanupAttemptCount > 1 ? 0 : PROCESS_TREE_FORCE_AFTER_MS;
    if (process.platform === "win32")
      throw new Error("Windows CLI cleanup requires a runtime Job owner");
    this.cleanupProcessTreeSnapshot ??= await this.captureCleanupSnapshot();
    const processTreeSnapshot = this.cleanupProcessTreeSnapshot;
    if (!this.hasChildExited()) {
      // app-server --stdio 的正常退出边界是 stdin EOF。直接 taskkill
      // 进程树，既跳过 agent 自身 shutdown，也会让 host 固定等强杀兜底窗口。
      // 这里先请求协议入口自然收尾；短时间无响应再进入进程树兜底，仍保证不残留子进程。
      this.requestStdioClose();
      // POSIX coverage CLI bundle 带完整 source map，启动/收尾慢于发布包，保留写盘宽限。
      const configuredEofWaitMs =
        process.env.ZCODE_E2E_COVERAGE === "1"
          ? E2E_COVERAGE_STDIO_EOF_EXIT_WAIT_MS
          : STDIO_EOF_EXIT_WAIT_MS;
      await this.waitForChildExit(configuredEofWaitMs);
    }
    // app 关闭时 host 必须等进程树的 SIGTERM/SIGKILL 兜底跑完；
    // 即使根 child 已在 EOF 窗口内退出，也要用预先保存的快照回收后代。
    const terminationResult = await terminateProcessTreeAndWait(this.child, {
      ...(this.options?.ownedProcessGroupId
        ? { ownedProcessGroupId: this.options.ownedProcessGroupId }
        : {}),
      ...(this.options?.ownedProcessStartedAtMs
        ? {
            ownedProcessStartedAtMs: this.options.ownedProcessStartedAtMs,
            ownedProcessExitedAtMs: this.childExitedAtMs ?? Date.now(),
          }
        : {}),
      ...(processTreeSnapshot ? { snapshot: processTreeSnapshot } : {}),
      log: processTreeLogger,
      // 前一次 cleanup 若报告残留，app quit 的最终重试不能再等待完整
      // graceful 窗口；直接进入 force，确保仍落在 main 给 Host 的退出预算内。
      forceAfterMs: Math.max(forceBudgetMs - (Date.now() - cleanupStartedAtMs), 0),
    });
    const remainingPids = terminationResult.remainingPids;
    await this.stderrCollector.waitForDrain();
    if (remainingPids.length > 0) {
      processTreeLogger.warn("runtime process tree cleanup incomplete", {
        pid: this.child.pid,
        durationMs: Date.now() - cleanupStartedAtMs,
        remainingPids,
      });
      // 只写 warning 后把 cleanup 当成功会让 manager 随即释放 ownership，
      // app quit 无法再次处理残留。这里把残留提升为失败并保留快照供最终重试。
      throw new Error(
        `runtime process tree cleanup incomplete; remaining pid=${[...new Set(remainingPids)].join(",")}`,
      );
    }
  }

  private readonly handleStdoutData = (chunk: Buffer | string): void => {
    if (this.closed) {
      return;
    }
    // Bug 原因：旧实现 `stdoutBuffer += chunk` 后对整个缓冲 indexOf("\n")，每个 64KB
    // chunk 都会让 V8 把 cons string 拍平并从头扫描，单行帧长度 n 时总开销 O(n²)。
    // task index resync 的 session/read 会回一行约 15MB 的完整快照，实测 30s 内
    // 真实 stdout 95MB 却拍平分配 9.4GB，Host CPU 100%、RSS 冲到 1.5–1.9GB。
    // 修复：只在新 chunk 内找 LF，未完成的部分存分片数组，成帧时 join 一次，线性开销。
    const text = typeof chunk === "string" ? chunk : this.stdoutDecoder.write(chunk);
    this.consumeStdoutText(text);
  };

  private readonly handleStdoutEnd = (): void => {
    if (this.stdoutFlushed) {
      return;
    }
    this.stdoutFlushed = true;
    this.stdoutPendingChunks.push(this.stdoutDecoder.end());
    const trailing = this.stdoutPendingChunks.join("");
    this.stdoutPendingChunks = [];
    if (trailing.length > 0 && !this.closed) {
      this.handleStdoutFrame(trailing);
    }
    this.fireClose({ reason: "stdout_closed" });
  };

  private consumeStdoutText(text: string): void {
    let start = 0;
    let newlineIndex = text.indexOf("\n", start);
    while (newlineIndex >= 0) {
      this.stdoutPendingChunks.push(text.slice(start, newlineIndex));
      const frame = this.stdoutPendingChunks.join("");
      this.stdoutPendingChunks = [];
      start = newlineIndex + 1;
      this.handleStdoutFrame(frame);
      if (this.closed) {
        return;
      }
      newlineIndex = text.indexOf("\n", start);
    }
    if (start < text.length) {
      this.stdoutPendingChunks.push(text.slice(start));
    }
  }

  private handleStdoutFrame(frame: string): void {
    const line = frame.endsWith("\r") ? frame.slice(0, -1) : frame;
    if (line.trim().length === 0) {
      return;
    }
    try {
      const parsed = zcodeProtocolMessageSchema.parse(JSON.parse(line));
      // 协议帧分发曾同步查询系统进程表，telemetry/streaming 高峰会阻塞
      // Host event loop 并让 subagent 面板无输出。运行期 data plane 只做解析和转发；
      // 完整进程树查询严格留在 dispose cleanup 边界。
      this.messageEmitter.fire(parsed);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.fireClose({ reason: `protocol_parse_error: ${reason}` });
    }
  }

  private handleStreamError(stream: "stdin" | "stdout", error: Error): void {
    // 远端 WSL/SSH agent 秒退后，host 仍可能正在写入尚未完成的协议请求。
    // Node 的 stdin write 回调会 reject，但底层 Socket 还会额外触发 error 事件；若没有长期监听，
    // zcode-server 会因未处理的 EPIPE 直接崩溃，UI 只能看到远端连接断开而不是协议请求失败。
    // 这里把 stream error 视为 transport 已关闭，阻止后续继续向失效 agent 写入。
    this.fireClose({ reason: `${stream}_error: ${error.message}` });
  }

  private fireClose(event: ZCodeProtocolTransportClosedEvent): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closeEmitter.fire(event);
  }

  private disposeReaders(): void {
    if (this.readersDisposed) {
      return;
    }
    this.readersDisposed = true;
    this.child.stdout.off("data", this.handleStdoutData);
    this.child.stdout.off("end", this.handleStdoutEnd);
    this.child.stdout.off("close", this.handleStdoutEnd);
    this.child.stdout.resume();
  }

  private disposeLocalResources(): void {
    this.disposeReaders();
    this.messageEmitter.dispose();
    this.closeEmitter.dispose();
  }

  private requestStdioClose(): void {
    if (this.child.stdin.destroyed || !this.child.stdin.writable) {
      return;
    }
    try {
      this.child.stdin.once("error", () => undefined);
      this.child.stdin.end();
    } catch {
      // agent 可能正好在 disposeAndWait 期间退出，stdin 已半关闭时 EOF 请求失败；
      // 失败不应打断后续进程树兜底，否则关闭路径又可能留下 runtime 残留。
    }
  }

  private waitForChildExit(timeoutMs: number): Promise<void> {
    if (this.hasChildExited()) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = () => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        this.child.off?.("exit", settle);
        resolve();
      };
      this.child.once("exit", settle);
      timer = setTimeout(settle, timeoutMs);
      timer.unref?.();
    });
  }

  private hasChildExited(): boolean {
    return this.child.exitCode !== null || this.child.signalCode !== null;
  }

  private async captureCleanupSnapshot(): Promise<ProcessTreeSnapshot | undefined> {
    if (!this.hasChildExited()) {
      const liveTree = await captureProcessTreeSnapshotAsync(this.child, {
        log: processTreeLogger,
      });
      if (liveTree) return liveTree;
    }
    const processGroupId = this.options?.ownedProcessGroupId;
    if (processGroupId) return captureProcessGroupSnapshot(processGroupId);
    return await captureExitedRootDescendantsSnapshotAsync(this.child.pid ?? 0, {
      log: processTreeLogger,
      ownedProcessStartedAtMs: this.options?.ownedProcessStartedAtMs,
      ownedProcessExitedAtMs: this.childExitedAtMs ?? Date.now(),
    });
  }
}
