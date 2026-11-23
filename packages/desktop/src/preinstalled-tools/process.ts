import { dirname } from "node:path";
import {
  mainToPreinstalledToolsSchema,
  type MainToPreinstalledToolsMessage,
  type PreinstalledToolsToMainMessage,
} from "@zcode/shared/preinstalled-tools";
import {
  createSettingService,
  createHostApiNetworkTransport,
  createServiceLogger,
  setDataBaseDir,
} from "@zcode/services/node";
import { PreinstalledToolsCoordinator } from "@desktop/preinstalled-tools/coordinator.js";

declare const __ZCODE_PREINSTALL_TEST_BUILD__: boolean;

const parent = process.parentPort;
if (!parent) throw new Error("预装工具进程需要父进程通信端口");
// 仅 E2E 构建：模拟安装包损坏导致的初始化前退出（PT-30/31）；生产构建整段移除。
if (
  __ZCODE_PREINSTALL_TEST_BUILD__ &&
  process.env.ZCODE_E2E_PREINSTALLED_TOOLS_EXIT_BEFORE_INIT === "1"
)
  process.exit(1);
const post = (message: PreinstalledToolsToMainMessage) => parent.postMessage(message);
const log = createServiceLogger("preinstalled-tools", {
  sink: {
    log: (...args) =>
      post({
        type: "log",
        level: "info",
        message: args
          .map((arg) => (typeof arg === "object" ? JSON.stringify(arg) : String(arg)))
          .join(" "),
      }),
    warn: (...args) =>
      post({
        type: "log",
        level: "warn",
        message: args
          .map((arg) => (typeof arg === "object" ? JSON.stringify(arg) : String(arg)))
          .join(" "),
      }),
    error: (...args) =>
      post({
        type: "log",
        level: "error",
        message: args
          .map((arg) => (typeof arg === "object" ? JSON.stringify(arg) : String(arg)))
          .join(" "),
      }),
  },
});
let installation: PreinstalledToolsCoordinator | undefined;
let startup: Promise<void> | undefined;
let closing = false;

async function initialize(
  message: Extract<MainToPreinstalledToolsMessage, { type: "initialize" }>,
): Promise<void> {
  setDataBaseDir(dirname(message.dataRoot));
  const settings = createSettingService();
  installation = new PreinstalledToolsCoordinator({
    dataRoot: message.dataRoot,
    release: message.release,
    tools: message.tools,
    appStartup: message.autoPrepare,
    windowsEntryShim: message.windowsEntryShim,
    readAutoInstall: async () => (await settings.get()).preinstalledToolsAutoInstall ?? true,
    persistAutoInstall: (enabled) => settings.update({ preinstalledToolsAutoInstall: enabled }),
    readAgentDisabled: async () => (await settings.get()).preinstalledToolsAgentDisabled ?? [],
    persistAgentDisabled: (toolIds) => settings.update({ preinstalledToolsAgentDisabled: toolIds }),
    // 常驻实例会缓存代理与 CA；每次准备重新装配，重试才能读取用户刚保存的设置。
    createNetwork: () =>
      createHostApiNetworkTransport(async () => {
        const current = await settings.get();
        return {
          httpProxy: current.httpProxy,
          noProxy: current.httpProxyNoProxy,
          caCertPath: current.httpProxyCaCertPath,
        };
      }),
    publish: (state) => post({ type: "state", state }),
    log,
  });
  const readyToPrepare = await installation.initialize();
  post({ type: "initialized" });
  log.info(undefined, "初始化完成", {
    pid: process.pid,
    autoPrepare: message.autoPrepare,
    toolIds: message.tools?.map((tool) => tool.toolId) ?? null,
  });
  if (
    readyToPrepare &&
    !closing &&
    message.autoPrepare &&
    installation.snapshot().autoInstallEnabled
  )
    installation.prepareAll();
}

parent.on("message", (event: Electron.MessageEvent) => {
  const parsed = mainToPreinstalledToolsSchema.safeParse(event.data);
  if (!parsed.success) {
    log.warn(undefined, "拒绝无效预装进程消息");
    return;
  }
  const message = parsed.data;
  if (message.type === "initialize") {
    if (startup) return;
    startup = initialize(message);
    void startup.catch((error) => {
      log.error(undefined, "初始化失败", String(error));
      process.exit(1);
    });
  } else if (message.type === "get-state") {
    void startup?.then(() => {
      if (installation)
        post({ type: "state", requestId: message.requestId, state: installation.snapshot() });
    });
  } else if (message.type === "command") {
    void (async () => {
      try {
        await startup;
        if (!installation || closing) throw new Error("预装工具进程不可用");
        if (message.command.type === "set-auto-install")
          await installation.setAutoInstallEnabled(message.command.enabled);
        else if (message.command.type === "set-agent-enabled")
          await installation.setAgentEnabled(message.command.toolId, message.command.enabled);
        else if (message.command.type === "sync-entries")
          await installation.syncEntries(message.command.toolId);
        else if (message.command.type === "cancel")
          await installation.cancel(message.command.toolId);
        else if (message.command.type === "delete")
          await installation.delete(message.command.toolId);
        else
          void installation
            .prepare(message.command.toolId)
            .catch((error) => log.error(undefined, "准备收尾失败", String(error)));
        post({ type: "state", requestId: message.requestId, state: installation.snapshot() });
      } catch (error) {
        log.warn(undefined, "预装工具命令失败", {
          command: message.command.type,
          error: String(error),
        });
        post({ type: "command-error", requestId: message.requestId });
      }
    })();
  } else if (message.type === "dispose") {
    closing = true;
    void (async () => {
      try {
        await startup;
        await installation?.dispose();
      } finally {
        process.exit(0);
      }
    })();
  }
});
