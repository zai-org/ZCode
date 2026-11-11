import { normalizeRemoteConnectionError } from "@zcode/shared";
/* eslint-disable max-lines -- 远程连接、OAuth 回调、遥测和通知 IPC 共用窗口级上下文，集中注册避免跨文件状态漂移。 */
import { app, BrowserWindow, ipcMain, shell, type WebContents } from "electron";
import armsRum from "@arms/rum-electron";
import {
  armsCustomEventPayloadSchema,
  buildRemoteWorkspaceConnectResultTelemetry,
  classifyRemoteUsageError,
  formatZodError,
  hostRemoteWorkspaceConnectFailedResponseSchema,
  normalizeUnknownError,
  InternalChannels,
  isPublicZCodeErrorCode,
  isTrustedCodingPlanWebviewOrigin,
  PlatformChannels,
  remoteTargetSchema,
  rendererTelemetryEventPayloadSchema,
  telemetryRendererContextSchema,
  type ArmsRumEnv,
  type BindRemoteWorkspaceSessionContextIpcResult,
  type RemoteTarget,
  type WindowHostRemoteWorkspaceDescriptor,
  type BindRemoteWorkspaceSessionContextResult,
  type TelemetryEventPayload,
} from "@zcode/shared";
import { dispatchExtensionNotification, dispatchTaskNotification } from "./desktopNotifications.js";
import {
  clearOAuthRoutesForWindow,
  deliverPendingDeepLink,
  parseOAuthStateRegistration,
  registerOAuthState,
} from "./desktopOAuthDeepLink.js";
import {
  dispatchFinalArmsCustomEvent,
  enableSharedFinalArmsCustomEventE2EController,
} from "./desktopArmsCustomEvent.js";
import {
  configureRemoteUsageArmsTelemetry,
  reportRemoteConnectResultToArms,
  type RemoteConnectionStats,
} from "./desktopRemoteUsageArmsTelemetry.js";
import {
  registerWebRemoteControlIpcHandlers,
  type WebRemoteControlIpcManager,
} from "./desktopWebRemoteControlIpc.js";
import { openFileUrlInDefaultApp, openPathInDefaultApp } from "./desktopMainIpcHelpers.js";

function isPublicRemoteReasonCode(code: string | undefined): code is string {
  // Bug 原因：前缀 OR 形成第二份公开码真源，任何内部 source-server-* 字符串都会穿透
  // Main 暴露给 Renderer。公开边界只消费 shared 登记表，新增码必须先进入统一合同。
  return isPublicZCodeErrorCode(code);
}

function readRetryable(error: unknown): boolean | undefined {
  if (!error || typeof error !== "object" || !("retryable" in error)) return undefined;
  return typeof error.retryable === "boolean" ? error.retryable : undefined;
}

function toBindIpcFailure(error: unknown): BindRemoteWorkspaceSessionContextIpcResult {
  const normalized = normalizeUnknownError(error);
  const reasonCode = isPublicRemoteReasonCode(normalized.code) ? normalized.code : undefined;
  const retryable = reasonCode ? readRetryable(error) : undefined;
  return {
    success: false,
    error: normalized.message,
    ...(reasonCode ? { reasonCode } : {}),
    ...(retryable !== undefined ? { retryable } : {}),
  };
}

/**
 * Bug 原因：Error 的 message/stack 不可枚举，直接交给 logger 会序列化成 `{}`，现场日志只剩
 * "detect failed: {}"，看不到 wsl.exe / docker 的退出码与输出。展开成普通对象再记录。
 */
function describeDiscoveryError(error: unknown): Record<string, unknown> {
  const normalized = normalizeUnknownError(error);
  const exitCode =
    error && typeof error === "object" && "exitCode" in error ? error.exitCode : undefined;
  return {
    name: error instanceof Error ? error.name : undefined,
    message: normalized.message,
    code: normalized.code,
    exitCode,
    stack: error instanceof Error ? error.stack : undefined,
  };
}

export function isAllowedExternalOpenUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "file:";
  } catch {
    return false;
  }
}

