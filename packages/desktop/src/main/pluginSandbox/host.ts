import { resolveLocaleFromLanguageTag, toZhOrEnLocale, type Locale } from "@zcode/shared";
import { PlatformChannels } from "@zcode/shared";
import type { PluginSandboxHandle, PluginSandboxRegisterInput } from "@zcode/shared/mcp-apps";
import {
  BrowserWindow,
  clipboard,
  ClipboardItem,
  MessageChannelMain,
  app,
  dialog,
  session as electronSession,
  webContents as electronWebContents,
  ipcMain,
  systemPreferences,
  type WebContents,
} from "electron";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { PluginSandboxRecord, PluginSandboxRegistryPort } from "./contract.js";
import { attachPluginSandboxGuest, configurePluginSandboxGuest } from "./guestPolicy.js";
import { createPluginSandboxPermissionGate } from "./permissionGate.js";
import { formatPluginSandboxPermissionDialogText } from "./permissions.js";
import type { PluginSandboxAssetSource } from "./protocol.js";
import { createPluginSandboxRegistry } from "./registry.js";
import { preparePluginSandboxSession } from "./session.js";
import { sandboxCaptureSchema, scaleCaptureRect } from "./capture.js";
import { DesktopBrowserScreenshotActivityController } from "@desktop/main/browserView/browserScreenshotActivityController.js";

export interface PluginSandboxHost {
  clearBrowserData(): Promise<void>;
  /** host 进程经 parentPort 登记；返回句柄前完成 partition session 准备。 */
  registerFromHost(input: PluginSandboxRegisterInput): PluginSandboxHandle;
  /** desktopWindowChrome 的 will-attach 分支。 */
  configureGuest(input: {
    webPreferences: Electron.WebPreferences;
    params: Record<string, string>;
    ownerWebContentsId: number;
  }): ReturnType<typeof configurePluginSandboxGuest>;
  /** desktopWindowChrome 的 did-attach 分支。 */
  attachGuest(input: { guest: WebContents; hostWebContents: WebContents; sandboxId: string }): void;
}

let installedHost: PluginSandboxHost | null = null;

export function getPluginSandboxHost(): PluginSandboxHost | null {
  return installedHost;
}

/**
 * 在 app ready 后安装一次：创建注册表、注册 renderer 可调的两条 IPC（dispose / 手势消费，按 sender 归属校验）。
 * scheme 的 privileged 注册必须在 app ready 前、与 zcode-media 同一次调用完成，不在这里。
 */
