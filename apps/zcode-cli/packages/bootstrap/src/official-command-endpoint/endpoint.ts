/* 官方插件命令进程的本地代理端点（ZCode Sites 技术方案 5.8）。
   CLI 不持有任何登录凭证：它把请求发到这里，端点按 session token 认出 session，
   向 host 现取官方身份头补上，再转发给 zcode-server，响应原样返回。
   凭证只在本进程内存里用于这一次转发，不缓存、不落盘、不进 env、不进日志。
   这样即使 session token 泄漏，也只能在 agent 存活期间调用放行的接口，拿不到 JWT。 */
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  ZCODE_OFFICIAL_ENDPOINT_ENV_KEY,
  ZCODE_OFFICIAL_ENDPOINT_TOKEN_ENV_KEY,
} from "@zcode/shared";
import type {
  ExecutionPort,
  ExecutionRequest,
  ExecutionRunOptions,
  Logger,
  OfficialMcpAuthHeadersResult,
} from "@zcode/contracts";
import {
  supportsBackgroundTaskWaiter,
  supportsBashBackgroundLifecycle,
  type BackgroundTaskWaiterExecutionPort,
  type BashBackgroundLifecycleExecutionPort,
} from "@zcode/core";
import {
  OFFICIAL_COMMAND_ROUTES,
  OFFICIAL_ENDPOINT_ERROR_HEADER,
  type OfficialCommandEndpoint,
  type OfficialCommandEndpointOptions,
  type OfficialCommandSessionObserver,
  type OfficialCommandWorkspace,
} from "./contract.js";

// CLI 只能决定这几个头；身份、版本和其余头一律由端点决定，客户端带来的同名头不会传下去。
const FORWARDED_REQUEST_HEADERS = ["accept", "content-type", "content-length"] as const;
const SITE_DEPLOYMENT_CREATE_PATH = /^\/api\/v1\/sites\/[^/]+\/deployments$/;
// fetch 已经解压并按流读出响应体，这些头不能原样转回去。
const DROPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "set-cookie",
  "transfer-encoding",
]);

