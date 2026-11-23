import type { BrowserWindow, UtilityProcess, IpcMain, WebContents } from "electron";
import { createAppControlNavigationWindow } from "#src/app-control-navigation/windowBridge.js";
import {
  APP_NAVIGATION_IPC,
  appNavigationHostMessageSchema,
  appNavigationRendererIpcSchema,
  type AppControlNavigationWindow,
  type AppNavigationSource,
} from "#src/app-control-navigation/contract.js";

const surfaces = new WeakMap<BrowserWindow, AppControlNavigationWindow>();
const registered = new WeakSet<object>();
function windowSurface(win: BrowserWindow): AppControlNavigationWindow {
  const current = surfaces.get(win);
  if (current) return current;
  const surface = createAppControlNavigationWindow({
    uiTarget: `window:${win.id}`,
    send: (message) => {
      if (win.isDestroyed() || win.webContents.isDestroyed()) throw new Error("window-closed");
      win.webContents.send(APP_NAVIGATION_IPC, message);
    },
  });
  surfaces.set(win, surface);
  // 同一窗口只创建一次 surface 与监听器。reload 只失效 renderer generation，不替换 owner。
  const invalidate = () => surface.invalidate();
  win.webContents.on("render-process-gone", invalidate);
  // 以主框架导航提交为准，不用 did-start-navigation：Electron 对被 will-navigate 拦截的导航
  // （主窗口导航守卫，如点击 Mermaid 外链）仍先发 did-start-navigation，页面却没有替换，
  // 当前 renderer 不会重新登记，之后的 App 控制导航会一直返回 renderer-unavailable。
  // did-navigate 只在主框架跨文档导航提交时触发，reload 与真实页面替换照常失效。
  win.webContents.on("did-navigate", invalidate);
  win.once("closed", () => {
    surface.dispose();
    surfaces.delete(win);
  });
  return surface;
}

/** IPC sender 决定窗口，payload 不接受自报 windowId。手机没有这条 Electron 通道。 */
export function registerAppControlNavigationIpc(
  ipcMain: Pick<IpcMain, "on">,
  fromWebContents: (contents: WebContents) => BrowserWindow | null,
): void {
  if (registered.has(ipcMain)) return;
  registered.add(ipcMain);
  ipcMain.on(APP_NAVIGATION_IPC, (event, payload: unknown) => {
    const win = fromWebContents(event.sender);
    if (!win || event.senderFrame !== event.sender.mainFrame) return;
    const parsed = appNavigationRendererIpcSchema.safeParse(payload);
    if (!parsed.success) return;
    const message = parsed.data;
    const surface = windowSurface(win);
    if (message.type === "register") surface.register(message.generation);
    else if (message.type === "unregister") surface.unregister(message.generation);
    else surface.complete(message);
  });
}

/** 缺省使用可信 Host→window 绑定；显式目标只从 Main 当前窗口注册表解析。 */
export function bindAppControlNavigationHost(
  win: BrowserWindow,
  host: UtilityProcess,
  findWindow: (id: number) => BrowserWindow | null = (id) => (id === win.id ? win : null),
): () => void {
  const pending = new Map<string, AppControlNavigationWindow>();
  const source: AppNavigationSource = {
    reply: (message) => {
      pending.delete(message.requestId);
      host.postMessage(message);
    },
  };
  const receive = (payload: unknown) => {
    const parsed = appNavigationHostMessageSchema.safeParse(payload);
    if (!parsed.success) return;
    const message = parsed.data;
    if (message.type === "app-navigation-cancel") {
      pending.get(message.requestId)?.cancel(source, message.requestId);
      return;
    }
    const explicit = message.uiTarget?.match(/^window:([1-9][0-9]*)$/u);
    const target = message.uiTarget ? (explicit ? findWindow(Number(explicit[1])) : null) : win;
    if (!target || target.isDestroyed()) {
      source.reply({
        type: "app-navigation-result",
        requestId: message.requestId,
        result: { status: "unavailable", reason: "ui-target-unavailable" },
      });
      return;
    }
    const surface = windowSurface(target);
    pending.set(message.requestId, surface);
    surface.open(source, message);
  };
  host.on("message", receive);
  return () => {
    host.removeListener("message", receive);
    for (const surface of new Set(pending.values())) surface.detach(source);
    pending.clear();
  };
}
