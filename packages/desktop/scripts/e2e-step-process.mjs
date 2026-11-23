import { spawn } from "node:child_process";
import process from "node:process";
import {
  quoteArgsForWindowsShell,
  resolveSpawnRuntimeOptions,
} from "../../../scripts/spawn-command.mjs";

function formatStepError(error) {
  return error instanceof Error ? error.message : String(error);
}

function createStepStartFailure(error) {
  return { exitCode: 1, error: formatStepError(error) };
}

function normalizeStepExecution(value) {
  if (value && typeof value === "object" && "result" in value) {
    return {
      result: Promise.resolve(value.result),
      terminate: typeof value.terminate === "function" ? () => value.terminate() : undefined,
    };
  }
  return { result: Promise.resolve(value), terminate: undefined };
}

function normalizeStepResult(result) {
  if (!result || typeof result !== "object") {
    return createStepStartFailure(new Error("step returned no result"));
  }
  return {
    exitCode: Number.isInteger(result.exitCode) ? result.exitCode : 1,
    ...(result.signal ? { signal: String(result.signal) } : {}),
    ...(result.error ? { error: String(result.error) } : {}),
  };
}

export function startStepExecution(runStep, step) {
  let execution;
  try {
    execution = normalizeStepExecution(runStep(step));
  } catch (error) {
    execution = normalizeStepExecution(createStepStartFailure(error));
  }
  return {
    result: execution.result.then(normalizeStepResult, (error) => createStepStartFailure(error)),
    terminate: execution.terminate,
  };
}

export function spawnCancellableStep(step) {
  if (step.timeoutMs !== undefined && (!Number.isFinite(step.timeoutMs) || step.timeoutMs <= 0)) {
    return {
      result: Promise.resolve(createStepStartFailure(new Error("Invalid step timeout"))),
      terminate() {},
    };
  }
  let child;
  try {
    const runtimeOptions = resolveSpawnRuntimeOptions(step.command);
    child = spawn(
      step.command,
      runtimeOptions.shell ? quoteArgsForWindowsShell(step.args) : step.args,
      {
        cwd: step.cwd,
        env: step.env,
        stdio: "inherit",
        // 编译器可能派生后代；POSIX 用独立进程组，Windows 沿用下方 taskkill /T。
        detached: step.killProcessTree === true && process.platform !== "win32",
        ...runtimeOptions,
      },
    );
  } catch (error) {
    return {
      result: Promise.resolve(createStepStartFailure(error)),
      terminate() {},
    };
  }

  let forceKillTimer;
  let timeoutTimer;
  let timedOut = false;
  let terminationRequested = false;
  const result = new Promise((resolveRun) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      resolveRun(value);
    };

    // 修复原因：spawn 的 error 过去会 reject Promise.all，导致其他 shard 未等待、manifest 未写入。
    child.once("error", (error) => settle(createStepStartFailure(error)));
    child.once("close", (code, signal) => {
      settle({
        exitCode: timedOut ? 1 : (code ?? 1),
        signal: signal ?? undefined,
        ...(timedOut ? { error: `step timed out after ${step.timeoutMs}ms` } : {}),
      });
    });
  });

  const execution = {
    result,
    terminate() {
      if (
        terminationRequested ||
        !child.pid ||
        (!step.killProcessTree && (child.exitCode !== null || child.signalCode !== null))
      ) {
        return;
      }
      terminationRequested = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);

      if (process.platform === "win32") {
        // pnpm 下还有 WDIO/Electron 等后代进程，Windows 必须按进程树强制终止。
        const killChildFallback = () => {
          try {
            child.kill();
          } catch {
            // 原进程可能已在 taskkill 启动失败前退出。
          }
        };
        let taskkill;
        try {
          taskkill = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          });
        } catch {
          killChildFallback();
          return;
        }
        taskkill.once("error", killChildFallback);
        taskkill.once("close", (code) => {
          if (code !== 0 && child.exitCode === null && child.signalCode === null) {
            killChildFallback();
          }
        });
        return;
      }

      try {
        const kill = (signal) =>
          step.killProcessTree ? process.kill(-child.pid, signal) : child.kill(signal);
        const signal = step.killSignal ?? "SIGTERM";
        kill(signal);
        if (signal !== "SIGKILL")
          forceKillTimer = setTimeout(() => {
            try {
              kill("SIGKILL");
            } catch {
              // SIGTERM 后已经退出时无需继续处理。
            }
          }, 5_000);
        forceKillTimer?.unref?.();
      } catch {
        // close/error 会负责产生最终结果，终止请求本身不应绕过收口。
      }
    },
  };
  if (step.timeoutMs !== undefined) {
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      execution.terminate();
    }, step.timeoutMs);
  }
  return execution;
}
