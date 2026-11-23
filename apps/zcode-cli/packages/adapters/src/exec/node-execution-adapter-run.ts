import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { BashFileOutput } from "./bash-file-output.js";
import { readCapturedCwd } from "./cwd-capture.js";
import { defaultCwdDialect } from "./execution-command.js";
import { NodeExecutionAdapterProcess } from "./node-execution-adapter-process.js";
import { resolveLegacyExecutionOutputEncoding } from "./outputEncoding.js";
import {
  DEFAULT_TIMEOUT_MS,
  FORCE_EXIT_AFTER_KILL_MS,
  abortSignalReason,
  isBashMergedOutputRequest,
  isExpectedChildStdinClosureError,
  resolveDefaultOutputRootDir,
} from "./execution-utils.js";
import type {
  ExitState,
  InternalExecutionRunOptions,
  PreparedBashOutput,
  StopReason,
} from "./execution-adapter-types.js";
import type {
  ExecutionRequest,
  ExecutionResult,
  ExecutionRunOptions,
  ExecutionShellDialect,
} from "@zcode/contracts";

const BASH_TEMP_DIRECTORY_PREFIX = "zcode-bash-";
const BASH_TEMP_UNAVAILABLE_CODES = new Set([
  "EACCES",
  "EPERM",
  "EROFS",
  "ENOENT",
  "ENOTDIR",
  "ENOSPC",
  "EDQUOT",
]);

export class NodeExecutionAdapterRun extends NodeExecutionAdapterProcess {
  private bashTempRoot?: Promise<string>;

  protected usesBashTempOutput(request: ExecutionRequest): boolean {
    return this.options.bashOutputTempDir !== undefined && isBashMergedOutputRequest(request);
  }

  private getBashTempRoot(): Promise<string> {
    if (!this.bashTempRoot) {
      const pending = mkdtemp(join(this.options.bashOutputTempDir!, BASH_TEMP_DIRECTORY_PREFIX));
      this.bashTempRoot = pending;
      void pending.catch(() => {
        if (this.bashTempRoot === pending) this.bashTempRoot = undefined;
      });
    }
    return this.bashTempRoot;
  }

  protected async prepareBashOutput(
    request: ExecutionRequest,
    options: ExecutionRunOptions,
  ): Promise<{ prepared: PreparedBashOutput } | { result: ExecutionResult }> {
    const startedAt = new Date();
    let stopped = false;
    const executionId = this.registerActiveExecution(() => {
      stopped = true;
    });
    const releasePreparation = () => this.completeActiveExecution(executionId);
    const isStopped = () => stopped || this.closePromise !== undefined || options.signal?.aborted;
    let file: BashFileOutput | undefined;
    const cancelled = async () => {
      await file?.discard();
      releasePreparation();
      return {
        result: this.createStoppedResult(
          startedAt,
          "cancelled",
          "Execution cancelled before spawn",
        ),
      };
    };
    try {
      if (isStopped()) return await cancelled();
      const legacyOutputEncoding = resolveLegacyExecutionOutputEncoding({
        platform: this.platform,
        processEnv: this.processEnv,
      });
      const knownPath = this.outputPathForRequest(request, "stdout")!;
      // 请求可能被复用；缓存保存的是实际路径，降级根必须始终来自原有配置。
      const fallbackPath = join(
        this.options.outputRootDir ?? resolveDefaultOutputRootDir(this.options.processEnv),
        basename(dirname(knownPath)),
        basename(knownPath),
      );
      try {
        const root = await this.getBashTempRoot();
        if (isStopped()) return await cancelled();
        const path = join(root, basename(dirname(fallbackPath)), basename(fallbackPath));
        file = new BashFileOutput(path, this.platform, legacyOutputEncoding);
        await file.prepare();
      } catch (error) {
        if (isStopped()) return await cancelled();
        if (!BASH_TEMP_UNAVAILABLE_CODES.has((error as NodeJS.ErrnoException).code ?? ""))
          throw error;
        await file?.discard();
        // 搜索数据目录会把正在写入的输出再次读回；优先隔离到 tmp，失败后完整复用旧文件实现。
        file = new BashFileOutput(fallbackPath, this.platform, legacyOutputEncoding);
        await file.prepare();
      }
      if (isStopped()) return await cancelled();
      // 路径必须在后台记录和文件入口发布之前确定，不能在 spawn 后再降级或重新打开。
      this.outputPathsByRequest.set(request, {
        outputPath: file.path,
        stdoutPersistedOutputPath: file.path,
      });
      return { prepared: { file, legacyOutputEncoding, releasePreparation } };
    } catch (error) {
      await file?.discard();
      releasePreparation();
      if (isStopped()) return await cancelled();
      return {
        result: this.createStoppedResult(
          startedAt,
          "spawn_error",
          this.toFailure("spawn_error", error).message,
        ),
      };
    }
  }

