import { z } from "zod";

/** 内置自由尺寸与 Agent viewport API 共用同一组 CSS px 安全边界。 */
export const BROWSER_VIEWPORT_LIMITS = {
  minWidth: 320,
  maxWidth: 3840,
  minHeight: 320,
  maxHeight: 2160,
} as const;

/**
 * 人类用户自由尺寸工具栏的设备预设（docs/browser-use/2026-10-16-browser-device-presets-and-export-spec.md）。
 * 只是输入宽高的快捷方式，全部落在 BROWSER_VIEWPORT_LIMITS 内；Agent viewport 不使用。
 */
export const BROWSER_VIEWPORT_PRESETS = [
  { id: "phone", width: 390, height: 844 },
  { id: "tablet", width: 834, height: 1112 },
  { id: "desktop", width: 1440, height: 900 },
  { id: "slide", width: 1920, height: 1080 },
] as const;

export type BrowserViewportPresetId = (typeof BROWSER_VIEWPORT_PRESETS)[number]["id"];

/** Agent 创建或打开的新页面使用的固定逻辑 viewport；不属于人类浏览器显示偏好。 */
export const DEFAULT_AGENT_BROWSER_VIEWPORT = {
  width: 1280,
  height: 720,
} as const;

export const browserViewportSizeSchema = z
  .object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();
export type BrowserViewportSize = z.infer<typeof browserViewportSizeSchema>;

/** setViewportSize 输入边界；实际自然 viewport 可能大于自由尺寸画布上限。 */
export const browserViewportInputSchema = browserViewportSizeSchema.extend({
  width: z
    .number()
    .int()
    .min(BROWSER_VIEWPORT_LIMITS.minWidth)
    .max(BROWSER_VIEWPORT_LIMITS.maxWidth),
  height: z
    .number()
    .int()
    .min(BROWSER_VIEWPORT_LIMITS.minHeight)
    .max(BROWSER_VIEWPORT_LIMITS.maxHeight),
});

export const BROWSER_VIEWPORT_ZOOM_OPTIONS = [
  "fit",
  "50",
  "75",
  "100",
  "125",
  "150",
  "200",
] as const;
export const browserViewportZoomSchema = z.enum(BROWSER_VIEWPORT_ZOOM_OPTIONS);
export type BrowserViewportZoom = z.infer<typeof browserViewportZoomSchema>;

export const DEFAULT_BROWSER_VIEWPORT_ZOOM: BrowserViewportZoom = "fit";

/** 仅用于人类用户主动打开 Browser tab 的显示偏好；Agent viewport 运行态不得读写。 */
export const embeddedBrowserViewportPreferenceSchema = z
  .object({
    mode: z.enum(["normal", "responsive"]),
    viewport: browserViewportInputSchema,
    zoom: browserViewportZoomSchema,
  })
  .strict();
export type EmbeddedBrowserViewportPreference = z.infer<
  typeof embeddedBrowserViewportPreferenceSchema
>;

export const DEFAULT_EMBEDDED_BROWSER_VIEWPORT_PREFERENCE: EmbeddedBrowserViewportPreference = {
  mode: "normal",
  viewport: { width: 393, height: 852 },
  zoom: DEFAULT_BROWSER_VIEWPORT_ZOOM,
};

/** browser-use 的统一命令方法集，各分支由 BrowserCommand 的 method 判别。 */
export const browserCommandMethodSchema = z.enum([
  "navigate",
  "back",
  "forward",
  "reload",
  "snapshot",
  "click",
  "fill",
  "type",
  "press",
  "cuaKeypress",
  "scroll",
  "cuaScroll",
  "domCuaScroll",
  "hover",
  "select",
  "check",
  "drag",
  "cuaDrag",
  "screenshot",
  "getState",
  "elementInfo",
  "evaluate",
  "getDialog",
  "handleDialog",
  "waitFor",
  "playwright",
  "playwrightWaitForTimeout",
  "capabilities",
  "browserVisibilityGet",
  "browserVisibilitySet",
  "browserViewportSet",
  "browserViewportReset",
  "recordingStart",
  "recordingStatus",
  "recordingCancel",
  "activateTab",
  "newTab",
  "finalize",
  "finalizeTabs",
  "listUserTabs",
  "claimTab",
  "markDeliverable",
  "markHandoff",
  "nameSession",
  "openScope",
  "releaseScope",
  "turnEnded",
  "closeSession",
  "cancelRequest",
  "close",
  "list",
]);
export type BrowserCommandMethod = z.infer<typeof browserCommandMethodSchema>;

/** 客户端模式；决定桌面 continuous 与手机 replayable 的边界处理。 */
export const browserClientModeSchema = z.enum(["desktop-continuous", "web-remote-replayable"]);
export type BrowserClientMode = z.infer<typeof browserClientModeSchema>;

/** 每条命令携带的会话上下文。 */
export const browserCommandContextSchema = z
  .object({
    /** workspaceIdentity?.trim() || workspacePath，用于隔离与受控 tab 复用。 */
    workspaceKey: z.string().min(1),
    sessionId: z.string().min(1),
    /** 受控 tab id；缺省表示该 session 的活动受控 tab。 */
    tabId: z.string().min(1).optional(),
    requestId: z.string().min(1),
    clientMode: browserClientModeSchema,
  })
  .strict();
export type BrowserCommandContext = z.infer<typeof browserCommandContextSchema>;

/** 结构化错误码：不静默兜底，明确失败原因给模型。 */
export const browserErrorCodeSchema = z.enum([
  "backend_unavailable",
  "capability_unsupported",
  "duplicate_request_id",
  "ref_not_found",
  "navigation_blocked",
  "timeout",
  "renderer_unreachable",
  "cancelled",
  "execution_error",
]);
export type BrowserErrorCode = z.infer<typeof browserErrorCodeSchema>;

/** 页面基础状态（getState / 导航后回传）。 */
export const browserPageStateSchema = z
  .object({
    url: z.string(),
    title: z.string(),
    canGoBack: z.boolean(),
    canGoForward: z.boolean(),
    scrollX: z.number().optional(),
    scrollY: z.number().optional(),
    viewportWidth: z.number().optional(),
    viewportHeight: z.number().optional(),
  })
  .strict();
export type BrowserPageState = z.infer<typeof browserPageStateSchema>;
