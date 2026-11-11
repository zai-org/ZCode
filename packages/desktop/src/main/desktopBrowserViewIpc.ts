import { BrowserWindow, ipcMain } from "electron";
import {
  PlatformChannels,
  browserViewportInputSchema,
  nonEmptyStringSchema,
  type BrowserViewCloseTabRequest,
  type BrowserViewPromoteDraftTabsRequest,
  type BrowserGuestAttachResult,
  type BrowserViewResidencyReportPayload,
  type BrowserViewRestoredTabShell,
  type BrowserViewRestoreTabsRequest,
  type BrowserViewportSize,
  type BrowserViewScreenshotSurfaceReadyPayload,
} from "@zcode/shared";
import { registerBrowserDataIpcHandlers } from "./desktopBrowserDataIpc.js";

export type AttachBrowserGuest = (
  key: string,
  webContentsId: number,
  options?: {
    active?: boolean;
    windowId?: number;
    workspaceKey?: string;
    remoteSessionId?: string;
    sessionId?: string;
    residencyGeneration?: number;
  },
) => BrowserGuestAttachResult | Promise<BrowserGuestAttachResult>;

export type UpdateBrowserGuestViewport = (
  tabId: string,
  viewport: BrowserViewportSize | null,
  windowId: number,
) => Promise<void> | void;

export type ReportBrowserScreenshotSurfaceReady = (
  windowId: number,
  senderWebContentsId: number,
  payload: BrowserViewScreenshotSurfaceReadyPayload,
) => void;

export interface BrowserViewResidencyIpcHandlers {
  detachBrowserGuest?(
    key: string,
    webContentsId: number,
    windowId: number,
  ): Promise<boolean> | boolean;
  closeBrowserTab?(
    payload: BrowserViewCloseTabRequest & { windowId: number },
  ): Promise<void> | void;
  reportBrowserTabResidency?(
    payload: BrowserViewResidencyReportPayload & { windowId: number },
  ): Promise<void> | void;
  promoteDraftBrowserTabs?(
    payload: BrowserViewPromoteDraftTabsRequest & { windowId: number },
  ): string[];
  acknowledgeBrowserTabSuspend?(payload: {
    tabId: string;
    generation: number;
    windowId: number;
  }): Promise<void> | void;
  ensureBrowserTabResident?(
    payload: BrowserViewCloseTabRequest & { windowId: number },
  ): Promise<void> | void;
  restoreBrowserTabs?(
    payload: BrowserViewRestoreTabsRequest & { windowId: number },
  ): Promise<BrowserViewRestoredTabShell[]>;
}

