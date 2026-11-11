import {
  buildZCodeEndpointUrls,
  clientConfigReadOptionsSchema,
  parseClientConfigSnapshot,
  resolveOptionalZCodeAuthorization,
  type ApiClient,
  type ClientConfigSnapshot,
  type ZCodeJwtTokenResolver,
} from "@zcode/shared";
import type { IClientConfigService } from "./clientConfig.js";

const CACHE_TTL_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

interface RequestContext {
  endpointOrigin: string;
  appVersion: string;
  platform: string;
}

interface CacheEntry {
  snapshot?: ClientConfigSnapshot;
  expiresAt: number;
  pending?: Promise<ClientConfigSnapshot>;
}

/** 只返回已裁剪的配置；不同请求身份不共用快照或在飞请求。 */
export function createClientConfigService(dependencies: {
  apiClient: ApiClient;
  resolveRequestContext: () => RequestContext | Promise<RequestContext>;
  resolveZcodeJwtToken?: ZCodeJwtTokenResolver;
}): IClientConfigService {
  const entries = new Map<string, CacheEntry>();

  async function fetchSnapshot(
    url: URL,
    authorization: string | null,
  ): Promise<ClientConfigSnapshot> {
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
          return parseClientConfigSnapshot(await response.json());
        })(),
        timedOut,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
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
      const now = Date.now();
      // 身份切换会增加缓存项；清理已过期项，避免旧 JWT 和快照长期驻留。
      // 在飞项必须保留，避免同身份并发读取重复发出请求。
      for (const [cacheKey, cached] of entries) {
        if (!cached.pending && cached.expiresAt <= now) entries.delete(cacheKey);
      }
      // 登录、换号或退出后不能继续复用上一身份的配置响应。
      const key = JSON.stringify([url.toString(), authorization]);
      const entry = entries.get(key) ?? { expiresAt: 0 };
      entries.set(key, entry);
      if (!forceRefresh && entry.snapshot && entry.expiresAt > now) {
        return structuredClone(entry.snapshot);
      }
      if (!entry.pending) {
        entry.pending = fetchSnapshot(url, authorization)
          .then((snapshot) => {
            entry.snapshot = snapshot;
            entry.expiresAt = Date.now() + CACHE_TTL_MS;
            return snapshot;
          })
          .finally(() => {
            entry.pending = undefined;
          });
      }
      return structuredClone(await entry.pending);
    },
  };
}