export function createOfficialCommandEndpoint(
  options: OfficialCommandEndpointOptions,
): OfficialCommandEndpoint {
  const platform = options.platform ?? process.platform;
  const tokenBySession = new Map<string, string>();
  const sessionByToken = new Map<string, string>();
  const workspaceBySession = new Map<string, OfficialCommandWorkspace>();
  const observerBySession = new Map<string, OfficialCommandSessionObserver>();
  let listening: Promise<{ address: string; server: Server; dir?: string }> | undefined;
  let closed = false;

  const listen = (): Promise<{ address: string; server: Server; dir?: string }> => {
    listening ??= (async () => {
      // UDS 放在只有当前用户可进的临时目录里；Windows 用随机名的命名管道。
      const dir =
        platform === "win32" ? undefined : await mkdtemp(join(tmpdir(), "zcode-official-"));
      const address = dir
        ? join(dir, "endpoint.sock")
        : `\\\\.\\pipe\\zcode-official-${process.pid}-${randomBytes(8).toString("hex")}`;
      const server = createServer((req, res) => {
        void handle(req, res);
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(address, () => {
          server.off("error", reject);
          resolve();
        });
      });
      options.logger?.info("Official command endpoint listening", {
        event: "zcode_protocol.official_command_endpoint.listening",
      });
      return { address, server, ...(dir ? { dir } : {}) };
    })();
    return listening;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const sessionId = sessionByToken.get(readBearerToken(req.headers.authorization) ?? "");
    if (!sessionId) {
      reject(res, 403, "invalid", "unknown session token");
      return;
    }
    const url = new URL(req.url ?? "/", "http://official-endpoint");
    const route = OFFICIAL_COMMAND_ROUTES.find(
      ({ prefix }) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`),
    );
    if (!route) {
      reject(res, 403, "invalid", `path is not allowed: ${url.pathname}`);
      return;
    }
    if (req.method === "POST" && SITE_DEPLOYMENT_CREATE_PATH.test(url.pathname)) {
      observerBySession.get(sessionId)?.onSiteDeploymentRequested();
    }

    // CLI 断开时停止向 host 取头和向上游转发。
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) abort.abort();
    });

    const origin = options.resolveZCodeApiOrigin();
    // host 按 workspace 把请求路由到本 CLI 拥有的工作区；共享 CLI 的进程 cwd 不是任何工作区，
    // 曾因此被 host 拒绝并误报为未登录。必须用发起命令的会话自己的 workspace。
    const workspace = workspaceBySession.get(sessionId)!;
    const auth = await options
      .resolveHeaders({
        pluginId: route.pluginId,
        targetOrigin: origin,
        workspace,
        signal: abort.signal,
      })
      .catch(
        (): OfficialMcpAuthHeadersResult => ({ ok: false, reason: "official_auth_unavailable" }),
      );
    if (!auth.ok) {
      // 没有登录身份时和 zcode-server 的未登录一样回 401，CLI 提示用户登录。
      if (auth.reason === "official_auth_unavailable") {
        res.writeHead(401, { [OFFICIAL_ENDPOINT_ERROR_HEADER]: "unauthenticated" }).end();
      } else {
        reject(res, 502, "auth", auth.reason);
      }
      options.logger?.info("Official command endpoint has no identity", {
        event: "zcode_protocol.official_command_endpoint.auth_unavailable",
        pluginId: route.pluginId,
        reason: auth.reason,
        sessionId,
      });
      return;
    }

    const headers = new Headers();
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = req.headers[name];
      if (typeof value === "string") headers.set(name, value);
    }
    for (const [name, value] of Object.entries(auth.headers)) headers.set(name, value);
    if (options.appVersion) headers.set("X-ZCode-App-Version", options.appVersion);

    const method = (req.method ?? "GET").toUpperCase();
    const hasBody = method !== "GET" && method !== "HEAD";
    let upstream: Response;
    try {
      upstream = await options.fetch(new URL(url.pathname + url.search, origin), {
        method,
        headers,
        redirect: "manual",
        signal: abort.signal,
        ...(hasBody
          ? { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: "half" }
          : {}),
      } as RequestInit);
    } catch (error) {
      if (abort.signal.aborted) return;
      options.logger?.warn("Official command endpoint cannot reach zcode-server", {
        error: error instanceof Error ? error.message : String(error),
        event: "zcode_protocol.official_command_endpoint.network_error",
        pluginId: route.pluginId,
      });
      reject(res, 502, "network", error instanceof Error ? error.message : String(error));
      return;
    }

    const responseHeaders: Record<string, string> = {};
    upstream.headers.forEach((value, name) => {
      if (!DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) responseHeaders[name] = value;
    });
    res.writeHead(upstream.status, responseHeaders);

    try {
      if (upstream.body) {
        for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
          if (!res.write(chunk)) await new Promise((resolve) => res.once("drain", resolve));
        }
      }
      res.end();
    } catch {
      // 上游中途断开：直接断开 CLI 的连接，让它看到不完整的响应，而不是一个正常结束的半截 body。
      res.destroy();
    }
  };

  return {
    async envForSession(sessionId, workspace, observer): Promise<Record<string, string>> {
      if (closed) return {};
      workspaceBySession.set(sessionId, workspace);
      if (observer) observerBySession.set(sessionId, observer);
      const { address } = await listen();
      let token = tokenBySession.get(sessionId);
      if (!token) {
        token = randomBytes(32).toString("base64url");
        tokenBySession.set(sessionId, token);
        sessionByToken.set(token, sessionId);
      }
      return {
        [ZCODE_OFFICIAL_ENDPOINT_ENV_KEY]: address,
        [ZCODE_OFFICIAL_ENDPOINT_TOKEN_ENV_KEY]: token,
      };
    },
    async close() {
      closed = true;
      tokenBySession.clear();
      sessionByToken.clear();
      workspaceBySession.clear();
      observerBySession.clear();
      if (!listening) return;
      const { server, dir } = await listening.catch(() => ({ server: undefined, dir: undefined }));
      if (server) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      if (dir) await rm(dir, { force: true, recursive: true });
    },
  };
}

function readBearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(\S+)$/i.exec(header?.trim() ?? "");
  return match?.[1];
}

/** 端点自己的错误沿用 zcode-server 的错误体，code 用 2007（上游错误），CLI 不用另写分支。 */
function reject(
  res: ServerResponse,
  status: number,
  kind: "auth" | "invalid" | "network",
  msg: string,
): void {
  res
    .writeHead(status, {
      "content-type": "application/json",
      [OFFICIAL_ENDPOINT_ERROR_HEADER]: kind,
    })
    .end(JSON.stringify({ code: 2007, msg, data: null, logid: "" }));
}

/**
 * 给一个 session 的执行端口补上官方命令端点的 env（地址 + 该 session 的 token）。
 * 只改请求的 env overlay；执行端口的全部能力按存在性透传，包括 ExecutionPort 接口之外的
 * 后台生命周期与后台等待。`base: "empty"` 的请求是有意的干净环境，不注入。
 * 端点不可用时照常执行，CLI 会按「未登录」报错。
 */
export function withOfficialCommandEnv(
  port: ExecutionPort,
  resolveEnv: () => Promise<Record<string, string>>,
  logger?: Pick<Logger, "warn">,
): ExecutionPort {
  const withEnv = async (request: ExecutionRequest): Promise<ExecutionRequest> => {
    if (request.env?.base === "empty") return request;
    const set = await resolveEnv().catch((error: unknown) => {
      logger?.warn("Official command endpoint env unavailable", {
        error: error instanceof Error ? error.message : String(error),
        event: "zcode_protocol.official_command_endpoint.env_unavailable",
      });
      return {};
    });
    if (Object.keys(set).length === 0) return request;
    return { ...request, env: { ...request.env, set: { ...request.env?.set, ...set } } };
  };
  const wrapped: ExecutionPort &
    Partial<BashBackgroundLifecycleExecutionPort> &
    Partial<BackgroundTaskWaiterExecutionPort> = {
    run: async (request, runOptions) => port.run(await withEnv(request), runOptions),
  };
  if (port.start) {
    const start = port.start.bind(port);
    wrapped.start = async (request, runOptions) => start(await withEnv(request), runOptions);
  }
  // 这两个能力都不在 ExecutionPort 接口里，由 core 按鸭子类型探测，漏传不会有类型错误：
  // 丢 runBashWithBackgroundLifecycle 时，显式后台 Bash 每次都抛 ConfigurationError
  // （bash.ts 的 "ExecutionPort does not support the Bash background lifecycle"），
  // 超时转后台也退回普通前台执行；丢 waitForBackgroundTask 时后台追踪退回 1 秒轮询，
  // 完成通知会晚于同一轮 tool-loop 的下一次模型请求。
  if (supportsBashBackgroundLifecycle(port)) {
    const runBash = port.runBashWithBackgroundLifecycle.bind(port);
    wrapped.runBashWithBackgroundLifecycle = async (request, lifecycle, runOptions) =>
      runBash(await withEnv(request), lifecycle, runOptions);
  }
  if (supportsBackgroundTaskWaiter(port)) {
    wrapped.waitForBackgroundTask = port.waitForBackgroundTask.bind(port);
  }
  if (port.getBackgroundTask) wrapped.getBackgroundTask = port.getBackgroundTask.bind(port);
  if (port.readBackgroundBashOutput) {
    wrapped.readBackgroundBashOutput = port.readBackgroundBashOutput.bind(port);
  }
  if (port.cancelBackgroundTask)
    wrapped.cancelBackgroundTask = port.cancelBackgroundTask.bind(port);
  if (port.close) wrapped.close = port.close.bind(port);
  // 修复原因：Bash 后台生命周期与后台等待者不在 ExecutionPort 契约内，core 按方法是否存在探测。
  // 之前包装层只转发契约方法，Desktop 注入端点 env 后 run_in_background 的 Bash 全部报
  // "ExecutionPort does not support the Bash background lifecycle"。这里按同样的探测转发，并给
  // 后台生命周期请求补上同一份端点 env。
  const optional = port as ExecutionPort & Partial<OptionalBackgroundExecutionMethods>;
  const wrappedOptional = wrapped as ExecutionPort & Partial<OptionalBackgroundExecutionMethods>;
  if (typeof optional.runBashWithBackgroundLifecycle === "function") {
    const runWithLifecycle = optional.runBashWithBackgroundLifecycle.bind(port);
    wrappedOptional.runBashWithBackgroundLifecycle = async (request, lifecycle, runOptions) =>
      runWithLifecycle(await withEnv(request), lifecycle, runOptions);
  }
  if (typeof optional.waitForBackgroundTask === "function") {
    wrappedOptional.waitForBackgroundTask = optional.waitForBackgroundTask.bind(port);
  }
  return wrapped;
}

/** core 通过方法是否存在探测的可选执行能力（Bash 后台生命周期与后台等待者）。 */
interface OptionalBackgroundExecutionMethods {
  runBashWithBackgroundLifecycle(
    request: ExecutionRequest,
    lifecycle: unknown,
    options?: ExecutionRunOptions,
  ): Promise<unknown>;
  waitForBackgroundTask(taskId: string, options?: unknown): Promise<unknown>;
}
