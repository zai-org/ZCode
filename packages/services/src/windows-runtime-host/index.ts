import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import type {
  WindowsRuntimeHost,
  WindowsRuntimeHostSpawnOptions,
} from "#src/windows-runtime-host/contract.js";

export type { WindowsRuntimeHost } from "#src/windows-runtime-host/contract.js";

async function resolveHelper(): Promise<string> {
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = process.env.ZCODE_RUNTIME_HOST_PATH
    ? [process.env.ZCODE_RUNTIME_HOST_PATH]
    : [
        ...(resources ? [join(resources, "tools/runtime-host/zcode-runtime-host.exe")] : []),
        ...(process.env.ZCODE_SERVER_RUNTIME_ROOT
          ? [
              join(
                process.env.ZCODE_SERVER_RUNTIME_ROOT,
                "tools/runtime-host/zcode-runtime-host.exe",
              ),
            ]
          : []),
        join(
          process.cwd(),
          "bundled-tools",
          `win32-${process.arch}`,
          "runtime-host/zcode-runtime-host.exe",
        ),
        join(
          process.cwd(),
          "packages/desktop/bundled-tools",
          `win32-${process.arch}`,
          "runtime-host/zcode-runtime-host.exe",
        ),
        join(
          process.cwd(),
          "../desktop/bundled-tools",
          `win32-${process.arch}`,
          "runtime-host/zcode-runtime-host.exe",
        ),
      ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      /* 继续查找明确的部署位置。 */
    }
  }
  throw new Error(
    "Windows runtime host is missing. Prepare the runtime assets before starting CLI.",
  );
}

function until<T>(promise: Promise<T>, deadlineAtMs: number, stage: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Windows runtime ${stage} timed out`)),
      Math.max(0, deadlineAtMs - Date.now()),
    );
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

export async function spawnWindowsRuntimeHost(
  options: WindowsRuntimeHostSpawnOptions,
): Promise<WindowsRuntimeHost> {
  const helper = await resolveHelper();
  options.signal.throwIfAborted();
  const jobName = `Local\\zcode-runtime-${randomUUID()}`;
  const pipeName = `\\\\.\\pipe\\zcode-runtime-${randomUUID()}`;
  const ready = Promise.withResolvers<number>();
  const started = Promise.withResolvers<void>();
  const empty = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<void>();
  // 这些事实可能早于调用方等待；始终有拒绝监听，避免启动取消产生未处理拒绝。
  for (const promise of [ready.promise, started.promise, empty.promise])
    void promise.catch(() => undefined);
  let runtimePid: number | undefined;
  let socket: Socket | undefined;
  let isEmpty = false;
  let rootExit: number | null | undefined;
  let startedConfirmed = false;
  let closeSent = false;
  let startSent = false;
  const listeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  const publishExit = (code: number | null) => {
    if (rootExit !== undefined) return;
    rootExit = code;
    for (const listener of listeners) listener(code, null);
  };
  const fail = (error: Error) => {
    ready.reject(error);
    started.reject(error);
    if (!isEmpty) empty.reject(error);
  };
  const server = createServer((connection) => {
    if (socket) {
      connection.destroy();
      return;
    }
    socket = connection;
    server.close();
    connection.setEncoding("utf8");
    let pending = "";
    connection.on("data", (chunk: string) => {
      pending += chunk;
      if (pending.length > 4096) {
        fail(new Error("Invalid runtime control frame"));
        connection.destroy();
        return;
      }
      let newline: number;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        const readyMatch = /^ready ([1-9][0-9]*)$/.exec(line);
        const rootMatch = /^root ([0-9]+)$/.exec(line);
        if (readyMatch && !startSent && !closeSent) {
          runtimePid = Number(readyMatch[1]);
          ready.resolve(runtimePid);
        } else if (line === "started" && startSent && !startedConfirmed) {
          startedConfirmed = true;
          started.resolve();
        } else if (rootMatch && rootExit === undefined) publishExit(Number(rootMatch[1]));
        else if (line === "empty" && rootExit !== undefined) {
          isEmpty = true;
          empty.resolve();
        } else {
          fail(new Error(`Invalid runtime control event: ${line}`));
          connection.destroy();
        }
      }
    });
    connection.on("error", () => undefined);
    connection.once("close", () => {
      if (!isEmpty)
        fail(new Error("Windows runtime control closed before Job was confirmed empty"));
      publishExit(null);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipeName, resolve);
  });
  server.on("error", fail);
  if (options.signal.aborted) {
    server.close();
    options.signal.throwIfAborted();
  }
  const child = spawn(
    helper,
    [pipeName, String(process.pid), jobName, options.command, ...options.args],
    {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  const abort = () => {
    fail(new Error("Windows runtime start was cancelled"));
    socket?.destroy();
    server.close();
    // 创建属性将 CLI 与 Job 一起建立；helper 被终止时不会留下未归组的 suspended CLI。
    child.kill();
  };
  options.signal.addEventListener("abort", abort, { once: true });
  child.once("error", (error) => {
    fail(error);
    server.close();
    socket?.destroy();
  });
  child.once("exit", () => {
    exited.resolve();
    server.close();
    // exit 与控制管道最后的 data 属于不同事件队列；等控制 EOF 后再判定缺少 empty。
    if (!socket) fail(new Error("Windows runtime host exited before control handshake"));
  });
  child.once("close", () => {
    exited.resolve();
    if (child.pid === undefined) {
      isEmpty = true;
      empty.resolve();
    }
    if (!socket) publishExit(null);
    options.signal.removeEventListener("abort", abort);
  });
  if (options.signal.aborted) abort();
  const startupDeadline = Date.now() + 10_000;
  return {
    child,
    get runtimePid() {
      return runtimePid;
    },
    ready() {
      return until(ready.promise, startupDeadline, "startup");
    },
    onRootExit(listener) {
      listeners.push(listener);
      if (rootExit !== undefined) listener(rootExit, null);
    },
    async start() {
      await until(ready.promise, startupDeadline, "startup");
      options.signal.throwIfAborted();
      if (closeSent || isEmpty) throw new Error("Windows runtime is closing");
      if (!startSent) {
        startSent = true;
        socket!.write("start\n");
      }
      await until(started.promise, Date.now() + 10_000, "resume");
      options.signal.removeEventListener("abort", abort);
    },
    async close(deadlineAtMs) {
      // 原生 owner 只记录第一次 close；超时后的重试只观察，不重新分配正常收尾时间。
      if (!closeSent && !isEmpty && rootExit === undefined) {
        closeSent = true;
        child.stdin.once("error", () => undefined);
        child.stdin.end();
        if (socket) socket.write("close\n");
        else abort();
      }
      if (!isEmpty) {
        try {
          await until(empty.promise, deadlineAtMs, "Job cleanup");
        } catch (error) {
          // helper 异常退出可能没有投递 empty；不能永久缓存旧失败，也不能按根 PID 猜。
          // 先确认旧 helper 退出，再通过唯一内核 Job 名做只读核验；失败保留归属供下次主动请求。
          await until(exited.promise, deadlineAtMs, "host exit");
          const remaining = deadlineAtMs - Date.now();
          if (remaining <= 0) throw error;
          await new Promise<void>((resolveProbe, rejectProbe) => {
            execFile(
              helper,
              ["--check-empty", jobName],
              { timeout: remaining, windowsHide: true },
              (probeError) => (probeError ? rejectProbe(probeError) : resolveProbe()),
            );
          });
          isEmpty = true;
        }
      }
      await until(exited.promise, deadlineAtMs, "host exit");
      socket?.destroy();
    },
  };
}
