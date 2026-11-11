import {
  ApiError,
  DEFAULT_ZCODE_ENDPOINT_ORIGIN,
  normalizeZCodeEndpointOrigin,
  rewriteZCodeEndpointUrl,
  type ApiClient,
  type ApiRequestInit,
} from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { buildZCodeSourceHeaders } from "../sourceHeaders.js";
import { withRequestIdHeader } from "./requestIdHeaders.js";

const log = createServiceLogger("node-api-client");

interface NodeApiClientOptions {
  fetchImpl?: typeof fetch;
  /** 仅返回已核实当前关联业务请求的刷新闭包；调用不得重放原业务请求。 */
  resolveAssociatedCredentialRefresh?: (
    input: string | URL,
    headers: Headers,
  ) => Promise<(() => Promise<void>) | null>;
  onZcodeJwtInvalid?: (input: string | URL, headers: Headers) => void;
  isZcodeJwtRequest?: (input: string | URL, headers: Headers) => boolean | Promise<boolean>;
  isBusinessUnauthorizedRequest?: (
    input: string | URL,
    headers: Headers,
  ) => boolean | Promise<boolean>;
  businessUnauthorizedObservationTimeoutMs?: number;
  resolveBusinessCredentialValidationRequest?: (
    input: string | URL,
    headers: Headers,
  ) => Promise<{ url: string; authorization: string; emptyBodyMeansInvalid: boolean } | null>;
  resolveZCodeEndpointOrigin?: () => Promise<string> | string;
  /** 宿主内存里的实时界面语言；同步读取，未注入或无值时 X-Client-Language 回退进程 Intl locale。 */
  resolveClientLanguage?: () => string | undefined;
}

const DEFAULT_BUSINESS_UNAUTHORIZED_OBSERVATION_TIMEOUT_MS = 1000;
const MAX_BUSINESS_UNAUTHORIZED_OBSERVATION_BYTES = 64 * 1024;

function waitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
    if (signal.aborted) {
      cleanup();
      abort();
    }
  });
}

function readChunkWithinTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  signal?: AbortSignal | null,
): Promise<{ done: boolean; value?: Uint8Array } | null> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  return waitWithAbort(Promise.race([reader.read(), timeout]), signal)
    .catch(() => null)
    .finally(() => clearTimeout(timer));
}

function resolveMethod(init?: ApiRequestInit): string {
  return (init?.method ?? "GET").toUpperCase();
}

function resolveUrl(input: string | URL): string {
  return typeof input === "string" ? input : input.toString();
}

async function readBusinessAuthenticationResponse(
  response: Response,
  timeoutMs: number,
  signal?: AbortSignal | null,
): Promise<"unauthorized" | "empty" | null> {
  // 业务接口把登录过期封装成 HTTP 200，不能只看 status；读副本避免抢走调用方正文。
  // continuous SSE 没有完整 JSON 正文，观察器不能等待流结束或引入恢复语义。
  if (response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream"))
    return null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    if (signal?.aborted) return null;
    const body = response.clone().body;
    if (!body) return "empty";
    reader = body.getReader();
    const decoder = new TextDecoder();
    const deadline = Date.now() + timeoutMs;
    let bytes = 0;
    let text = "";
    while (true) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return null;
      const result = await readChunkWithinTimeout(reader, remainingMs, signal);
      if (!result) return null;
      if (result.done) break;
      if (!result.value) return null;
      bytes += result.value.byteLength;
      if (bytes > MAX_BUSINESS_UNAUTHORIZED_OBSERVATION_BYTES) return null;
      text += decoder.decode(result.value, { stream: true });
    }
    text += decoder.decode();
    if (bytes === 0) return "empty";
    const payload: unknown = JSON.parse(text);
    return typeof payload === "object" &&
      payload !== null &&
      "code" in payload &&
      payload.code === 401
      ? "unauthorized"
      : null;
  } catch {
    // 空正文/HTML/损坏 JSON 只能证明请求异常，不能据此清理登录态。
    return null;
  } finally {
    // 观察副本是 best-effort；超时、超限或解析失败时及时取消，不能占用连接。
    if (reader) void reader.cancel().catch(() => undefined);
  }
}

