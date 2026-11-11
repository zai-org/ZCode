import { useCallback, useEffect, useRef } from "react";
import { EMBEDDED_BROWSER_DESIGN_BRIDGE, EmbeddedBrowserWebviewChannels } from "@zcode/shared";
import {
  buildDesignPageSignalsScript,
  buildDesignRuntimeCommandScript,
  buildDesignRuntimeInstallScript,
  parseDesignPageInfo,
  parseDesignPageSignals,
  parseDesignRuntimeEvents,
  parseDesignRuntimeReply,
  type DesignPageInfo,
  type DesignPageSignals,
  type DesignRuntimeCommand,
  type DesignRuntimeEvent,
} from "@zcode/design-runtime";
import { logger } from "@/logger.js";

// 设计工具的宿主 ↔ 页面通信（docs/browser-use/2026-11-03-browser-design-mode-spec.md 第二节）。
//
//   每次 dom-ready / did-stop-loading ──signals script──▶ onSignals（决定设计工具是否自动出现）
//   active 且 dom-ready / 刚变 active ──install script──▶ onInstalled(info)（宿主把钉评等重新推给页面）
//   页面 postMessage ──固定 guest preload──sendToHost──▶ ipc-message(DesignEvents) ──▶ onEvent
//   宿主 → 页面：run(command) 走 executeJavaScript
//
// 注入代号每次 dom-ready 递增，迟到的旧页面注入结果丢弃。

export type DesignRuntimeWebview = Pick<
  ElectronWebviewTag,
  "executeJavaScript" | "addEventListener" | "removeEventListener" | "getURL"
>;

/**
 * dom-ready 之前（或 guest 已卸下）`<webview>` 的 executeJavaScript 会同步抛错而不是返回 rejected Promise；
 * 不兜住会冒到 React 渲染树，整个浏览器面板进错误边界。
 */
function evaluate(webview: DesignRuntimeWebview, code: string): Promise<unknown> {
  try {
    return webview.executeJavaScript(code);
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

function readUrl(webview: DesignRuntimeWebview): string | null {
  try {
    return webview.getURL();
  } catch {
    return null;
  }
}

export function useBrowserDesignRuntime({
  active,
  onEvent,
  onInstalled,
  onSignals,
  probeEnabled,
  webview,
  webviewGeneration,
}: {
  /** 运行时是否要装在页面里（设计工具显示中，或当前页有钉评编号要画） */
  active: boolean;
  onEvent: (event: DesignRuntimeEvent) => void;
  /** 每次（重新）注入成功后调用；宿主在这里把钉评、滑杆值、方案重新推给页面 */
  onInstalled: (info: DesignPageInfo) => void;
  onSignals: (signals: DesignPageSignals, pageUrl: string) => void;
  /** 只有人类用户的浏览器 tab 读设计稿信号 */
  probeEnabled: boolean;
  webview: DesignRuntimeWebview | null;
  webviewGeneration: number;
}) {
  const webviewRef = useRef(webview);
  webviewRef.current = webview;
  const callbacks = useRef({ onEvent, onInstalled, onSignals });
  callbacks.current = { onEvent, onInstalled, onSignals };

  const run = useCallback(async (command: DesignRuntimeCommand): Promise<unknown> => {
    const target = webviewRef.current;
    if (!target) return null;
    try {
      const reply = parseDesignRuntimeReply(
        await evaluate(target, buildDesignRuntimeCommandScript(command)),
      );
      return reply.ok ? reply.result : null;
    } catch (error) {
      logger.debug("[BrowserDesign] 设计运行时命令失败", {
        command: command.type,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }, []);

  // 设计稿信号：不装运行时，只读 data-zcode-design / :root CSS 变量 / data-variant / section.slide。
  useEffect(() => {
    if (!probeEnabled || !webview) return;
    let disposed = false;
    const probe = () => {
      void evaluate(webview, buildDesignPageSignalsScript())
        .then((value) => {
          const signals = parseDesignPageSignals(value);
          const url = readUrl(webview);
          if (!disposed && signals && url !== null) callbacks.current.onSignals(signals, url);
        })
        // dom-ready 之前 guest 还不能执行脚本；等下一次事件。
        .catch(() => undefined);
    };
    webview.addEventListener("dom-ready", probe);
    webview.addEventListener("did-stop-loading", probe);
    probe();
    return () => {
      disposed = true;
      webview.removeEventListener("dom-ready", probe);
      webview.removeEventListener("did-stop-loading", probe);
    };
  }, [probeEnabled, webview, webviewGeneration]);

  useEffect(() => {
    if (!active || !webview) return;
    let disposed = false;
    let generation = 0;
    const install = () => {
      generation += 1;
      const current = generation;
      void evaluate(
        webview,
        buildDesignRuntimeInstallScript(EMBEDDED_BROWSER_DESIGN_BRIDGE.messageKey),
      )
        .then((value) => {
          const reply = parseDesignRuntimeReply(value);
          const info = reply.ok ? parseDesignPageInfo(reply.result) : null;
          if (!disposed && current === generation && info) callbacks.current.onInstalled(info);
        })
        .catch((error: unknown) => {
          // dom-ready 之前 guest 还不能执行脚本；等下一次 dom-ready 再装。
          logger.debug("[BrowserDesign] 设计运行时注入失败", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    };
    const handleIpcMessage = (event: ElectronWebviewIpcMessageEvent) => {
      if (event.channel !== EmbeddedBrowserWebviewChannels.DesignEvents) return;
      for (const designEvent of parseDesignRuntimeEvents(event.args[0])) {
        callbacks.current.onEvent(designEvent);
      }
    };
    webview.addEventListener("dom-ready", install);
    webview.addEventListener("ipc-message", handleIpcMessage);
    install();
    return () => {
      disposed = true;
      webview.removeEventListener("dom-ready", install);
      webview.removeEventListener("ipc-message", handleIpcMessage);
      // 还原页面（浮层、预览样式、CSS 变量、方案）；webview 已销毁时忽略。
      void evaluate(webview, buildDesignRuntimeCommandScript({ type: "dispose" })).catch(
        () => undefined,
      );
    };
  }, [active, webview, webviewGeneration]);

  return { run };
}
