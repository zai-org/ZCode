import { ipcMain, utilityProcess, type BrowserWindow, type UtilityProcess } from "electron";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { PlatformChannels } from "@zcode/shared";
import {
  preinstalledToolsToMainSchema,
  preinstalledToolsCommandSchema,
  type PreinstalledToolsCommand,
  type MainToPreinstalledToolsMessage,
  type PreinstalledToolsState,
} from "@zcode/shared/preinstalled-tools";
import { buildHostProcessEnv } from "@desktop/main/desktopRuntimeEnv.js";
import { isMainApplicationWindowWebContents } from "@desktop/main/resourceManagerWindow.js";
import type { PreinstalledToolsProcessHandle } from "@desktop/preinstalled-tools/contract.js";

export function spawnPreinstalledToolsProcess(options: {
  hostProcessLocalEnv: Record<string, string>;
  configuration: Promise<
    Omit<Extract<MainToPreinstalledToolsMessage, { type: "initialize" }>, "type" | "autoPrepare">
  >;
  windows: () => BrowserWindow[];
  logger: {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
  };
}): PreinstalledToolsProcessHandle {
  let child: UtilityProcess | undefined;
  let disposing = false;
  let childInitialized = false;
  let disposal: Promise<void> | undefined;
  let resolveInitialized!: () => void;
  const initialized = new Promise<void>((resolve) => {
    resolveInitialized = resolve;
  });
  const requests = new Map<
    string,
    {
      resolve: (state: PreinstalledToolsState) => void;
      reject: (error: Error) => void;
      message: Extract<MainToPreinstalledToolsMessage, { requestId: string }>;
    }
  >();
  const post = (message: MainToPreinstalledToolsMessage) => {
    if (!child) throw new Error("预装工具进程尚未启动");
    child.postMessage(message);
  };
  const fork = (autoPrepare: boolean, configuration: Awaited<typeof options.configuration>) => {
    const current = utilityProcess.fork(
      join(import.meta.dirname, "../preinstalled-tools/process.js"),
      [],
      {
        serviceName: "zcode-preinstalled-tools",
        execArgv: ["--no-warnings"],
        env: {
          ...buildHostProcessEnv(options.hostProcessLocalEnv),
          ZCODE_PROCESS_LABEL: "preinstalled-tools",
        },
      },
    );
    child = current;
    childInitialized = false;
    current.once("spawn", () => {
      options.logger.info(`[preinstalled-tools] forked pid=${current.pid}`);
      current.postMessage({
        type: "initialize",
        ...configuration,
        autoPrepare,
      } satisfies MainToPreinstalledToolsMessage);
    });
    current.on("message", (raw: unknown) => {
      if (child !== current || disposing) return;
      const parsed = preinstalledToolsToMainSchema.safeParse(raw);
      if (!parsed.success) {
        options.logger.warn("[preinstalled-tools] invalid child message");
        return;
      }
      const message = parsed.data;
      if (message.type === "initialized") {
        childInitialized = true;
        resolveInitialized();
        for (const request of requests.values()) current.postMessage(request.message);
      } else if (message.type === "log") options.logger[message.level](message.message);
      else if (message.type === "command-error") {
        requests.get(message.requestId)?.reject(new Error("预装工具操作失败"));
        requests.delete(message.requestId);
      } else if (message.requestId) {
        requests.get(message.requestId)?.resolve(message.state);
        requests.delete(message.requestId);
      } else {
        for (const win of options.windows()) {
          if (!win.isDestroyed())
            win.webContents.send(PlatformChannels.PreinstalledToolsState, message.state);
        }
      }
    });
    current.once("exit", (code) => {
      options.logger.info(`[preinstalled-tools] exited pid=${current.pid} code=${code}`);
      if (child !== current) return;
      for (const request of requests.values()) request.reject(new Error("预装工具进程已退出"));
      requests.clear();
      if (disposing) return;
      // 修复原因：子进程在报告 initialized 前退出，说明启动本身失败（如模块加载失败）。此前无条件
      // 立即重拉，形成无上限的 fork 循环，查询也一直等 initialized 而挂起。目录与设置故障已在进程内
      // 表现为可重试失败，不会走到这里；所以停止重拉，放行等待中的查询，由 request 以错误结束。
      if (!childInitialized) {
        child = undefined;
        options.logger.error("[preinstalled-tools] exited before initialization; restart stopped");
        resolveInitialized();
        return;
      }
      // 新进程恢复磁盘事实，但自动准备只属于真正的 App 启动，避免故障循环重复下载。
      fork(false, configuration);
    });
  };
  const request = async (command?: PreinstalledToolsCommand) => {
    await initialized;
    if (disposing) throw new Error("App 正在退出");
    if (!child) throw new Error("预装工具进程不可用");
    return new Promise<PreinstalledToolsState>((resolve, reject) => {
      const requestId = randomUUID();
      const message: Extract<MainToPreinstalledToolsMessage, { requestId: string }> = command
        ? { type: "command", requestId, command }
        : { type: "get-state", requestId };
      requests.set(requestId, { resolve, reject, message });
      try {
        if (childInitialized) post(message);
      } catch (error) {
        requests.delete(requestId);
        reject(error);
      }
    });
  };
  const getState = () => request();
  ipcMain.handle(
    PlatformChannels.ExecutePreinstalledToolsCommand,
    async (event, value: unknown) => {
      if (!isMainApplicationWindowWebContents(event.sender.id))
        throw new Error("仅主窗口可操作预装工具");
      await request(preinstalledToolsCommandSchema.parse(value));
    },
  );
  ipcMain.handle(PlatformChannels.GetPreinstalledToolsState, (event) => {
    if (!isMainApplicationWindowWebContents(event.sender.id))
      throw new Error("仅主窗口可访问预装工具");
    return getState();
  });
  void options.configuration
    .then((configuration) => {
      if (!disposing) fork(true, configuration);
    })
    .catch((error) => {
      options.logger.error("[preinstalled-tools] process start failed", error);
      // 同一原因：没有子进程会发 initialized，放行等待中的查询。
      resolveInitialized();
    });
  return {
    getState,
    dispose() {
      if (disposal) return disposal;
      disposing = true;
      // 清单读取或子进程初始化尚未结束时，等待中的查询也必须随退出结束。
      resolveInitialized();
      ipcMain.removeHandler(PlatformChannels.GetPreinstalledToolsState);
      ipcMain.removeHandler(PlatformChannels.ExecutePreinstalledToolsCommand);
      disposal = new Promise<void>((resolve) => {
        const current = child;
        if (!current) {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          current.kill();
          resolve();
        }, 1500);
        current.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        try {
          current.postMessage({ type: "dispose" } satisfies MainToPreinstalledToolsMessage);
        } catch {
          current.kill();
        }
      });
      return disposal;
    },
  };
}
