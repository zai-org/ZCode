import http from "node:http";
import https from "node:https";
import { ProxyAgent } from "proxy-agent";
import {
  loadTlsCaCertificates,
  resolveProxyUrlForRequest,
  resolveTlsCaCertFile,
} from "./http-config.js";
import { readIncomingResponse, toWebResponse } from "./incoming-response.js";

export type NetworkFetch = typeof globalThis.fetch;

interface NetworkProxyFetchOptions {
  caCertFile?: string;
  env?: Record<string, string | undefined>;
  fetch?: NetworkFetch;
  httpProxy?: string;
  noProxy?: string;
}

interface NormalizedFetchRequest {
  body?: Buffer;
  headers: Headers;
  method: string;
  signal?: AbortSignal | null;
  url: URL;
}

export function createNetworkProxyFetch(options: NetworkProxyFetchOptions): NetworkFetch {
  const directFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  if (!hasNetworkFetchPolicy(options)) {
    return directFetch;
  }

  let tlsCaCertificates: Buffer | undefined;
  let tlsCaCertificatesLoaded = false;

  const getTlsCaCertificates = (): Buffer | undefined => {
    if (!tlsCaCertificatesLoaded) {
      tlsCaCertificates = loadTlsCaCertificates(options);
      tlsCaCertificatesLoaded = true;
    }
    return tlsCaCertificates;
  };

  return async (input, init) => {
    const requestUrl = readFetchInputUrl(input);
    if (!requestUrl || (requestUrl.protocol !== "http:" && requestUrl.protocol !== "https:")) {
      return directFetch(input, init);
    }

    const proxyUrl = resolveProxyUrlForRequest(requestUrl, options);
    const caCertFile = resolveTlsCaCertFile(options);
    if (!proxyUrl && !caCertFile) {
      return directFetch(input, init);
    }

    const request = await normalizeFetchRequest(input, init);
    return fetchWithAgent(request, {
      ca: caCertFile ? getTlsCaCertificates() : undefined,
      proxyUrl,
    });
  };
}

function hasNetworkFetchPolicy(options: NetworkProxyFetchOptions): boolean {
  return Boolean(options.caCertFile || options.env || options.httpProxy || options.noProxy);
}

function readFetchInputUrl(input: Parameters<NetworkFetch>[0]): URL | undefined {
  try {
    if (input instanceof URL) {
      return input;
    }
    if (input instanceof Request) {
      return new URL(input.url);
    }
    return new URL(String(input));
  } catch {
    return undefined;
  }
}

async function normalizeFetchRequest(
  input: Parameters<NetworkFetch>[0],
  init: Parameters<NetworkFetch>[1],
): Promise<NormalizedFetchRequest> {
  const request = new Request(input, init);
  const method = request.method.toUpperCase();
  const arrayBuffer =
    method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer();
  const body = arrayBuffer && arrayBuffer.byteLength > 0 ? Buffer.from(arrayBuffer) : undefined;

  return {
    body,
    headers: request.headers,
    method,
    // 临时 Request 的 controller 可被 GC，不能把其从属 signal 留作取消来源。
    signal:
      init?.signal !== undefined
        ? init.signal
        : input instanceof Request
          ? input.signal
          : undefined,
    url: new URL(request.url),
  };
}

function fetchWithAgent(
  request: NormalizedFetchRequest,
  options: { ca?: Buffer; proxyUrl?: string },
): Promise<Response> {
  const transport = request.url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const signal = request.signal ?? undefined;
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }

    let settled = false;
    let responseMessage: http.IncomingMessage | undefined;
    let clientRequest: http.ClientRequest | undefined;

    const cleanupAll = (): void => {
      signal?.removeEventListener("abort", onAbort);
      clientRequest?.off("close", onRequestClose);
      responseMessage?.off("close", cleanupAll);
      responseMessage?.off("error", onResponseError);
    };
    const rejectOnce = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanupAll();
      reject(error);
    };
    const onRequestError = (error: Error): void => {
      rejectOnce(error);
    };
    const onRequestClose = (): void => {
      if (!responseMessage && settled) cleanupAll();
    };
    const onResponseError = (): void => {
      // The web Response body receives the stream error through Readable.toWeb;
      // this listener only prevents Node from treating abort destroy as unhandled.
    };
    const onAbort = (): void => {
      const error = abortReason(signal);
      responseMessage?.destroy(error);
      clientRequest?.destroy(error);
      if (!settled) {
        settled = true;
        reject(error);
      }
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    clientRequest = transport.request(
      {
        agent: createRequestAgent(request.url, { ...options, signal }),
        headers: headersToOutgoing(request.headers),
        hostname: request.url.hostname,
        method: request.method,
        path: `${request.url.pathname}${request.url.search}`,
        port: request.url.port || undefined,
        protocol: request.url.protocol,
      },
      (message) => {
        responseMessage = message;
        responseMessage.once("close", cleanupAll);
        responseMessage.once("error", onResponseError);
        // 回调里抛出的东西没人接得住、会打死整个 agent 进程（network/incoming-response.ts）：
        // 表示不了的状态码只让这一次请求失败。
        let response: Response;
        try {
          response = toWebResponse(readIncomingResponse(message));
        } catch (error) {
          message.destroy();
          rejectOnce(error);
          return;
        }
        settled = true;
        resolve(response);
      },
    );

    // 响应读完后 MCP 会立即取消代理连接，底层 socket 与 TLS 可在请求 close 后各转发一次错误。
    // 监听随请求对象回收，不能提前移除或只监听一次，否则单次 MCP 失败会带崩 Agent。
    clientRequest.on("error", onRequestError);
    clientRequest.once("close", onRequestClose);
    clientRequest.end(request.body);
  });
}

function abortReason(signal: AbortSignal | undefined): Error {
  if (signal?.reason instanceof Error) {
    return signal.reason;
  }

  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function createRequestAgent(
  url: URL,
  options: { ca?: Buffer; proxyUrl?: string; signal?: AbortSignal },
): http.Agent | https.Agent | ProxyAgent {
  if (options.proxyUrl) {
    return new ProxyAgent({
      ca: options.ca,
      // CONNECT 返回前 socket 尚未归属 ClientRequest，取消必须抵达建连层。
      signal: options.signal,
      getProxyForUrl: () => options.proxyUrl ?? "",
      httpsAgent: options.ca ? new https.Agent({ ca: options.ca }) : undefined,
    }) as unknown as http.Agent;
  }

  if (url.protocol === "https:") {
    return new https.Agent({ ca: options.ca });
  }
  return new http.Agent();
}

function headersToOutgoing(headers: Headers): http.OutgoingHttpHeaders {
  const outgoing: http.OutgoingHttpHeaders = {};
  headers.forEach((value, key) => {
    outgoing[key] = value;
  });
  return outgoing;
}