export function registerBrowserViewIpcHandlers(
  attachBrowserGuest?: AttachBrowserGuest,
  updateBrowserGuestViewport?: UpdateBrowserGuestViewport,
  reportBrowserScreenshotSurfaceReady?: ReportBrowserScreenshotSurfaceReady,
  residencyHandlers: BrowserViewResidencyIpcHandlers = {},
) {
  // renderer 只能拿到 guest webContentsId，必须由 main 绑定发送方窗口后再 attach，
  // 否则相同 key 在多个窗口之间可能错误复用 BrowserGuestManager 状态。
  ipcMain.handle(
    PlatformChannels.BrowserViewAttachGuest,
    async (
      event,
      payload: {
        key: string;
        webContentsId: number;
        active?: boolean;
        workspaceKey?: string;
        remoteSessionId?: string;
        sessionId?: string;
        residencyGeneration?: number;
      },
    ) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || win.isDestroyed()) {
        return { ok: false, reason: "window-mismatch", recoveryRequested: false };
      }
      const key = nonEmptyStringSchema.parse(payload.key);
      if (!Number.isSafeInteger(payload.webContentsId) || payload.webContentsId <= 0) {
        throw new TypeError("webContentsId must be a positive safe integer");
      }
      if (payload.active !== undefined && typeof payload.active !== "boolean") {
        throw new TypeError("active must be a boolean");
      }
      if (
        payload.residencyGeneration !== undefined &&
        (!Number.isSafeInteger(payload.residencyGeneration) || payload.residencyGeneration < 0)
      ) {
        throw new TypeError("residencyGeneration must be a non-negative safe integer");
      }
      const workspaceKey =
        payload.workspaceKey === undefined
          ? undefined
          : nonEmptyStringSchema.parse(payload.workspaceKey);
      const remoteSessionId =
        payload.remoteSessionId === undefined
          ? undefined
          : nonEmptyStringSchema.parse(payload.remoteSessionId);
      const sessionId =
        payload.sessionId === undefined ? undefined : nonEmptyStringSchema.parse(payload.sessionId);
      return ((await attachBrowserGuest?.(key, payload.webContentsId, {
        ...(payload.active === undefined ? {} : { active: payload.active }),
        ...(workspaceKey === undefined ? {} : { workspaceKey }),
        ...(remoteSessionId === undefined ? {} : { remoteSessionId }),
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(payload.residencyGeneration === undefined
          ? {}
          : { residencyGeneration: payload.residencyGeneration }),
        windowId: win.id,
      })) ?? {
        ok: false,
        reason: "not-found",
        recoveryRequested: false,
      }) satisfies BrowserGuestAttachResult;
    },
  );

  ipcMain.handle(
    PlatformChannels.BrowserViewDetachGuest,
    async (event, payload: { key: string; webContentsId: number }): Promise<boolean> => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || win.isDestroyed()) return false;
      const key = nonEmptyStringSchema.parse(payload.key);
      if (!Number.isSafeInteger(payload.webContentsId) || payload.webContentsId <= 0) {
        throw new TypeError("webContentsId must be a positive safe integer");
      }
      return (
        (await residencyHandlers.detachBrowserGuest?.(key, payload.webContentsId, win.id)) ?? false
      );
    },
  );

  ipcMain.handle(
    PlatformChannels.BrowserViewUpdateViewport,
    async (
      event,
      payload: {
        tabId: string;
        viewport: BrowserViewportSize | null;
      },
    ) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || win.isDestroyed()) return;
      const tabId = nonEmptyStringSchema.parse(payload.tabId);
      const viewport =
        payload.viewport === null ? null : browserViewportInputSchema.parse(payload.viewport);
      await updateBrowserGuestViewport?.(tabId, viewport, win.id);
    },
  );

  ipcMain.on(
    PlatformChannels.BrowserViewScreenshotSurfaceReady,
    (event, payload: BrowserViewScreenshotSurfaceReadyPayload) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || win.isDestroyed()) return;
      reportBrowserScreenshotSurfaceReady?.(win.id, event.sender.id, payload);
    },
  );

  ipcMain.handle(
    PlatformChannels.BrowserViewCloseTabFromRenderer,
    async (event, payload: BrowserViewCloseTabRequest) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || win.isDestroyed()) return;
      await residencyHandlers.closeBrowserTab?.({
        ...parseBrowserTabScope(payload),
        windowId: win.id,
      });
    },
  );

  ipcMain.handle(
    PlatformChannels.BrowserViewReportResidency,
    async (event, payload: BrowserViewResidencyReportPayload) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || win.isDestroyed()) return;
      await residencyHandlers.reportBrowserTabResidency?.({
        ...payload,
        ...parseBrowserTabScope(payload),
        selected: Boolean(payload.selected),
        visible: Boolean(payload.visible),
        currentTask: Boolean(payload.currentTask),
        loading: Boolean(payload.loading),
        windowId: win.id,
      });
    },
  );

  ipcMain.handle(
    PlatformChannels.BrowserViewPromoteDraftTabs,
    (event, payload: BrowserViewPromoteDraftTabsRequest) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || win.isDestroyed()) return [];
      if (!Array.isArray(payload.tabIds)) throw new TypeError("tabIds must be an array");
      return (
        residencyHandlers.promoteDraftBrowserTabs?.({
          tabIds: payload.tabIds.map((tabId) => nonEmptyStringSchema.parse(tabId)),
          workspaceKey: nonEmptyStringSchema.parse(payload.workspaceKey),
          sessionId: nonEmptyStringSchema.parse(payload.sessionId),
          ...(payload.remoteSessionId
            ? { remoteSessionId: nonEmptyStringSchema.parse(payload.remoteSessionId) }
            : {}),
          windowId: win.id,
        }) ?? []
      );
    },
  );

  ipcMain.handle(
    PlatformChannels.BrowserViewSuspendReady,
    async (event, payload: { tabId: string; generation: number }) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || win.isDestroyed()) return;
      await residencyHandlers.acknowledgeBrowserTabSuspend?.({
        tabId: nonEmptyStringSchema.parse(payload.tabId),
        generation: Number(payload.generation),
        windowId: win.id,
      });
    },
  );

  ipcMain.handle(
    PlatformChannels.BrowserViewEnsureResident,
    async (event, payload: BrowserViewCloseTabRequest) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || win.isDestroyed()) return;
      await residencyHandlers.ensureBrowserTabResident?.({
        ...parseBrowserTabScope(payload),
        windowId: win.id,
      });
    },
  );

  ipcMain.handle(
    PlatformChannels.BrowserViewRestoreTabs,
    async (event, payload: BrowserViewRestoreTabsRequest) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || win.isDestroyed()) return [];
      return (
        (await residencyHandlers.restoreBrowserTabs?.({
          workspaceKey: nonEmptyStringSchema.parse(payload.workspaceKey),
          ...(payload.remoteSessionId
            ? {
                remoteSessionId: nonEmptyStringSchema.parse(payload.remoteSessionId),
              }
            : {}),
          ...(payload.sessionId
            ? { sessionId: nonEmptyStringSchema.parse(payload.sessionId) }
            : {}),
          windowId: win.id,
        })) ?? []
      );
    },
  );
}

export function registerDesktopBrowserIpcHandlers(
  attachBrowserGuest: AttachBrowserGuest | undefined,
  updateBrowserGuestViewport: UpdateBrowserGuestViewport | undefined,
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  },
  reportBrowserScreenshotSurfaceReady?: ReportBrowserScreenshotSurfaceReady,
  residencyHandlers?: BrowserViewResidencyIpcHandlers,
) {
  registerBrowserViewIpcHandlers(
    attachBrowserGuest,
    updateBrowserGuestViewport,
    reportBrowserScreenshotSurfaceReady,
    residencyHandlers,
  );
  registerBrowserDataIpcHandlers(logger);
}

function parseBrowserTabScope(payload: BrowserViewCloseTabRequest): BrowserViewCloseTabRequest {
  return {
    tabId: nonEmptyStringSchema.parse(payload.tabId),
    workspaceKey: nonEmptyStringSchema.parse(payload.workspaceKey),
    sessionId: nonEmptyStringSchema.parse(payload.sessionId),
    ...(payload.remoteSessionId
      ? { remoteSessionId: nonEmptyStringSchema.parse(payload.remoteSessionId) }
      : {}),
  };
}