interface OpenExternalRequest {
  sourceUrl?: string;
  url: string;
}

function parseOpenExternalRequest(payload: unknown): OpenExternalRequest | null {
  if (typeof payload === "string") {
    return { url: payload };
  }
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.url !== "string") {
    return null;
  }
  return {
    sourceUrl: typeof record.sourceUrl === "string" ? record.sourceUrl : undefined,
    url: record.url,
  };
}

const CODING_PLAN_ZAI_PAYPAL_RELAY_HOSTS = new Set(["api.z.ai", "api.z.ai"]);

function isPaypalHostname(hostname: string): boolean {
  return hostname === "paypal.com" || hostname.endsWith(".paypal.com");
}

function isCodingPlanPaypalNavigationUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    if (isPaypalHostname(parsed.hostname)) return true;
    return (
      CODING_PLAN_ZAI_PAYPAL_RELAY_HOSTS.has(parsed.hostname) &&
      parsed.pathname.startsWith("/api/pay/paypal/")
    );
  } catch {
    return false;
  }
}

function isCodingPlanWebviewUrl(src: string | undefined): boolean {
  if (!src) return false;
  try {
    const url = new URL(src);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (
      !isTrustedCodingPlanWebviewOrigin(url.origin, {
        e2eStoreBridgeEnabled: process.env.VITE_ZCODE_E2E_STORE_BRIDGE === "1",
      })
    ) {
      return false;
    }
    if (!url.pathname.includes("coding-plan")) return false;
    return url.searchParams.get("embedded") === "app";
  } catch {
    return false;
  }
}

function isCodingPlanPaymentCallbackUrl(src: string | undefined): boolean {
  if (!src) return false;
  try {
    const url = new URL(src);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (
      !isTrustedCodingPlanWebviewOrigin(url.origin, {
        e2eStoreBridgeEnabled: process.env.VITE_ZCODE_E2E_STORE_BRIDGE === "1",
      })
    ) {
      return false;
    }
    if (!url.pathname.endsWith("/coding-plan/payment/callback")) return false;
    const returnTo = url.searchParams.get("returnTo");
    if (!returnTo) return false;
    const target = new URL(returnTo, url.origin);
    return target.origin === url.origin && isCodingPlanWebviewUrl(target.toString());
  } catch {
    return false;
  }
}

function isAllowedCodingPlanEmbeddedNavigationUrl(url: string): boolean {
  return (
    isCodingPlanWebviewUrl(url) ||
    isCodingPlanPaypalNavigationUrl(url) ||
    isCodingPlanPaymentCallbackUrl(url)
  );
}

function shouldKeepCodingPlanOpenExternalInWebview(currentUrl: string, targetUrl: string): boolean {
  return (
    (isCodingPlanWebviewUrl(currentUrl) || isCodingPlanPaypalNavigationUrl(currentUrl)) &&
    isAllowedCodingPlanEmbeddedNavigationUrl(targetUrl)
  );
}

