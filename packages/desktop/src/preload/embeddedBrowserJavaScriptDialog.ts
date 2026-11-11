import { contextBridge, ipcRenderer } from "electron";
import { PlatformChannels } from "@zcode/shared";
import { installEmbeddedBrowserDesignBridge } from "./embeddedBrowserDesignBridge.js";
import { installEmbeddedBrowserWheelForwarding } from "./embeddedBrowserWheel.js";

const BRIDGE_KEY = "__zcodeEmbeddedBrowserJavaScriptDialog__";

if (typeof window !== "undefined") {
  installEmbeddedBrowserWheelForwarding(window, (channel, payload) => {
    ipcRenderer.sendToHost(channel, payload);
  });
  installEmbeddedBrowserDesignBridge(window, (channel, payload) => {
    ipcRenderer.sendToHost(channel, payload);
  });
}

interface DialogBridgeResult {
  handled: boolean;
  value?: boolean;
}

contextBridge.exposeInMainWorld(BRIDGE_KEY, {
  show(type: "alert" | "confirm", message: string): DialogBridgeResult {
    try {
      const result = ipcRenderer.sendSync(PlatformChannels.EmbeddedBrowserJavaScriptDialog, {
        type,
        message,
      }) as unknown;
      if (typeof result !== "object" || result === null) return { handled: false };
      const candidate = result as Partial<DialogBridgeResult>;
      if (candidate.handled !== true) return { handled: false };
      return {
        handled: true,
        ...(typeof candidate.value === "boolean" ? { value: candidate.value } : {}),
      };
    } catch {
      // Main 不可用时退回 Chromium 原生 API，不能吞掉网页 Dialog。
      return { handled: false };
    }
  },
});

contextBridge.executeInMainWorld({
  func: (bridgeKey: string) => {
    type Bridge = {
      show: (type: "alert" | "confirm", message: string) => DialogBridgeResult;
    };
    const bridge = (window as unknown as Record<string, Bridge | undefined>)[bridgeKey];
    if (!bridge) return;

    const installedConfirmByWindow = new WeakMap<Window, Window["confirm"]>();
    const observedFrames = new WeakSet<HTMLIFrameElement>();

    const installInWindow = (target: Window): void => {
      try {
        if (installedConfirmByWindow.get(target) === target.confirm) return;
        const nativeAlert = target.alert.bind(target);
        const nativeConfirm = target.confirm.bind(target);
        target.alert = (message?: unknown): void => {
          const text = message === undefined ? "" : String(message);
          const result = bridge.show("alert", text);
          if (!result.handled) nativeAlert(text);
        };
        const wrappedConfirm = (message?: string): boolean => {
          const text = message === undefined ? "" : String(message);
          const result = bridge.show("confirm", text);
          return result.handled ? result.value === true : nativeConfirm(text);
        };
        target.confirm = wrappedConfirm;
        installedConfirmByWindow.set(target, wrappedConfirm);
      } catch {
        // 跨源 frame 不允许宿主读取 Window；它在真实导航时会自行加载同一 preload。
      }
    };

    const installFrameTree = (target: Window): void => {
      installInWindow(target);
      try {
        for (const frame of target.document.querySelectorAll("iframe")) {
          if (!observedFrames.has(frame)) {
            observedFrames.add(frame);
            frame.addEventListener(
              "load",
              () => {
                if (frame.contentWindow) installFrameTree(frame.contentWindow);
              },
              true,
            );
          }
          if (frame.contentWindow) installFrameTree(frame.contentWindow);
        }
      } catch {
        // 跨源文档的 frame tree 由对应 frame 自己的 preload 处理。
      }
    };

    installFrameTree(window);
    const observeFrames = (): void => {
      installFrameTree(window);
      const root = window.document?.documentElement;
      if (!root) return;
      // 无 src 的继承型 about:blank iframe 不发生文档级导航，Electron 不会
      // 为它单独执行 preload；监听页面插入后，从同源父 frame 安装相同包装。
      new window.MutationObserver(() => installFrameTree(window)).observe(root, {
        childList: true,
        subtree: true,
      });
    };
    if (window.document?.documentElement) observeFrames();
    else window.addEventListener?.("DOMContentLoaded", observeFrames, { once: true });
  },
  args: [BRIDGE_KEY],
});

/**
 * Electron 的 Notification.permission getter 不查询 session permission handler，
 * 恒返回 denied（官方 Feature Request 待实现 renderer override），导致网页
 * 「已授权却显示未授予」。此处与 JS Dialog 同通道在主世界 override：
 * 初始按未决定（default）呈现，requestPermission 的真实结果回写状态。
 * new Notification 的显示行为仍由 Chromium 内部判定，不受本 override 影响。
 */
contextBridge.executeInMainWorld({
  func: () => {
    try {
      if (typeof Notification === "undefined") return;
      let permissionState: NotificationPermission = "default";
      const nativeRequestPermission = Notification.requestPermission;
      const wrappedRequestPermission = function (
        this: typeof Notification,
        deprecatedCallback?: NotificationPermissionCallback | undefined,
      ): Promise<NotificationPermission> {
        const settled = Promise.resolve(nativeRequestPermission.call(Notification)).then(
          (status: NotificationPermission) => {
            permissionState = status;
            return status;
          },
        );
        if (typeof deprecatedCallback === "function") {
          void settled.then(
            (status) => deprecatedCallback(status),
            () => undefined,
          );
        }
        return settled;
      };
      Notification.requestPermission = wrappedRequestPermission;
      Object.defineProperty(Notification, "permission", {
        get: () => permissionState,
        configurable: true,
      });
    } catch {
      // 页面脚本可能已锁定 Notification；保持原生行为。
    }
  },
  args: [],
});
