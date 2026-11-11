import { z } from "zod";
import { resolveOptionalZCodeAuthorization, type ZCodeJwtTokenResolver } from "@zcode/shared";
import { decodeZCodeBuiltinRelease, type ZCodeBuiltinRelease } from "./zcode-builtin-release.js";

const clientConfigSchema = z
  .object({
    code: z.literal(0),
    data: z
      .object({
        configs: z
          .object({
            builtin_provider_config_json: z
              .string()
              .url()
              .refine((value) => {
                const url = new URL(value);
                // 内网和测试部署也会提供 HTTP 配置地址；协议准入不按产品环境区分。
                return (
                  (url.protocol === "https:" || url.protocol === "http:") &&
                  !url.username &&
                  !url.password
                );
              })
              .optional(),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

export interface ZCodeBuiltinDownloadOptions {
  readonly endpointOrigin: string;
  readonly appVersion: string;
  readonly platform: string;
  readonly request: (url: string | URL, init: RequestInit) => Promise<Response>;
  readonly signal?: AbortSignal;
  readonly resolveZcodeJwtToken?: ZCodeJwtTokenResolver;
}

/** App/CLI 共用下载边界。总预算包含两次请求正文，不依赖 ApiClient 的响应头超时。 */
export async function downloadZCodeBuiltinRelease(
  options: ZCodeBuiltinDownloadOptions,
): Promise<ZCodeBuiltinRelease | null> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 20_000);
  timer.unref?.();
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;
  let stage = "client-config";
  try {
    const url = new URL("/api/v1/client/configs", options.endpointOrigin);
    url.searchParams.set("app_version", options.appVersion);
    url.searchParams.set("platform", options.platform);
    const authorization = await resolveOptionalZCodeAuthorization(options.resolveZcodeJwtToken);
    const payload = clientConfigSchema.parse(await readJson(url, authorization));
    const downloadUrl = payload.data.configs.builtin_provider_config_json;
    if (downloadUrl === undefined) return null;
    stage = "cdn";
    return decodeZCodeBuiltinRelease(await readJson(new URL(downloadUrl)));
  } catch (error) {
    // 不能把带 query 的 URL、响应正文或 Schema 输入（可能含凭据）交给上层日志。
    const reason = signal.aborted
      ? timedOut
        ? "timeout"
        : "cancelled"
      : error instanceof DownloadBoundaryError
        ? error.message
        : error instanceof z.ZodError
          ? `invalid schema at ${error.issues[0]?.path.join(".") || "root"} (${error.issues[0]?.code})`
          : "invalid response";
    throw new Error(`ZCode Built-in ${stage}: ${reason}`);
  } finally {
    clearTimeout(timer);
  }

  async function readJson(url: URL, authorization?: string | null): Promise<unknown> {
    signal.throwIfAborted();
    // 只有第一跳配置请求接收可选登录头；CDN 调用不传入，避免向资源源站泄露 JWT。
    const response = await abortable(
      options
        .request(url, {
          method: "GET",
          signal,
          credentials: "omit",
          redirect: "error",
          ...(authorization ? { headers: { Authorization: authorization } } : {}),
        })
        .then((value) => {
          if (signal.aborted) {
            void value.body?.cancel().catch(() => {});
            signal.throwIfAborted();
          }
          return value;
        }),
      signal,
    );
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new DownloadBoundaryError(`HTTP ${response.status}`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new DownloadBoundaryError("empty body");
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const part = await abortable(reader.read(), signal);
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 10_000_000) throw new DownloadBoundaryError("body limit exceeded");
        chunks.push(decoder.decode(part.value, { stream: true }));
      }
      chunks.push(decoder.decode());
      signal.throwIfAborted();
      return JSON.parse(chunks.join("")) as unknown;
    } catch (error) {
      // cancel 不得成为新的无期限等待；释放 reader 后底层请求仍由同一 signal 取消。
      void reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
  }
}

class DownloadBoundaryError extends Error {}

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