export function registerRemoteIpcHandlers(options: {
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  appTelemetryRuntime: {
    onRendererReady(payload: { hasPendingOAuthCallback: boolean; rendererId: number }): void;
    syncRendererContext(payload: { rendererId: number; context: unknown }): void;
    onOAuthCallbackHandled(payload: { rendererId: number }): void;
  };
  /** OAuth 回调处理完成后的额外副作用（如刷新 ARMS user.id）；不影响既有 runtime 流程 */
  onOAuthCallbackHandledSideEffect?: () => void;
  appTelemetryCore: {
    reportEvent(payload: unknown): Promise<void>;
  };
  reportRemoteUsageEvent: (rendererId: number, event: TelemetryEventPayload) => void;
  armsCustomContext: {
    deviceMid: string;
    platform: NodeJS.Platform;
    appVersion: string;
    armsEnv: ArmsRumEnv;
  };
  /** 仅由 VITE_ZCODE_E2E_STORE_BRIDGE + test runner 双门禁打开。 */
  finalArmsCustomEventE2EEnabled?: boolean;
  webRemoteControlManager: WebRemoteControlIpcManager;
  createRemoteWorkspaceSession: (
    win: BrowserWindow,
    target: RemoteTarget,
    requestId?: string,
    context?: {
      workspacePath?: string;
      workspaceIdentity?: string;
      confirmSourceServerInstall?: boolean;
    },
    lifecycle?: {
      remoteUsageTelemetryEligible?: boolean;
      onConnected?: (descriptor: WindowHostRemoteWorkspaceDescriptor) => void;
    },
  ) => Promise<string>;
  getRemoteConnectionStats: () => RemoteConnectionStats;
  disposeRemoteWorkspaceSession: (
    sessionId: string,
    reason: string,
    signalGracePeriodMs?: number,
  ) => void;
  cancelPendingRemoteWorkspaceSessionsForWindow: (
    wcId: number,
    reason: string,
    requestId?: string,
  ) => void;
  bindRemoteWorkspaceSessionContext: (
    sessionId: string,
    context: {
      workspacePath: string;
      workspaceIdentity?: string;
      workspacePurpose?: import("@zcode/shared").WorkspacePurpose;
    },
    expectedWebContentsId?: number,
  ) => Promise<BindRemoteWorkspaceSessionContextResult>;
  confirmRendererAttachmentReady: (
    webContentsId: number,
    payload: { sessionId: string; attachmentId: string },
  ) => void;
  attachSourceSettings?: (sender: WebContents, sourceServerId: string) => { attachmentId: string };
  isDockerDaemonAvailable: () => Promise<boolean>;
  listAvailableWSLDistros: () => Promise<unknown[]>;
  listAvailableDockerContainers: () => Promise<unknown[]>;
  listSSHConfigAliases: () => Promise<unknown[]>;
}) {
  function reportRemoteUsageEvent(rendererId: number, event: TelemetryEventPayload): void {
    try {
      options.reportRemoteUsageEvent(rendererId, event);
    } catch (error) {
      // 埋点是旁路能力，不能把已成功的远程连接改写成业务失败。
      options.logger.warn("[remote-usage-telemetry] dispatch failed", {
        elementName: event.elementName,
        error,
      });
    }
  }

  const finalArmsCustomEventE2E = options.finalArmsCustomEventE2EEnabled
    ? enableSharedFinalArmsCustomEventE2EController()
    : null;

  configureRemoteUsageArmsTelemetry({
    armsCustomContext: options.armsCustomContext,
    getRemoteConnectionStats: options.getRemoteConnectionStats,
    sendCustom: (payload) =>
      armsRum.sendCustom(payload as Parameters<typeof armsRum.sendCustom>[0]),
    e2eController: finalArmsCustomEventE2E,
    logger: options.logger,
  });

  function reportRemoteConnectResultToArmsSafely(
    params: Parameters<typeof reportRemoteConnectResultToArms>[0],
  ): void {
    try {
      reportRemoteConnectResultToArms(params);
    } catch (error) {
      options.logger.warn("[remote-usage-arms] connect result reporter failed", { error });
    }
  }

  ipcMain.on(InternalChannels.ScopedServicePortReady, (event, rawPayload: unknown) => {
    if (!rawPayload || typeof rawPayload !== "object") return;
    const payload = rawPayload as {
      sessionId?: unknown;
      attachmentId?: unknown;
    };
    const sessionId = typeof payload.sessionId === "string" ? payload.sessionId.trim() : "";
    const attachmentId =
      typeof payload.attachmentId === "string" ? payload.attachmentId.trim() : "";
    if (!sessionId || !attachmentId) return;
    options.confirmRendererAttachmentReady(event.sender.id, {
      sessionId,
      attachmentId,
    });
  });
  if (finalArmsCustomEventE2E) {
    ipcMain.handle(PlatformChannels.ReadFinalArmsCustomEventsE2E, () =>
      finalArmsCustomEventE2E.read(),
    );
    ipcMain.handle(PlatformChannels.ClearFinalArmsCustomEventsE2E, () => {
      finalArmsCustomEventE2E.clear();
    });
    ipcMain.handle(
      PlatformChannels.ConfigureFinalArmsCustomEventsE2E,
      (_event, request: unknown) => {
        finalArmsCustomEventE2E.configure(
          request as Parameters<typeof finalArmsCustomEventE2E.configure>[0],
        );
      },
    );
  }

  registerWebRemoteControlIpcHandlers({
    reportRemoteUsageEvent,
    webRemoteControlManager: options.webRemoteControlManager,
  });

  ipcMain.on(PlatformChannels.OAuthRegisterState, (event, payload: unknown) => {
    const registration = parseOAuthStateRegistration(payload);
    if (!registration) {
      options.logger.warn("[oauth-register-state] invalid payload", payload);
      return;
    }

    registerOAuthState(event.sender.id, registration);
  });

  ipcMain.on(PlatformChannels.OpenExternal, (event, payload: unknown) => {
    const request = parseOpenExternalRequest(payload);
    if (!request) {
      options.logger.warn("[open-external] blocked unsupported request", payload);
      return;
    }
    const { url } = request;
    if (!isAllowedExternalOpenUrl(url)) {
      options.logger.warn("[open-external] blocked unsupported url", url);
      return;
    }
    if (new URL(url).protocol === "file:") {
      void openFileUrlInDefaultApp(url, options.logger);
      return;
    }
    const sender = event.sender;
    const senderUrl = typeof sender?.getURL === "function" ? sender.getURL() : "";
    const senderFrameUrl =
      typeof event.senderFrame?.url === "string" ? event.senderFrame.url : undefined;
    const sourceUrl = senderFrameUrl ?? request.sourceUrl ?? senderUrl;
    if (
      typeof sender?.loadURL === "function" &&
      shouldKeepCodingPlanOpenExternalInWebview(sourceUrl, url)
    ) {
      // 官网 embedded bridge 的 openExternal 会绕过 webview 导航守卫；
      // PayPal 授权完成后的可信回调仍需回到当前 webview，不能拉起系统默认浏览器。
      void sender.loadURL(url).catch((error: unknown) => {
        options.logger.warn("[open-external] failed to load coding-plan callback in webview", {
          error: error instanceof Error ? error.message : String(error),
          url,
        });
      });
      return;
    }
    void Promise.resolve(shell.openExternal(url)).catch((error: unknown) => {
      options.logger.warn("[open-external] 外部 URL 打开失败", {
        url,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });

  ipcMain.handle(PlatformChannels.OpenExternalFile, async (_event, rawPath: string) =>
    openPathInDefaultApp(rawPath, options.logger),
  );

  ipcMain.on(PlatformChannels.RendererReady, (event) => {
    const hasPendingOAuthCallback = deliverPendingDeepLink(event.sender);
    options.appTelemetryRuntime.onRendererReady({
      hasPendingOAuthCallback,
      rendererId: event.sender.id,
    });
  });

  ipcMain.on(PlatformChannels.SyncTelemetryContext, (event, context: unknown) => {
    const result = telemetryRendererContextSchema.safeParse(context);
    if (!result.success) return;
    options.appTelemetryRuntime.syncRendererContext({
      rendererId: event.sender.id,
      context: result.data,
    });
  });

  ipcMain.handle(PlatformChannels.ReportTelemetryEvent, async (_event, payload: unknown) => {
    const result = rendererTelemetryEventPayloadSchema.safeParse(payload);
    if (!result.success) {
      options.logger.warn(
        "[report-telemetry-event] invalid payload:",
        formatZodError(result.error),
      );
      return;
    }

    await options.appTelemetryCore.reportEvent(result.data);
  });

  ipcMain.handle(PlatformChannels.ReportArmsCustomEvent, async (event, payload: unknown) => {
    const result = armsCustomEventPayloadSchema.safeParse(payload);
    if (!result.success) {
      options.logger.warn(
        "[report-arms-custom-event] invalid payload:",
        formatZodError(result.error),
      );
      return;
    }

    try {
      dispatchFinalArmsCustomEvent({
        payload: result.data,
        context: {
          ...options.armsCustomContext,
          rendererId: event.sender.id,
        },
        e2eController: finalArmsCustomEventE2E,
        // FinalArmsCustomEventPayload 是 SDK RumCustomEvent 的收窄子集；SDK 额外要求
        // BaseObject 索引签名，但这里不会动态追加未声明字段。
        sendCustom: (payload) =>
          armsRum.sendCustom(payload as Parameters<typeof armsRum.sendCustom>[0]),
      });
    } catch (error) {
      options.logger.warn(
        "[report-arms-custom-event] sendCustom failed:",
        normalizeUnknownError(error).message,
      );
    }
  });

  ipcMain.on(PlatformChannels.OAuthCallbackHandled, (event) => {
    options.appTelemetryRuntime.onOAuthCallbackHandled({
      rendererId: event.sender.id,
    });
    options.onOAuthCallbackHandledSideEffect?.();
  });

  ipcMain.on(PlatformChannels.ShowTaskNotification, (event, payload: unknown) => {
    dispatchTaskNotification({ event, payload, logger: options.logger });
  });
  ipcMain.handle(PlatformChannels.ShowTaskNotification, (event, payload: unknown) =>
    dispatchTaskNotification({ event, payload, logger: options.logger }),
  );
  ipcMain.handle(PlatformChannels.ShowExtensionNotification, (event, payload: unknown) =>
    dispatchExtensionNotification({ event, payload, logger: options.logger }),
  );

  app.on("browser-window-created", (_, win) => {
    const windowWebContentsId = win.webContents.id;
    win.on("closed", () => {
      // BrowserWindow 的 closed 阶段里 webContents 可能已被 Electron 释放。
      // 之前这里直接读取 win.webContents.id，会把正常关窗流程变成主进程未捕获异常。
      // 提前缓存 id 后再做清理，避免访问已经销毁的对象。
      clearOAuthRoutesForWindow(windowWebContentsId);
    });
  });

  ipcMain.handle(PlatformChannels.ConnectRemote, async (event, rawPayload: unknown) => {
    const wrappedPayload: {
      target: unknown;
      requestId?: unknown;
      workspacePath?: unknown;
      workspaceIdentity?: unknown;
      connectTrigger?: unknown;
      confirmSourceServerInstall?: unknown;
    } =
      rawPayload && typeof rawPayload === "object" && "target" in rawPayload
        ? (rawPayload as {
            target: unknown;
            requestId?: unknown;
            workspacePath?: unknown;
            workspaceIdentity?: unknown;
            connectTrigger?: unknown;
            confirmSourceServerInstall?: unknown;
          })
        : { target: rawPayload, requestId: undefined };
    const result = remoteTargetSchema.safeParse(wrappedPayload.target);
    if (!result.success) {
      const error = `Invalid connect-remote payload: ${formatZodError(result.error)}`;
      options.logger.warn("[connect-remote]", error);
      return { success: false, error };
    }
    const requestId =
      typeof wrappedPayload.requestId === "string" && wrappedPayload.requestId.trim().length > 0
        ? wrappedPayload.requestId.trim()
        : undefined;
    const workspacePath =
      typeof wrappedPayload.workspacePath === "string" &&
      wrappedPayload.workspacePath.trim().length > 0
        ? wrappedPayload.workspacePath
        : undefined;
    const workspaceIdentity =
      typeof wrappedPayload.workspaceIdentity === "string" &&
      wrappedPayload.workspaceIdentity.trim().length > 0
        ? wrappedPayload.workspaceIdentity
        : undefined;
    const connectTriggerValue = wrappedPayload.connectTrigger;
    const connectTrigger =
      connectTriggerValue === "reconnect" || connectTriggerValue === "restore"
        ? connectTriggerValue
        : "new";
    const confirmSourceServerInstall = wrappedPayload.confirmSourceServerInstall === true;

    try {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) {
        throw new Error("未找到当前窗口，无法创建远程 session");
      }

      let reusedConnectionTarget: RemoteTarget | undefined;
      const sessionId = await options.createRemoteWorkspaceSession(
        win,
        result.data,
        requestId,
        workspacePath || confirmSourceServerInstall
          ? {
              workspacePath,
              workspaceIdentity,
              ...(confirmSourceServerInstall ? { confirmSourceServerInstall: true } : {}),
            }
          : undefined,
        {
          remoteUsageTelemetryEligible: true,
          onConnected: (descriptor) => {
            reusedConnectionTarget = descriptor.reusedConnectionTarget;
          },
        },
      );
      reportRemoteUsageEvent(
        event.sender.id,
        buildRemoteWorkspaceConnectResultTelemetry({
          result: "success",
          remoteKind: result.data.kind,
          connectTrigger,
        }),
      );
      reportRemoteConnectResultToArmsSafely({
        rendererId: event.sender.id,
        result: "success",
        remoteKind: result.data.kind,
        connectTrigger,
      });
      return {
        success: true,
        sessionId,
        ...(reusedConnectionTarget ? { reusedConnectionTarget } : {}),
      };
    } catch (error) {
      const normalizedError = normalizeRemoteConnectionError(error);
      const errorCategory = classifyRemoteUsageError(error);
      // 这里之前直接把 Error 对象交给 logger，落盘时会被 JSON.stringify 压成 `{}`。
      // 改成显式展开 message/code/stack，保证远程建连失败时主进程日志里能看到真实上下文。
      options.logger.error("[connect-remote] caught error:", {
        requestId,
        confirmSourceServerInstall,
        message: normalizedError.message,
        code: normalizedError.code,
        stack: error instanceof Error ? error.stack : undefined,
      });
      reportRemoteUsageEvent(
        event.sender.id,
        buildRemoteWorkspaceConnectResultTelemetry({
          result: "failure",
          remoteKind: result.data.kind,
          connectTrigger,
          errorCategory,
        }),
      );
      reportRemoteConnectResultToArmsSafely({
        rendererId: event.sender.id,
        result: "failure",
        remoteKind: result.data.kind,
        connectTrigger,
        errorCategory,
      });
      const reasonCode = isPublicRemoteReasonCode(normalizedError.code)
        ? normalizedError.code
        : undefined;
      const retryable = reasonCode ? readRetryable(error) : undefined;
      const profileId = hostRemoteWorkspaceConnectFailedResponseSchema.shape.profileId.safeParse(
        (reasonCode === "source-server-upgrade-required" ||
          reasonCode === "source-server-install-required") &&
          error &&
          typeof error === "object" &&
          "profileId" in error
          ? error.profileId
          : undefined,
      );
      const resolvedWslTarget =
        hostRemoteWorkspaceConnectFailedResponseSchema.shape.resolvedWslTarget.safeParse(
          (reasonCode === "source-server-install-required" ||
            reasonCode === "source-server-upgrade-required") &&
            error &&
            typeof error === "object" &&
            "resolvedWslTarget" in error
            ? error.resolvedWslTarget
            : undefined,
        );
      return {
        success: false,
        error: normalizedError.message,
        ...(reasonCode ? { reasonCode } : {}),
        ...(retryable !== undefined ? { retryable } : {}),
        ...(profileId.success && profileId.data ? { profileId: profileId.data } : {}),
        ...(resolvedWslTarget.success && resolvedWslTarget.data
          ? { resolvedWslTarget: resolvedWslTarget.data }
          : {}),
      };
    }
  });

  ipcMain.handle(PlatformChannels.RequestSourceSettingsAttachment, (event, rawPayload: unknown) => {
    const sourceServerId =
      rawPayload &&
      typeof rawPayload === "object" &&
      "sourceServerId" in rawPayload &&
      typeof rawPayload.sourceServerId === "string"
        ? rawPayload.sourceServerId.trim()
        : "";
    if (!sourceServerId) throw new Error("sourceServerId is required");
    if (!options.attachSourceSettings) {
      throw new Error("Source settings attachment is unavailable");
    }
    return options.attachSourceSettings(event.sender, sourceServerId);
  });

  ipcMain.handle(
    PlatformChannels.CancelPendingRemoteConnection,
    async (event, rawPayload: unknown) => {
      const payload =
        rawPayload && typeof rawPayload === "object" ? (rawPayload as { requestId?: unknown }) : {};
      const requestId =
        typeof payload.requestId === "string" && payload.requestId.trim().length > 0
          ? payload.requestId.trim()
          : undefined;
      // 连接建立前没有 sessionId，renderer 之前无法精准通知 main 取消正在进行的连接。
      // 现在优先按 requestId 精确取消当前弹窗发起的连接，避免误伤同窗口其他并发连接。
      // 若 requestId 缺失则回退到按窗口取消，兼容旧调用端。
      options.cancelPendingRemoteWorkspaceSessionsForWindow(
        event.sender.id,
        `cancel-pending-remote-connection:${event.sender.id}`,
        requestId,
      );
    },
  );

  ipcMain.handle(
    PlatformChannels.BindRemoteWorkspaceSessionContext,
    async (event, rawPayload: unknown): Promise<BindRemoteWorkspaceSessionContextIpcResult> => {
      try {
        if (!rawPayload || typeof rawPayload !== "object") {
          throw new Error("远程 workspace context payload 无效");
        }
        const payload = rawPayload as {
          remoteSessionId?: unknown;
          workspacePath?: unknown;
          workspaceIdentity?: unknown;
          workspacePurpose?: unknown;
        };
        const remoteSessionId =
          typeof payload.remoteSessionId === "string" ? payload.remoteSessionId.trim() : "";
        const workspacePath =
          typeof payload.workspacePath === "string" ? payload.workspacePath : "";
        const workspaceIdentity =
          typeof payload.workspaceIdentity === "string" ? payload.workspaceIdentity.trim() : "";
        const workspacePurpose =
          payload.workspacePurpose === "project" || payload.workspacePurpose === "conversation"
            ? payload.workspacePurpose
            : undefined;
        if (!remoteSessionId || !workspacePath.trim()) {
          throw new Error("远程 workspace context 缺少 sessionId 或 workspacePath");
        }
        const result = await options.bindRemoteWorkspaceSessionContext(
          remoteSessionId,
          {
            workspacePath,
            ...(workspaceIdentity ? { workspaceIdentity } : {}),
            ...(workspacePurpose ? { workspacePurpose } : {}),
          },
          event.sender.id,
        );
        return { success: true, result };
      } catch (error) {
        return toBindIpcFailure(error);
      }
    },
  );

  ipcMain.handle(PlatformChannels.DisposeRemoteSession, async (_event, sessionId: string) => {
    options.disposeRemoteWorkspaceSession(sessionId, `dispose-remote-session:${sessionId}`, 150);
  });

  ipcMain.handle(PlatformChannels.IsDockerAvailable, async () => {
    try {
      return await options.isDockerDaemonAvailable();
    } catch (error) {
      options.logger.warn("[is-docker-available] detect failed:", describeDiscoveryError(error));
      return false;
    }
  });

  ipcMain.handle(PlatformChannels.ListWSLDistros, async () => {
    try {
      return await options.listAvailableWSLDistros();
    } catch (error) {
      options.logger.warn("[list-wsl-distros] detect failed:", describeDiscoveryError(error));
      return [];
    }
  });

  ipcMain.handle(PlatformChannels.ListDockerContainers, async () => {
    try {
      return await options.listAvailableDockerContainers();
    } catch (error) {
      options.logger.warn("[list-docker-containers] detect failed:", describeDiscoveryError(error));
      return [];
    }
  });

  ipcMain.handle(PlatformChannels.ListSSHConfigAliases, async () => {
    try {
      return await options.listSSHConfigAliases();
    } catch (error) {
      const normalizedError = normalizeUnknownError(error);
      // Error 对象直接落盘会被序列化成 `{}`，SSH config 解析失败时无法定位具体 pattern。
      // 显式展开错误字段，保留 UI 返回空列表的兼容行为，同时让日志能看到根因。
      options.logger.warn("[list-ssh-config-aliases] detect failed:", {
        message: normalizedError.message,
        code: normalizedError.code,
        name: error instanceof Error ? error.name : undefined,
        stack: error instanceof Error ? error.stack : undefined,
      });
      return [];
    }
  });
}