function readHeaderKeys(headers: RequestInit["headers"] | undefined): string[] {
  if (!headers) {
    return [];
  }
  return [...new Headers(headers).keys()].sort();
}

function isRequestForEndpoint(input: string | URL, endpointOrigin: string): boolean {
  try {
    return new URL(resolveUrl(input)).origin === normalizeZCodeEndpointOrigin(endpointOrigin);
  } catch {
    return false;
  }
}

function withZCodeEndpointHeaders(
  headers: RequestInit["headers"] | undefined,
  endpointOrigin: string,
  clientLanguage: string | undefined,
): RequestInit["headers"] {
  const next = new Headers(buildZCodeSourceHeaders({ clientLanguage }));
  if (headers) {
    new Headers(headers).forEach((value, key) => {
      next.set(key, value);
    });
  }

  if (next.get("HTTP-Referer") === DEFAULT_ZCODE_ENDPOINT_ORIGIN) {
    next.set("HTTP-Referer", endpointOrigin);
  }
  return next;
}

function resolveRequestHeaders(
  requestInput: string | URL,
  headers: RequestInit["headers"] | undefined,
  endpointOrigin: string,
  clientLanguage: string | undefined,
): RequestInit["headers"] | undefined {
  if (!isRequestForEndpoint(requestInput, endpointOrigin)) {
    return headers;
  }

  // ZCode 后端请求以前只有部分业务路径手动补来源头。
  // 统一在 ApiClient 出口按 endpoint origin 注入，避免 OAuth/config/billing/snapshot 等链路遗漏。
  return withZCodeEndpointHeaders(headers, endpointOrigin, clientLanguage);
}

export class NodeApiClient implements ApiClient {
  private readonly fetchImpl?: typeof fetch;
  private readonly resolveAssociatedCredentialRefresh?: NodeApiClientOptions["resolveAssociatedCredentialRefresh"];
  private readonly resolveZCodeEndpointOrigin?: () => Promise<string> | string;
  private readonly resolveClientLanguage?: NodeApiClientOptions["resolveClientLanguage"];
  private readonly onZcodeJwtInvalid?: (input: string | URL, headers: Headers) => void;
  private readonly isZcodeJwtRequest?: NodeApiClientOptions["isZcodeJwtRequest"];
  private readonly isBusinessUnauthorizedRequest?: NodeApiClientOptions["isBusinessUnauthorizedRequest"];
  private readonly businessUnauthorizedObservationTimeoutMs: number;
  private readonly resolveBusinessCredentialValidationRequest?: NodeApiClientOptions["resolveBusinessCredentialValidationRequest"];
  private readonly businessValidations = new Map<
    string,
    {
      promise: Promise<boolean>;
      controller: AbortController;
      subscribers: number;
    }
  >();

  constructor(options: NodeApiClientOptions = {}) {
    this.fetchImpl = options.fetchImpl;
    this.resolveAssociatedCredentialRefresh = options.resolveAssociatedCredentialRefresh;
    this.onZcodeJwtInvalid = options.onZcodeJwtInvalid;
    this.isZcodeJwtRequest = options.isZcodeJwtRequest;
    this.isBusinessUnauthorizedRequest = options.isBusinessUnauthorizedRequest;
    this.resolveBusinessCredentialValidationRequest =
      options.resolveBusinessCredentialValidationRequest;
    this.businessUnauthorizedObservationTimeoutMs =
      options.businessUnauthorizedObservationTimeoutMs ??
      DEFAULT_BUSINESS_UNAUTHORIZED_OBSERVATION_TIMEOUT_MS;
    this.resolveZCodeEndpointOrigin = options.resolveZCodeEndpointOrigin;
    this.resolveClientLanguage = options.resolveClientLanguage;
  }

