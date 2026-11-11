// 全 App 唯一的扩展进程（docs/plugins/extension-host.md）：由 Main 的监管器
// （main/extensionHostSupervisor.ts）用 utilityProcess.fork 拉起。
// 职责：按 Window Host 给的扩展声明激活扩展、持有贡献表（运行状态与动态值）并推给 Window Host。
// 静态声明（plugin.json）由 Window Host 读取与校验，本进程不读清单（§16.1）。
// 本进程只经 parentPort 与 Main 交换生命周期消息；业务数据只走 Main 牵线的 L1 端口。
import type { MessagePortMain } from "electron";
import { mainToExtensionHostMessageSchema } from "@zcode/shared/extension-host";
import { CapabilityClient } from "#src/extension-host/capabilityClient.js";
import { ExtensionRegistry } from "#src/extension-host/registry.js";
import { ViewHost } from "#src/extension-host/viewHost.js";
import {
  enableEnvironmentProxy,
  exitHost,
  hostLog,
  installRuntimeGuards,
  postToMain,
} from "#src/extension-host/runtime.js";
import { connectWindowHost, type WindowConnection } from "#src/extension-host/windowConnection.js";

/** 退出与计划重启时所有 deactivate 共用的时间预算；Main 在 1.5 秒后强杀。 */
const DEACTIVATE_BUDGET_MS = 1_000;

installRuntimeGuards();
// 在加载任何扩展之前打开环境代理（§18.1 H3）：全局 fetch 跟随设置页的代理与 No Proxy。
enableEnvironmentProxy();

const capabilities = new CapabilityClient();
const views = new ViewHost();
let registry: ExtensionRegistry | null = null;
let connection: WindowConnection | null = null;
let disposing = false;

async function dispose(): Promise<void> {
  if (disposing) return;
  disposing = true;
  hostLog("info", "dispose requested; deactivating extensions");
  connection?.dispose();
  connection = null;
  await registry?.deactivateAll(DEACTIVATE_BUDGET_MS);
  hostLog("info", "extension host exiting");
  exitHost(0);
}

process.parentPort.on("message", (event: Electron.MessageEvent) => {
  const parsed = mainToExtensionHostMessageSchema.safeParse(event.data);
  if (!parsed.success) {
    hostLog("warn", "ignored an invalid control message from main");
    return;
  }
  const message = parsed.data;
  if (message.type === "extension-host/probe") {
    // 存活探测由本进程的事件循环回应：扩展写了死循环时这里不会执行。
    postToMain({ type: "extension-host/probe-ack", seq: message.seq });
    return;
  }
  if (message.type === "extension-host/init") {
    if (registry) return;
    registry = new ExtensionRegistry(message.gen, capabilities, views, (reason) =>
      postToMain({ type: "extension-host/request-restart", reason }),
    );
    hostLog("info", `extension host started gen=${message.gen} pid=${process.pid}`);
    postToMain({ type: "extension-host/ready", gen: message.gen });
    return;
  }
  if (message.type === "extension-host/attach-window") {
    const port = event.ports[0] as MessagePortMain | undefined;
    if (!registry || !port || disposing) return;
    // Main 同一时刻只牵一个 Window Host；新端口到达即替换旧连接。
    connection?.dispose();
    connection = connectWindowHost({
      port,
      gen: message.gen,
      registry,
      views,
      capabilities,
      onClosed: (closed) => {
        if (connection === closed) connection = null;
      },
    });
    return;
  }
  if (message.type === "extension-host/dispose") {
    void dispose();
  }
});
