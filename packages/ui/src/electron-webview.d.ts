import type { DetailedHTMLProps, HTMLAttributes } from "react";

declare module "react" {
  interface WebViewHTMLAttributes<T> extends HTMLAttributes<T> {
    nodeintegrationinsubframes?: string;
  }
}

type ElectronWebviewSimpleEventName =
  | "did-attach"
  | "dom-ready"
  | "did-start-loading"
  | "did-stop-loading";
type ElectronWebviewNavigationEventName =
  | "did-navigate"
  | "did-navigate-in-page"
  | "will-navigate"
  | "will-frame-navigate";
type ElectronWebviewRenderProcessGoneReason =
  | "clean-exit"
  | "abnormal-exit"
  | "killed"
  | "crashed"
  | "oom"
  | "launch-failed"
  | "integrity-failure"
  | "memory-eviction";

declare global {
  interface ElectronWebviewNavigationEvent extends Event {
    url: string;
    isMainFrame?: boolean;
  }

  interface ElectronWebviewDidFailLoadEvent extends Event {
    errorCode: number;
    errorDescription: string;
    validatedURL: string;
    isMainFrame: boolean;
  }

  interface ElectronWebviewTitleEvent extends Event {
    title: string;
    explicitSet: boolean;
  }

  interface ElectronWebviewFaviconEvent extends Event {
    favicons: string[];
  }

  interface ElectronWebviewIpcMessageEvent extends Event {
    channel: string;
    args: unknown[];
  }

  interface ElectronWebviewRenderProcessGoneEvent extends Event {
    details: {
      reason: ElectronWebviewRenderProcessGoneReason;
      exitCode: number;
    };
  }

  interface ElectronWebviewTag extends HTMLElement {
    src: string;
    getURL(): string;
    getTitle(): string;
    loadURL(url: string): Promise<void>;
    executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
    // guest webContents id：dom-ready 后有效，renderer 上报给 main 用于 CDP attach（<webview>+CDP-on-guest）。
    getWebContentsId(): number;
    canGoBack(): boolean;
    canGoForward(): boolean;
    goBack(): void;
    goForward(): void;
    reload(): void;
    openDevTools(): void;
    // 人类用户「导出为 PDF」：renderer 直接打印 guest，不改变 guest metrics。
    // 不声明 capturePage：renderer 侧调它会让 renderer 原生崩溃，PNG 走 main 取帧。
    printToPDF(options: {
      printBackground?: boolean;
      preferCSSPageSize?: boolean;
    }): Promise<Uint8Array>;
    setZoomFactor(factor: number): void;
    addEventListener(
      type: ElectronWebviewSimpleEventName,
      listener: (event: Event) => void,
      options?: boolean | AddEventListenerOptions,
    ): void;
    addEventListener(
      type: "did-fail-load",
      listener: (event: ElectronWebviewDidFailLoadEvent) => void,
      options?: boolean | AddEventListenerOptions,
    ): void;
    addEventListener(
      type: ElectronWebviewNavigationEventName,
      listener: (event: ElectronWebviewNavigationEvent) => void,
      options?: boolean | AddEventListenerOptions,
    ): void;
    addEventListener(
      type: "page-title-updated",
      listener: (event: ElectronWebviewTitleEvent) => void,
      options?: boolean | AddEventListenerOptions,
    ): void;
    addEventListener(
      type: "page-favicon-updated",
      listener: (event: ElectronWebviewFaviconEvent) => void,
      options?: boolean | AddEventListenerOptions,
    ): void;
    addEventListener(
      type: "ipc-message",
      listener: (event: ElectronWebviewIpcMessageEvent) => void,
      options?: boolean | AddEventListenerOptions,
    ): void;
    addEventListener(
      type: "render-process-gone",
      listener: (event: ElectronWebviewRenderProcessGoneEvent) => void,
      options?: boolean | AddEventListenerOptions,
    ): void;
    removeEventListener(
      type: ElectronWebviewSimpleEventName,
      listener: (event: Event) => void,
      options?: boolean | EventListenerOptions,
    ): void;
    removeEventListener(
      type: "did-fail-load",
      listener: (event: ElectronWebviewDidFailLoadEvent) => void,
      options?: boolean | EventListenerOptions,
    ): void;
    removeEventListener(
      type: ElectronWebviewNavigationEventName,
      listener: (event: ElectronWebviewNavigationEvent) => void,
      options?: boolean | EventListenerOptions,
    ): void;
    removeEventListener(
      type: "page-title-updated",
      listener: (event: ElectronWebviewTitleEvent) => void,
      options?: boolean | EventListenerOptions,
    ): void;
    removeEventListener(
      type: "page-favicon-updated",
      listener: (event: ElectronWebviewFaviconEvent) => void,
      options?: boolean | EventListenerOptions,
    ): void;
    removeEventListener(
      type: "ipc-message",
      listener: (event: ElectronWebviewIpcMessageEvent) => void,
      options?: boolean | EventListenerOptions,
    ): void;
    removeEventListener(
      type: "render-process-gone",
      listener: (event: ElectronWebviewRenderProcessGoneEvent) => void,
      options?: boolean | EventListenerOptions,
    ): void;
  }

  // React 对 <webview> 的 ref 依赖 HTMLWebViewElement，
  // 之前我们只声明了自定义的 ElectronWebviewTag，导致 ref 回调参数和 JSX intrinsic element 的宿主类型对不上。
  // 这里把 DOM 侧的 HTMLWebViewElement 补齐到同一接口层级，让事件和 ref 都能按 Electron webview 解析。
  interface HTMLWebViewElement extends ElectronWebviewTag {}

  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<HTMLAttributes<HTMLWebViewElement>, HTMLWebViewElement> & {
        partition?: string;
        src?: string;
      };
    }
  }
}

export {};