export function installPluginSandboxHost(input: {
  preloadPath: string;
  rendererDir: string;
  aliasDir: string;
  /** vite dev server 地址；有值时 shell 资源从它代理（见 PluginSandboxAssetSource）。 */
  devServerUrl?: string;
  logger?: { warn: (...args: unknown[]) => void; info?: (...args: unknown[]) => void };
  registry?: PluginSandboxRegistryPort;
  /** 注册表容量（缺省 64）；e2e L05 用 1 验证配额拒绝。 */
  registryMaxEntries?: number;
  /** 当前界面语言；权限确认框跟随界面语言而不是系统语言（未注入时才回退系统语言）。 */
  getApplicationLocale?: () => Locale;
}): PluginSandboxHost {
  if (installedHost) return installedHost;
  const detachByKey = new Map<string, () => void>();
  const watchedOwners = new Set<number>();
  const guests = new Map<string, WebContents>();
  const activity = new DesktopBrowserScreenshotActivityController({
    fromId: (id) => BrowserWindow.fromId(id),
    fromWebContentsId: (id) => electronWebContents.fromId(id) ?? null,
    log: (message) => input.logger?.warn(message),
  });
  const executions = new Map<string, { lease?: ReturnType<typeof activity.acquire> }>();
  const releaseExecution = (sandboxId: string) => {
    executions.get(sandboxId)?.lease?.release();
    executions.delete(sandboxId);
  };
  const syncExecution = (sandboxId: string) => {
    const state = executions.get(sandboxId);
    const guest = guests.get(sandboxId);
    if (!state || state.lease || !guest || guest.isDestroyed() || guest.isLoadingMainFrame())
      return;
    const owner = guest.hostWebContents;
    const win = owner && BrowserWindow.fromWebContents(owner);
    if (!win) return;
    state.lease = activity.acquire({
      windowId: win.id,
      webContentsId: guest.id,
      requestId: sandboxId,
      reason: "plugin-execution",
    });
    // 隐藏页面仅需低频推进；不能全局关闭 backgroundThrottling，否则同窗空闲 guest 也会跑帧。
    state.lease?.markPrepared?.();
    state.lease?.invalidated?.addEventListener(
      "abort",
      () => {
        if (executions.get(sandboxId) === state) releaseExecution(sandboxId);
      },
      { once: true },
    );
  };
  const stopping = new WeakMap<WebContents, Promise<void>>();
  const partitions = new Set<string>();
  let clearing = false;
  const assets: PluginSandboxAssetSource = {
    rendererDir: input.rendererDir,
    aliasDir: input.aliasDir,
    ...(input.devServerUrl ? { devServerUrl: input.devServerUrl } : {}),
  };
  const stopGuest = (guest: WebContents): Promise<void> => {
    if (guest.isDestroyed()) return Promise.resolve();
    const existing = stopping.get(guest);
    if (existing) return existing;
    // Electron 41 的 attached guest.close 只销毁包装对象，iframe 仍可写存储。
    // 先完成原生空白页导航，真正移除旧文档；不用 destroyed 或延时猜测页面已经停止。
    const stopped = Promise.resolve().then(async () => {
      if (guest.isDestroyed()) return;
      const allowUnload = (event: Electron.Event) => event.preventDefault();
      guest.on("will-prevent-unload", allowUnload);
      try {
        await guest.loadURL("about:blank");
      } catch (error) {
        // Renderer 移除 webview / owner 关闭时会中止导航，此时实际文档已释放。
        if (!guest.isDestroyed()) throw error;
      } finally {
        guest.removeListener("will-prevent-unload", allowUnload);
      }
      if (guest.isDestroyed()) return;
      const destroyed = new Promise<void>((resolve) => guest.once("destroyed", resolve));
      guest.close({ waitForBeforeUnload: false });
      await destroyed;
    });
    stopping.set(guest, stopped);
    return stopped;
  };
  // partition 持久且按可信 App 身份隔离：dispose 关闭 guest 和端口，
  // 不撤 protocol handler、不清存储；存储清理走已有清除所有数据入口。
  const onDispose = (record: PluginSandboxRecord) => {
    releaseExecution(record.sandboxId);
    detachByKey.get(record.sandboxId)?.();
    detachByKey.delete(record.sandboxId);
    const guest = guests.get(record.sandboxId);
    // 保留 guest 到真正停止：清除数据必须能等待已经进入 dispose 的旧实例。
    if (guest)
      void stopGuest(guest).catch((error: unknown) =>
        input.logger?.warn("[plugin-sandbox] guest stop failed", String(error)),
      );
  };
  const registry =
    input.registry ??
    createPluginSandboxRegistry({
      onDispose,
      ...(input.registryMaxEntries !== undefined ? { maxEntries: input.registryMaxEntries } : {}),
    });

  // 页面浏览器权限闸门：确认框由 main 原生弹出，父窗口是登记该沙箱的宿主窗口，页面无法伪造。
  // 确认框文案只有中英两套：中文界面用中文，其它界面语言用英文。
  const resolveLocale = (): Locale =>
    toZhOrEnLocale(input.getApplicationLocale?.() ?? resolveLocaleFromLanguageTag(app.getLocale()));
  const permissions = createPluginSandboxPermissionGate({
    registry,
    async prompt({ record, permissions: pending }) {
      const text = formatPluginSandboxPermissionDialogText(
        { serverName: record.serverName ?? "ZCode Gen UI", permissions: pending },
        resolveLocale(),
      );
      const owner = electronWebContents.fromId(record.ownerWebContentsId);
      const parent = owner ? BrowserWindow.fromWebContents(owner) : null;
      const options = {
        type: "question" as const,
        buttons: [text.allowButton, text.denyButton],
        defaultId: 1,
        cancelId: 1,
        title: text.title,
        message: text.message,
        detail: text.detail,
        noLink: true,
      };
      const { response } =
        parent && !parent.isDestroyed()
          ? await dialog.showMessageBox(parent, options)
          : await dialog.showMessageBox(options);
      return response === 0;
    },
    ...(process.platform === "darwin"
      ? {
          async requestSystemMediaAccess(kind: "camera" | "microphone") {
            const status = systemPreferences.getMediaAccessStatus(kind);
            if (status === "granted") return true;
            if (status !== "not-determined") return false;
            return systemPreferences.askForMediaAccess(kind);
          },
        }
      : {}),
    ...(input.logger ? { logger: input.logger } : {}),
  });

  const host: PluginSandboxHost = {
    async clearBrowserData() {
      clearing = true;
      for (const owner of watchedOwners) registry.disposeOwner(owner);
      await Promise.all([...guests.values()].map(stopGuest));
      guests.clear();
      const names = await readdir(join(app.getPath("sessionData"), "Partitions")).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return [];
          throw error;
        },
      );
      for (const name of names)
        if (/^plugin-sandbox-v[12]-[a-f0-9]+$/.test(name)) partitions.add(`persist:${name}`);
      await Promise.all(
        [...partitions].map(async (partition) => {
          const session = electronSession.fromPartition(partition);
          await session.clearStorageData();
          await session.clearCache();
        }),
      );
    },
    registerFromHost(registerInput) {
      if (clearing) throw new Error("MCP App browser data is being cleared");
      const owner = electronWebContents.fromId(registerInput.ownerWebContentsId);
      if (!owner || owner.isDestroyed()) throw new Error("MCP App window is no longer available");
      const handle = registry.register(registerInput);
      partitions.add(handle.partition);
      // prepare 后尚未挂载的登记也属于窗口；关闭和清除数据不能漏掉它们。
      if (!watchedOwners.has(owner.id)) {
        watchedOwners.add(owner.id);
        owner.once("destroyed", () => {
          watchedOwners.delete(owner.id);
          registry.disposeOwner(owner.id);
        });
      }
      preparePluginSandboxSession({
        session: electronSession.fromPartition(handle.partition),
        registry,
        assets,
        permissions,
        logger: input.logger,
      });
      // 每个沙箱登记一次一条，供排 renderer / host / main 三段握手用。
      input.logger?.info?.("[plugin-sandbox] registered", {
        sandboxId: handle.sandboxId,
        initId: handle.initId,
        scopeId: registerInput.scopeId,
        ownerWebContentsId: registerInput.ownerWebContentsId,
      });
      return handle;
    },
    configureGuest(guestInput) {
      return configurePluginSandboxGuest({
        ...guestInput,
        registry,
        preloadPath: input.preloadPath,
      });
    },
    attachGuest({ guest, hostWebContents, sandboxId }) {
      if (clearing) {
        void stopGuest(guest).catch((error: unknown) =>
          input.logger?.warn("[plugin-sandbox] late guest stop failed", String(error)),
        );
        return;
      }
      guests.set(sandboxId, guest);
      // dom-ready / did-finish-load 回调时仍可能处于 loading，早到的活动请求会被上面的守卫跳过。
      // 以真正停止加载的事件承接待处理请求，不能依赖插件或 session 再发一次活动请求。
      guest.on("did-stop-loading", () => syncExecution(sandboxId));
      guest.once("destroyed", () => {
        if (guests.get(sandboxId) === guest) {
          releaseExecution(sandboxId);
          guests.delete(sandboxId);
        }
      });
      // H14：宿主 webContents 销毁（窗口关闭 / 崩溃）时释放它名下全部登记；每个 owner 只挂一次。
      if (!watchedOwners.has(hostWebContents.id)) {
        watchedOwners.add(hostWebContents.id);
        const ownerId = hostWebContents.id;
        hostWebContents.once("destroyed", () => {
          watchedOwners.delete(ownerId);
          registry.disposeOwner(ownerId);
        });
      }
      detachByKey.get(sandboxId)?.();
      detachByKey.set(
        sandboxId,
        attachPluginSandboxGuest({
          guest,
          hostWebContents,
          registry,
          sandboxId,
          createMessageChannel: () => new MessageChannelMain(),
          logger: input.logger,
        }),
      );
    },
  };

  ipcMain.handle(PlatformChannels.PluginSandboxOwnerWebContentsId, (event) => event.sender.id);
  ipcMain.handle(
    PlatformChannels.PluginSandboxExecutionActive,
    (event, sandboxId: unknown, initId: unknown, active: unknown) => {
      if (
        typeof sandboxId !== "string" ||
        typeof initId !== "number" ||
        typeof active !== "boolean"
      )
        throw new Error("Invalid sandbox execution request");
      const record = registry.get(sandboxId);
      if (
        !record ||
        record.ownerWebContentsId !== event.sender.id ||
        record.initId !== initId ||
        record.contentKind === "gen-ui"
      )
        throw new Error("Sandbox execution is no longer available");
      if (!active) {
        releaseExecution(sandboxId);
        return;
      }
      if (!executions.has(sandboxId)) executions.set(sandboxId, {});
      syncExecution(sandboxId);
    },
  );
  ipcMain.handle(PlatformChannels.PluginSandboxCopyImage, async (event, value: unknown) => {
    const request = sandboxCaptureSchema.parse(value);
    const record = registry.get(request.sandboxId);
    const guest = guests.get(request.sandboxId);
    const isCurrent = () =>
      record &&
      registry.get(request.sandboxId) === record &&
      record.ownerWebContentsId === event.sender.id &&
      record.initId === request.initId &&
      !event.sender.isDestroyed() &&
      guest &&
      !guest.isDestroyed() &&
      guests.get(request.sandboxId) === guest;
    if (!isCurrent() || !guest) throw new Error("Sandbox capture is no longer available");
    const captured = await guest.capturePage();
    // 截图期间页面可能释放或换代；旧请求不得把错误页面的图像写入剪贴板。
    if (!isCurrent()) throw new Error("Sandbox capture is no longer available");
    const cropped = captured.crop(scaleCaptureRect(request, captured.getSize()));
    // Electron 44 移除同步 writeImage；以 PNG 保留图像编码，等待原生写入后才确认复制成功。
    await clipboard.write([
      new ClipboardItem({
        "image/png": new Blob([Uint8Array.from(cropped.toPNG())], { type: "image/png" }),
      }),
    ]);
  });
  ipcMain.handle(
    PlatformChannels.PluginSandboxDispose,
    (event, sandboxId: unknown, initId: unknown) => {
      if (typeof sandboxId !== "string") return;
      const record = registry.get(sandboxId);
      // 只有登记时的宿主窗口能释放自己的沙箱；其他 sender 静默忽略。
      if (!record || record.ownerWebContentsId !== event.sender.id) return;
      input.logger?.info?.("[plugin-sandbox] dispose requested", {
        sandboxId,
        initId,
        currentInitId: record.initId,
      });
      registry.dispose(sandboxId, typeof initId === "number" ? initId : undefined);
      const guest = guests.get(sandboxId);
      // 旧 initId 的迟到 dispose 不能停止仍有效的登记。
      if (guest && !registry.get(sandboxId)) return stopGuest(guest);
    },
  );
  ipcMain.handle(PlatformChannels.PluginSandboxConsumeUserGesture, (event, sandboxId: unknown) => {
    if (typeof sandboxId !== "string") return false;
    const record = registry.get(sandboxId);
    if (!record || record.ownerWebContentsId !== event.sender.id) return false;
    return registry.consumeUserGesture(sandboxId);
  });

  installedHost = host;
  return host;
}
