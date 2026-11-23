import {
  buildZCodeEndpointUrls,
  clientConfigReadOptionsSchema,
  parseClientConfigResponse,
  resolveOptionalZCodeAuthorization,
  type ApiClient,
  type ClientConfigResponse,
  type ClientConfigSnapshot,
  type ZCodeJwtTokenResolver,
} from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import type { IClientConfigService } from "./clientConfig.js";

const REQUEST_TIMEOUT_MS = 15_000;
// 过期快照仍可用时最多等待刷新这么久；接口挂起不能让草稿判定、插件商店等入口一直卡住。
const STALE_READ_WAIT_MS = 3_000;
// 有快照时刷新失败的重试间隔；接口故障期间每个上下文每分钟最多请求一次。
const FAILURE_RETRY_MS = 60_000;

const log = createServiceLogger("client-config");

interface RequestContext {
  endpointOrigin: string;
  appVersion: string;
  platform: string;
}

interface CacheEntry {
  snapshot?: ClientConfigSnapshot;
  /** 快照在此之前视为最新；时长取响应下发的刷新间隔。 */
  freshUntil: number;
  /** 有快照时刷新失败，在此之前直接返回旧快照，不再发请求。 */
  retryAfter: number;
  pending?: Promise<ClientConfigSnapshot>;
  /** 只在进入失败状态时记 warn，持续失败不刷屏。 */
  failing: boolean;
}

/** 只返回已裁剪的配置；不同请求身份不共用快照或在飞请求。 */
export function createClientConfigService(dependencies: {
  apiClient: ApiClient;
  resolveRequestContext: () => RequestContext | Promise<RequestContext>;
  resolveZcodeJwtToken?: ZCodeJwtTokenResolver;
}): IClientConfigService {
  const entries = new Map<string, CacheEntry>();

  async function fetchResponse(
    url: URL,
    authorization: string | null,
  ): Promise<ClientConfigResponse> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("Public client config request timed out"));
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
    });
    try {
      return await Promise.race([
        (async () => {
          const response = await dependencies.apiClient.request(url, {
            method: "GET",
            ...(authorization ? { headers: { Authorization: authorization } } : {}),
            credentials: "omit",
            redirect: "error",
            signal: controller.signal,
          });
          if (!response.ok) throw new Error(`Public client config HTTP ${response.status}`);
          // 设置中的 endpoint 可能在两次 await 之间变化；不能把新地址的响应缓存到旧地址。
          if (response.url && response.url !== url.toString()) {
            throw new Error("Public client config request context changed");
          }
          return parseClientConfigResponse(await response.json());
        })(),
        timedOut,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  function refresh(
    entry: CacheEntry,
    url: URL,
    authorization: string | null,
  ): Promise<ClientConfigSnapshot> {
    const pending = fetchResponse(url, authorization)
      .then(
        ({ snapshot, refreshIntervalMs }) => {
          entry.snapshot = snapshot;
          entry.freshUntil = Date.now() + refreshIntervalMs;
          entry.retryAfter = 0;
          if (entry.failing) {
            entry.failing = false;
            log.info(undefined, "公开客户端配置刷新已恢复", { refreshIntervalMs });
          }
          return snapshot;
        },
        (error: unknown) => {
          if (entry.snapshot) entry.retryAfter = Date.now() + FAILURE_RETRY_MS;
          const detail = {
            error: error instanceof Error ? error.message : String(error),
            hasSnapshot: Boolean(entry.snapshot),
          };
          if (entry.failing) log.debug(undefined, "公开客户端配置刷新仍失败", detail);
          else {
            entry.failing = true;
            log.warn(undefined, "公开客户端配置刷新失败，有快照时沿用旧快照", detail);
          }
          throw error;
        },
      )
      .finally(() => {
        if (entry.pending === pending) entry.pending = undefined;
      });
    entry.pending = pending;
    return pending;
  }

  return {
    async getSnapshot(options = {}) {
      const { forceRefresh } = clientConfigReadOptionsSchema.parse(options);
      const context = await dependencies.resolveRequestContext();
      const authorization = await resolveOptionalZCodeAuthorization(
        dependencies.resolveZcodeJwtToken,
      );
      const url = new URL(
        "/api/v1/client/configs",
        buildZCodeEndpointUrls(context.endpointOrigin).origin,
      );
      url.searchParams.set("app_version", context.appVersion);
      url.searchParams.set("platform", context.platform);
      // 登录、换号或退出后不能继续复用上一身份的配置响应。
      const key = JSON.stringify([url.toString(), authorization]);
      const now = Date.now();
      // 身份切换会增加缓存项；清理其他上下文的过期项，避免旧 JWT 和快照长期驻留。
      // 当前上下文的旧快照保留作失败兜底；在飞项保留，避免同身份并发读取重复请求。
      for (const [cacheKey, cached] of entries) {
        if (cacheKey !== key && !cached.pending && cached.freshUntil <= now)
          entries.delete(cacheKey);
      }
      const entry = entries.get(key) ?? { freshUntil: 0, retryAfter: 0, failing: false };
      entries.set(key, entry);
      const stale = entry.snapshot;
      if (!forceRefresh && stale && (entry.freshUntil > now || entry.retryAfter > now)) {
        return structuredClone(stale);
      }
      const request = entry.pending ?? refresh(entry, url, authorization);
      if (forceRefresh || !stale) return structuredClone(await request);
      // Bug 原因：旧实现过期即删除快照，接口一挂所有读取都拒绝，业务只能退回默认值。
      // 过期快照只等待刷新片刻；超时或失败返回旧快照，请求在后台继续并写回所属上下文。
      const refreshed = await settleWithin(request, STALE_READ_WAIT_MS);
      return structuredClone(refreshed ?? entry.snapshot ?? stale);
    },
  };
}

/** 在时限内取得结果；超时或失败返回 null，不取消原请求。 */
function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}