  async run(
    request: ExecutionRequest,
    options: ExecutionRunOptions = {},
  ): Promise<ExecutionResult> {
    const startedAt = new Date();
    const useBashMergedOutput = isBashMergedOutputRequest(request);
    let requestStop: (reason: StopReason) => void = () => undefined;
    let outputLimitExceeded = false;
    const internalOptions = options as InternalExecutionRunOptions;
    let preparedOutput = internalOptions.preparedBashOutput;
    if (!preparedOutput && this.usesBashTempOutput(request)) {
      const preparation = await this.prepareBashOutput(request, options);
      if ("result" in preparation) {
        this.emitResult(options, preparation.result);
        return preparation.result;
      }
      preparedOutput = preparation.prepared;
    }
    const aggregatePersistedBudget = internalOptions.sharePersistedOutputLimitAcrossStreams
      ? {
          bytes: 0,
          maxBytes: Math.max(0, this.persistedOutputLimit(request)),
        }
      : undefined;

    if (this.closePromise) {
      await preparedOutput?.file.discard();
      preparedOutput?.releasePreparation();
      return this.createStoppedResult(startedAt, "cancelled", "Execution adapter is shutting down");
    }

    if (options.signal?.aborted) {
      await preparedOutput?.file.discard();
      preparedOutput?.releasePreparation();
      return this.createStoppedResult(startedAt, "cancelled", "Execution cancelled before spawn");
    }

    let persistedLimitNotified = false;
    const onPersistedLimit =
      request.outputLimit?.killProcessOnPersistedLimit === true ||
      internalOptions.onPersistedLimit ||
      internalOptions.shouldStopOnPersistedLimit
        ? () => {
            if (persistedLimitNotified) return;
            persistedLimitNotified = true;
            internalOptions.onPersistedLimit?.();
            if (
              request.outputLimit?.killProcessOnPersistedLimit === true ||
              internalOptions.shouldStopOnPersistedLimit?.() === true
            ) {
              requestStop("output_limit");
            }
          }
        : undefined;
    const legacyOutputEncoding = preparedOutput
      ? preparedOutput.legacyOutputEncoding
      : resolveLegacyExecutionOutputEncoding({
          platform: this.platform,
          processEnv: this.processEnv,
        });
    // 任务记录单独解析会重复同步执行 Windows chcp；复用执行时的编码值。
    internalOptions.onOutputEncodingResolved?.(legacyOutputEncoding);
    const file =
      preparedOutput?.file ??
      (useBashMergedOutput
        ? new BashFileOutput(
            this.outputPathForRequest(request, "stdout")!,
            this.platform,
            legacyOutputEncoding,
          )
        : undefined);
    const stdout = file
      ? undefined
      : this.createOutputCollector(
          request,
          "stdout",
          legacyOutputEncoding,
          onPersistedLimit,
          aggregatePersistedBudget,
        );
    const stderr = file
      ? undefined
      : this.createOutputCollector(
          request,
          "stderr",
          legacyOutputEncoding,
          onPersistedLimit,
          aggregatePersistedBudget,
        );
    let child: ChildProcess | undefined;
    let cwdDialect: ExecutionShellDialect = defaultCwdDialect(this.platform);
    let cwdFilePath: string | undefined;
    let timedOut = false;
    let cancelled = false;
    let exited = false;
    let childClosed = false;
    let executionSettled = false;
    let childReadyForTermination = false;
    let terminationRequested = false;
    let stopRequested = false;
    let forceExitTimer: NodeJS.Timeout | undefined;
    let progressTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let finishExit: (state: ExitState) => void = () => undefined;
    let finishResourceTelemetry: (state: ExitState) => void = () => undefined;
    // timeout 计时器在 spawn 后才启动（见下），spawn 前的停止只可能来自取消或 adapter 关闭。
    const createPreSpawnStoppedResult = () =>
      this.createStoppedResult(
        startedAt,
        "cancelled",
        this.closePromise
          ? "Execution adapter is shutting down"
          : "Execution cancelled before spawn",
      );
    const stoppedBeforeSpawn = (): ExecutionResult | undefined => {
      if (!stopRequested && !this.closePromise && !options.signal?.aborted) return undefined;
      return createPreSpawnStoppedResult();
    };

    const terminateStartedChild = () => {
      if (!stopRequested || !child || !childReadyForTermination || terminationRequested) {
        return;
      }
      const startedChild = child;
      terminationRequested = true;
      // root shell exit 不代表其进程组和继承 pipe 的后代已经退出。
      // cancel/close 必须在组长 exit 后仍能清理整个 execution，避免 orphan。
      this.terminateProcessTree(startedChild, useBashMergedOutput);
      if (file) {
        finishExit({ code: timedOut ? 143 : 137 });
        return;
      }
      forceExitTimer = setTimeout(() => {
        if (!exited) {
          finishExit({
            signal: "SIGKILL",
          });
        }
        // Windows 的 taskkill 或 POSIX 的 PGID 都可能已无法寻址脱离的后代；
        // 最终释放 ZCode 持有的读端，不能继续让未知进程保活 CLI。
        this.destroyChildOutputStreams(startedChild);
      }, FORCE_EXIT_AFTER_KILL_MS);
      forceExitTimer.unref?.();
    };

    requestStop = (reason: StopReason) => {
      if (executionSettled || stopRequested || (file && exited)) return;
      stopRequested = true;
      if (reason === "timeout") {
        timedOut = true;
      } else if (reason === "cancelled") {
        cancelled = true;
      } else {
        outputLimitExceeded = true;
      }
      terminateStartedChild();
    };

    const executionId = this.registerActiveExecution(requestStop);
    preparedOutput?.releasePreparation();
    const abortHandler = () => {
      const reason = abortSignalReason(options.signal);
      requestStop(reason === "output_limit" ? "output_limit" : "cancelled");
    };
    if (options.signal?.aborted) {
      requestStop("cancelled");
    } else {
      options.signal?.addEventListener("abort", abortHandler, { once: true });
    }

    try {
      const prepared = await this.prepareChildSpawn(request, options.signal);

      // shell init snapshot 创建是异步的；用户可能在等待期间取消或关闭 adapter。

      const stoppedAfterCommandPreparation = stoppedBeforeSpawn();
      if (stoppedAfterCommandPreparation) {
        if (preparedOutput) await file?.discard();
        return stoppedAfterCommandPreparation;
      }

      if (file) {
        if (!preparedOutput) await file.prepare();
        const stoppedAfterOutputPreparation = stoppedBeforeSpawn();
        if (stoppedAfterOutputPreparation) {
          await file.discard();
          return stoppedAfterOutputPreparation;
        }
        prepared.spawnOptions.stdio = [
          request.stdin === undefined ? "ignore" : "pipe",
          file.fd!,
          file.fd!,
        ];
      }

      const spawnedChild = spawn(
        prepared.command.file,
        prepared.command.args,
        prepared.spawnOptions,
      );
      child = spawnedChild;
      finishResourceTelemetry = this.trackBashResources(spawnedChild, useBashMergedOutput, () => ({
        timedOut,
        killed: cancelled || outputLimitExceeded,
      }));
      cwdDialect = prepared.cwdDialect;
      cwdFilePath = prepared.cwdFilePath;

      const exitPromise = new Promise<ExitState>((resolve) => {
        finishExit = (state) => {
          if (exited) return;
          exited = true;
          finishResourceTelemetry(state);
          file?.stopWatching();
          if (file) internalOptions.bashLifecycle?.onExit?.();
          resolve(state);
        };
        spawnedChild.once("error", (error) => finishExit({ error }));
        spawnedChild.once("exit", (code, signal) =>
          finishExit({
            code: code ?? undefined,
            signal: signal ?? undefined,
          }),
        );
      });

      const closePromise = new Promise<void>((resolve) => {
        spawnedChild.once("close", () => {
          childClosed = true;
          resolve();
        });
      });

      await file?.close();
      const watchBashLimit = () => {
        if (!file || exited || stopRequested) return;
        file.watchLimit(this.persistedOutputLimit(request), () => requestStop("output_limit"));
      };
      if (file) {
        watchBashLimit();
        if (internalOptions.bashLifecycle)
          internalOptions.bashLifecycle.onBackgrounded = watchBashLimit;
        if (options.onEvent && !exited && !internalOptions.bashLifecycle?.isBackgrounded()) {
          file.watchProgress(
            this.progressTailBytes,
            this.progressThresholdMs,
            this.progressIntervalMs,
            (output, outputPreview) => {
              this.emit(options, {
                type: "progress",
                elapsedMs: Date.now() - startedAt.getTime(),
                pid: spawnedChild.pid,
                stdoutBytes: output.bytes,
                stderrBytes: 0,
                stdoutTail: output.text,
                outputPreview,
                timestamp: new Date(),
              });
            },
          );
        }
      }
      childReadyForTermination = true;
      terminateStartedChild();

      this.emit(options, { type: "started", pid: spawnedChild.pid, timestamp: startedAt });

      // 复原原因：计时器提前到准备阶段是 protected-resource sandbox 时代的行为——capability
      // probe 可能无限挂起，总超时必须覆盖准备期。sandbox 撤除后准备阶段只剩 shell snapshot /
      // artifact 等既有异步步骤，timeoutMs 恢复为只约束子进程运行，避免 shell 初始化较慢或
      // timeout 较短时命令尚未启动就被判 timed_out；准备期间的取消与关闭仍由 stoppedBeforeSpawn 兜底。
      if (timeoutMs > 0) {
        timeoutTimer = setTimeout(() => requestStop("timeout"), timeoutMs);
      }

      if (stdout && stderr) {
        if (options.onEvent) {
          progressTimer = setInterval(() => {
            if (
              childClosed ||
              (exited && internalOptions.shouldRetainExecutionAfterRootExit?.() !== true)
            )
              return;
            const elapsedMs = Date.now() - startedAt.getTime();
            if (elapsedMs < this.progressThresholdMs) return;
            this.emit(options, {
              type: "progress",
              elapsedMs,
              pid: spawnedChild.pid,
              stdoutBytes: stdout.bytes,
              stderrBytes: stderr.bytes,
              stdoutTail: stdout.tailText(),
              stderrTail: stderr.tailText(),
              timestamp: new Date(),
            });
          }, this.progressIntervalMs);
          progressTimer.unref?.();
        }
        this.attachPipedOutput(spawnedChild, stdout, stderr, legacyOutputEncoding, options);
      }
      const inputFailure = this.writeChildInput(spawnedChild, request.stdin);

      const exitState = await exitPromise;
      if (!file) {
        await this.drainChildOutput(
          spawnedChild,
          closePromise,
          internalOptions,
          terminationRequested,
        );
        await Promise.all([stdout!.close(), stderr!.close()]);
      } else if (exitState.error) {
        await file.discard();
      }
      const stdoutResult = file
        ? await this.readBashResult(file, request, internalOptions, exitState, outputLimitExceeded)
        : stdout!.result();
      const stderrResult = useBashMergedOutput
        ? { text: "", bytes: 0, truncated: false }
        : stderr!.result();
      const completedAt = new Date();
      if (file && outputLimitExceeded) cancelled = true;
      const baseStatus = this.statusFromExit(exitState, timedOut, cancelled, outputLimitExceeded);
      const stdinWriteError = inputFailure();
      const unexpectedStdinFailure =
        baseStatus === "completed" &&
        stdinWriteError &&
        !isExpectedChildStdinClosureError(stdinWriteError)
          ? this.toFailure("unknown", stdinWriteError)
          : undefined;
      const failure = exitState.error
        ? this.toFailure("spawn_error", exitState.error)
        : file && outputLimitExceeded
          ? { type: "output_limit" as const, message: "Command killed: output file exceeded 5GB" }
          : (this.statusFailure(timedOut, cancelled, outputLimitExceeded, timeoutMs) ??
            unexpectedStdinFailure);
      const status = unexpectedStdinFailure ? "failed" : baseStatus;
      const resolvedCwd =
        status === "completed" && exitState.code === 0
          ? readCapturedCwd(cwdFilePath, { dialect: cwdDialect })
          : undefined;
      const result = this.createResult({
        status,
        startedAt,
        completedAt,
        pid: spawnedChild.pid,
        exitCode: exitState.code,
        signal: exitState.signal,
        stdout: stdoutResult,
        stderr: stderrResult,
        timedOut,
        cancelled,
        error: failure,
        resolvedCwd,
      });

      this.emitResult(options, result);
      return result;
    } catch (error) {
      if (!child) await file?.discard();
      if (stopRequested || this.closePromise || options.signal?.aborted) {
        return createPreSpawnStoppedResult();
      }
      const failure = this.toFailure("spawn_error", error);
      const result = this.createResult({
        status: "spawn_error",
        startedAt,
        completedAt: new Date(),
        stdout: file ? await file.result(this.bashInlineLimit(request)) : stdout!.result(),
        stderr: useBashMergedOutput ? { text: "", bytes: 0, truncated: false } : stderr!.result(),
        timedOut: false,
        cancelled: false,
        error: failure,
      });
      this.emitResult(options, result);
      return result;
    } finally {
      if (!exited)
        finishResourceTelemetry({ error: new Error("Execution ended before child exit") });
      executionSettled = true;
      file?.stopWatching();
      if (internalOptions.bashLifecycle) internalOptions.bashLifecycle.onBackgrounded = undefined;
      await file?.close();
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (progressTimer) clearInterval(progressTimer);
      if (forceExitTimer) clearTimeout(forceExitTimer);
      options.signal?.removeEventListener("abort", abortHandler);
      this.completeActiveExecution(executionId);
    }
  }
}