  private async confirmBusinessCredentialInvalid(
    input: string | URL,
    headers: Headers,
    response: Response,
    evidence: "unauthorized" | "empty" | null,
    signal?: AbortSignal | null,
  ): Promise<boolean> {
    if (signal?.aborted) return false;
    const check = await this.resolveBusinessCredentialValidationRequest?.(input, headers);
    if (!check || signal?.aborted) return false;
    const requestUrl = new URL(input),
      identityUrl = new URL(check.url);
    if (requestUrl.origin === identityUrl.origin && requestUrl.pathname === identityUrl.pathname)
      return response.status === 200 && evidence === "empty" && check.emptyBodyMeansInvalid;
    const key = JSON.stringify([check.url, check.authorization]);
    let entry = this.businessValidations.get(key);
    if (!entry) {
      const controller = new AbortController();
      const validationSignal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(this.businessUnauthorizedObservationTimeoutMs),
      ]);
      // 空定价/PAT响应或普通403不能直接登出。沿用 transport 核验身份，不递归触发观察器。
      const validation = Promise.resolve()
        .then(async () => {
          try {
            const identity = await waitWithAbort(
              (this.fetchImpl ?? globalThis.fetch)(check.url, {
                method: "GET",
                redirect: "error",
                headers: withRequestIdHeader({
                  Authorization: check.authorization,
                  "Content-Type": "application/json",
                }),
                signal: validationSignal,
              }),
              validationSignal,
            );
            if (identity.status === 401) return true;
            if (identity.status !== 200 && identity.status !== 403) return false;
            const result = await readBusinessAuthenticationResponse(
              identity,
              this.businessUnauthorizedObservationTimeoutMs,
              validationSignal,
            );
            return (
              result === "unauthorized" ||
              (identity.status === 200 && result === "empty" && check.emptyBodyMeansInvalid)
            );
          } catch {
            // 核验离线、超时或格式不明只能保留登录；不能用探测失败代替认证失效证据。
            return false;
          }
        })
        .finally(() => {
          if (this.businessValidations.get(key)?.promise === validation)
            this.businessValidations.delete(key);
        });
      entry = { promise: validation, controller, subscribers: 0 };
      this.businessValidations.set(key, entry);
    }
    entry.subscribers += 1;
    try {
      return await waitWithAbort(entry.promise, signal);
    } finally {
      // 核验曾独立等待，原请求取消后仍 pending 并可能登出；各订阅者独立收口，
      // 只有最后一个离开才取消共享 transport，避免影响仍在等待的并发请求。
      entry.subscribers -= 1;
      if (entry.subscribers === 0) {
        entry.controller.abort();
        if (this.businessValidations.get(key) === entry) this.businessValidations.delete(key);
      }
    }
  }

  async request(input: string | URL, init?: ApiRequestInit): Promise<Response> {
    const endpointOrigin = this.resolveZCodeEndpointOrigin
      ? await this.resolveZCodeEndpointOrigin()
      : undefined;
    const activeEndpointOrigin = endpointOrigin ?? DEFAULT_ZCODE_ENDPOINT_ORIGIN;
    const requestInput = rewriteZCodeEndpointUrl(input, activeEndpointOrigin);
    const url = resolveUrl(requestInput);
    const method = resolveMethod(init);
    const timeoutMs = init?.timeoutMs;
    const controller = timeoutMs && timeoutMs > 0 ? new AbortController() : null;
    let didTimeout = false;
    const timer =
      controller && timeoutMs
        ? setTimeout(() => {
            didTimeout = true;
            controller.abort();
          }, timeoutMs)
        : null;

    try {
      const signal = controller
        ? init?.signal
          ? AbortSignal.any([init.signal, controller.signal])
          : controller.signal
        : init?.signal;
      if (signal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      const fetchImpl = this.fetchImpl ?? globalThis.fetch;
      // X-Client-Language 曾取进程 Intl locale：从 Dock 启动时无 LANG 会回退 en-US，且不跟随界面语言。
      // 宿主注入内存中的实时界面语言；同步读取，不引入 I/O，不改变请求的取消与超时语义。
      const requestHeaders = withRequestIdHeader(
        resolveRequestHeaders(
          requestInput,
          init?.headers,
          activeEndpointOrigin,
          this.resolveClientLanguage?.(),
        ),
      );
      if (isRequestForEndpoint(requestInput, activeEndpointOrigin)) {
        // 调试说明：这里只记录 header key，避免 Authorization / token 等敏感值落盘。
        log.debug(undefined, "zcode endpoint request headers prepared", {
          headerKeys: readHeaderKeys(requestHeaders),
          method,
          url,
        });
      }
      const { authFailurePolicy, ...fetchInit } = init ?? {};
      let refreshAssociatedCredential: (() => Promise<void>) | null = null;
      if (authFailurePolicy !== "caller-handled" && this.resolveAssociatedCredentialRefresh) {
        try {
          // 网络前捕获归属；相同 token 在另一代登录中也不能接管旧请求的刷新。
          refreshAssociatedCredential = await waitWithAbort(
            this.resolveAssociatedCredentialRefresh(requestInput, new Headers(requestHeaders)),
            signal,
          );
        } catch {
          if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
          log.debug(undefined, "associated OAuth request classification did not complete");
        }
      }
      const response = await fetchImpl(requestInput, {
        ...fetchInit,
        headers: requestHeaders,
        ...(signal ? { signal } : {}),
      });
      if (refreshAssociatedCredential && [200, 401, 403].includes(response.status)) {
        // 只读响应副本，后台补关联。不等待 profile，也不重放付款/原请求或改写其错误。
        const evidence =
          response.status === 401
            ? Promise.resolve("unauthorized" as const)
            : readBusinessAuthenticationResponse(
                response,
                this.businessUnauthorizedObservationTimeoutMs,
                signal,
              );
        void evidence
          .then(async (result) => {
            if (result === "unauthorized" && !signal?.aborted) {
              await refreshAssociatedCredential();
              log.info(undefined, "associated OAuth rejection recovery completed");
            }
          })
          .catch(() => {
            log.debug(undefined, "associated OAuth profile refresh did not complete");
          });
      }
      if (
        authFailurePolicy !== "caller-handled" &&
        [200, 401, 403].includes(response.status) &&
        this.onZcodeJwtInvalid
      ) {
        try {
          await waitWithAbort(
            (async () => {
              const requestHeadersForObservation = new Headers(requestHeaders);
              const isCurrentZCodeJwtRequest = await this.isZcodeJwtRequest?.(
                requestInput,
                requestHeadersForObservation,
              );
              if (isCurrentZCodeJwtRequest) {
                let invalid = response.status === 401;
                if (
                  !invalid &&
                  (await this.isBusinessUnauthorizedRequest?.(
                    requestInput,
                    requestHeadersForObservation,
                  ))
                ) {
                  const evidence = await readBusinessAuthenticationResponse(
                    response,
                    this.businessUnauthorizedObservationTimeoutMs,
                    signal,
                  );
                  invalid = evidence === "unauthorized";
                  if (
                    !invalid &&
                    (response.status === 403 || (response.status === 200 && evidence === "empty"))
                  )
                    invalid = await this.confirmBusinessCredentialInvalid(
                      requestInput,
                      requestHeadersForObservation,
                      response,
                      evidence,
                      signal,
                    );
                }
                if (invalid && !signal?.aborted)
                  this.onZcodeJwtInvalid?.(requestInput, requestHeadersForObservation);
              }
            })(),
            signal,
          );
        } catch (error) {
          if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
          log.warn("zcode jwt invalid response observation failed", { error });
        }
      }
      if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
      return response;
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }

      if (error instanceof DOMException && error.name === "AbortError") {
        throw new ApiError({
          message:
            didTimeout && timeoutMs ? `Request timed out after ${timeoutMs}ms` : error.message,
          url,
          method,
          cause: error,
        });
      }

      const message = error instanceof Error ? error.message : String(error);
      throw new ApiError({
        message,
        url,
        method,
        cause: error,
      });
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }
}

export function createNodeApiClient(options: NodeApiClientOptions = {}): ApiClient {
  return new NodeApiClient(options);
}
