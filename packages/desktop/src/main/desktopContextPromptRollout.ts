import {
  buildZCodeEndpointUrls,
  buildZCodeSourceHeadersFromContext,
  resolveOptionalZCodeAuthorization,
  type ZCodeJwtTokenResolver,
  ZCODE_ENV,
  ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV,
} from "@zcode/shared";
import {
  createSingleFeatureRollout,
  type SingleFeatureRollout,
  type SingleFeatureRolloutLogger,
} from "./singleFeatureRollout.js";

export { ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV };

export type DesktopContextPromptRolloutLogger = SingleFeatureRolloutLogger;
export const DESKTOP_CONTEXT_PROMPT_REQUEST_TIMEOUT_MS = 3_000;
export const DESKTOP_CONTEXT_PROMPT_CACHE_TTL_MS = 60 * 60 * 1_000;
const DESKTOP_CONTEXT_PROMPT_MAX_RESPONSE_BYTES = 1024 * 1024;

export interface DesktopContextPromptConfig {
  enabled: boolean;
  configVersion?: string;
}

export type DesktopContextPromptRollout = SingleFeatureRollout<DesktopContextPromptConfig>;

export function resolveDesktopContextPromptConfig(
  payload: unknown,
): DesktopContextPromptConfig | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const envelope = payload as {
    code?: unknown;
    success?: unknown;
    data?: {
      configs?: {
        desktopContextPrompt?: {
          enabled?: unknown;
          config_version?: unknown;
        } | null;
      } | null;
    } | null;
  };
  if ((envelope.code !== undefined && envelope.code !== 0) || envelope.success === false) {
    return null;
  }
  const config = envelope.data?.configs?.desktopContextPrompt;
  if (config === undefined || config === null) {
    // 服务端成功响应但未下发该单功能配置，语义是未启用；不能继续沿用旧的开启快照。
    return { enabled: false };
  }
  if (typeof config?.enabled !== "boolean") {
    return null;
  }
  const configVersion =
    typeof config.config_version === "string" && config.config_version.trim().length > 0
      ? config.config_version.trim()
      : undefined;
  return {
    enabled: config.enabled,
    ...(configVersion ? { configVersion } : {}),
  };
}

export function createDesktopContextPromptRollout(options: {
  fetchConfig: (signal: AbortSignal) => Promise<unknown>;
  logger: DesktopContextPromptRolloutLogger;
  timeoutMs?: number;
  cacheTtlMs?: number;
}): DesktopContextPromptRollout {
  return createSingleFeatureRollout<DesktopContextPromptConfig>({
    resolveConfig: resolveDesktopContextPromptConfig,
    defaultValue: { enabled: false },
    logTag: "desktop-context-prompt",
    fetchConfig: options.fetchConfig,
    logger: options.logger,
    timeoutMs: options.timeoutMs,
    cacheTtlMs: options.cacheTtlMs,
  });
}

export function createElectronDesktopContextPromptConfigFetcher(options: {
  appVersion: string;
  deviceMid: string;
  resolveEndpointOrigin: () => Promise<string>;
  /** 当前界面语言；以前不传，X-Client-Language 固定为 unknown。 */
  getClientLanguage: () => string;
  resolveZcodeJwtToken?: ZCodeJwtTokenResolver;
}): (signal: AbortSignal) => Promise<unknown> {
  return async (signal) => {
    const { net } = await import("electron");
    const endpointOrigin = await options.resolveEndpointOrigin();
    const authorization = await resolveOptionalZCodeAuthorization(options.resolveZcodeJwtToken);
    signal.throwIfAborted();
    const url = new URL(`${buildZCodeEndpointUrls(endpointOrigin).origin}/api/v1/client/configs`);
    url.searchParams.set("app_version", options.appVersion);
    url.searchParams.set("platform", `${process.platform}-${process.arch}`);

    return await new Promise<unknown>((resolve, reject) => {
      const request = net.request(url.toString());
      // Chromium 可能复用匿名请求的公开 HTTP 缓存，导致登录后不发请求；要求每次向服务端校验。
      request.setHeader("Cache-Control", "no-cache");
      if (authorization) request.setHeader("Authorization", authorization);
      let responseBytes = 0;
      let body = "";
      let settled = false;

      function onAbort() {
        request.abort();
        settle(() => reject(new Error("desktop context prompt config aborted")));
      }

      const settle = (callback: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        callback();
      };
      signal.addEventListener("abort", onAbort, { once: true });

      const sourceHeaders = buildZCodeSourceHeadersFromContext({
        appVersion: options.appVersion,
        arch: process.arch,
        clientLanguage: options.getClientLanguage(),
        deviceMid: options.deviceMid,
        endpointOrigin,
        platform: process.platform,
        releaseChannel: ZCODE_ENV,
        sourceTitle: "electron",
      });
      for (const [name, value] of Object.entries(sourceHeaders)) {
        request.setHeader(name, value);
      }
      request.on("redirect", () => {
        settle(() => reject(new Error("desktop context prompt config redirect rejected")));
        request.abort();
      });
      request.on("response", (response) => {
        const statusCode = response.statusCode ?? 0;
        if (statusCode < 200 || statusCode >= 300) {
          settle(() => reject(new Error(`desktop context prompt config failed: ${statusCode}`)));
          request.abort();
          return;
        }
        response.on("data", (chunk: Buffer | string) => {
          responseBytes += Buffer.byteLength(chunk);
          if (responseBytes > DESKTOP_CONTEXT_PROMPT_MAX_RESPONSE_BYTES) {
            settle(() => reject(new Error("desktop context prompt config response too large")));
            request.abort();
            return;
          }
          body += chunk.toString();
        });
        response.on("end", () => {
          try {
            const parsed = JSON.parse(body);
            settle(() => resolve(parsed));
          } catch (error) {
            settle(() => reject(error instanceof Error ? error : new Error(String(error))));
          }
        });
        response.on("error", (error) => {
          settle(() => reject(error instanceof Error ? error : new Error(String(error))));
        });
      });
      request.on("error", (error) => {
        settle(() => reject(error instanceof Error ? error : new Error(String(error))));
      });
      request.end();
    });
  };
}
