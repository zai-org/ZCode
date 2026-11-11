/**
 * 受控视图的最小抽象：executor 只依赖这些方法，便于用 stub 单测（无需真 Electron webContents）。
 * 真实实现由 browserGuestManager 用 `<webview>` guest 的 webContents + webContents.debugger 提供。
 */
export interface ControlledViewWebContents {
  loadURL(url: string): Promise<void>;
  getURL(): string;
  getTitle(): string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  /**
   * 在页面上下文执行脚本并返回最后一个表达式的值（结构化克隆）。
   * 由 browserGuestManager wire 到 `guest.executeJavaScript(script, true)`（userGesture=true，与 element-picker 一致）。
   */
  executeJavaScript(script: string): Promise<unknown>;
  sendInputEvent(event: ControlledViewKeyInputEvent): void;
}

export interface ControlledViewKeyInputEvent {
  type: "keyDown" | "keyUp" | "char";
  keyCode: string;
  modifiers?: Array<"alt" | "control" | "meta" | "shift">;
}

export interface ControlledViewCdp {
  /** webContents.debugger.sendCommand 的直通；sessionId 用于跨进程 iframe/OOPIF target。 */
  send(method: string, params?: unknown, sessionId?: string): Promise<unknown>;
}

export interface ControlledView {
  webContents: ControlledViewWebContents;
  cdp: ControlledViewCdp;
  /**
   * 已由宿主 compositor 合成的 viewport 截图。仅用于无 clip、非 fullPage 的普通截图；
   * Desktop 生产实现从 main 进程直接读取 guest surface，避开 Windows 下 CDP 对小 surface 的平铺。
   */
  captureViewportScreenshot?: () => Promise<string | undefined>;
  /**
   * 自由尺寸 guest 的 visible surface 保留宿主 backing scale；截图目标仍按 CSS px 计算。
   * executor 仅在该标记开启时读取 CDP layout metrics 并校验实际 raster。
   */
  normalizeScreenshotToCssPixels?: boolean;
  /**
   * 宿主图像引擎提供的高质量降采样能力。核心 executor 不直接依赖 Electron，
   * Desktop 生产装配使用 nativeImage，测试和其它宿主可注入等价实现。
   */
  resizeScreenshotToCssPixels?: (
    base64Png: string,
    target: { height: number; width: number },
  ) => Promise<string | undefined> | string | undefined;
}

export interface BrowserPoint {
  cx: number;
  cy: number;
}
