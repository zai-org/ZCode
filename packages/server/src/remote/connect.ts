import { SocketProtocol, ChannelClient, ChannelServer, type IServerChannel } from "@zcode/rpc";
import type { IServiceAccessor } from "@zcode/services";
import { RemoteServiceAccess } from "@zcode/client";
import {
  SERVICE_AUTHORITY_MODE_ENV,
  TOPIC_RESOURCE_RELAY_CHANNEL,
  ZCODE_APP_VERSION_ENV,
  ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV,
  ZCODE_DYNAMIC_WORKFLOW_MODE_ENV,
  formatLogPrefix,
  ZCODE_REMOTE_HTTP_PROXY_ENV_KEY,
  ZCODE_REMOTE_NO_PROXY_ENV_KEY,
  ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY,
} from "@zcode/shared";
import type { IRemoteBackend } from "./backend.js";
import { wrapStdioStream } from "./stdio-socket.js";
import { performHandshake } from "./handshake.js";
import { deployServer } from "./deploy.js";
import type { DeployOptions } from "./deploy.js";
import { assertSupportedRemoteEnvironment } from "@zcode/server/remote/remotePlatformSupport.js";
import { quotePosixShellArg } from "./posixShell.js";
import { formatWslProxyForLog } from "./wslProxy.js";

const BACKEND_DISCONNECT_EXIT_CODE = -1;

export interface ConnectOptions extends DeployOptions {
  /** 仅 Desktop Host 注入，复用当前 stdio 的私有反向资源频道。 */
  topicResourceChannel?: IServerChannel;
  /** Client identifier for handshake */
  clientId?: string;
  /** Handshake timeout in ms (default: 10000) */
  handshakeTimeout?: number;
  /** Skip deploy step (assume server is already deployed) */
  skipDeploy?: boolean;
  /** 桌面 app 版本；用于透传给远端 agent，让模型请求 header 能标识发起方版本 */
  appVersion?: string;
  /** 远端 server/agent 需要继承的非敏感产品环境变量；调用方可传较宽的 env，server 侧会按白名单过滤。 */
  remoteRuntimeEnv?: Record<string, string | undefined>;
  /** Desktop Host 为 desktop-attached WSL server 提供的显式 Agent 网络配置。 */
  remoteRuntimeNetwork?: RemoteRuntimeNetworkOptions;
  /** 远端 stdio 关闭后的回调（用于上层感知断连并触发回收） */
  onDidRemoteClose?: (event: { code: number }) => void;
}

export interface RemoteRuntimeNetworkOptions {
  httpProxy?: string;
  noProxy?: string;
  /** 只允许 Host 设置权威值覆盖远端自身的旧设置。 */
  authoritative?: boolean;
}

export interface RemoteConnection {
  services: IServiceAccessor;
  client: ChannelClient;
  dispose(): void;
  disposeAndWait(options?: { timeoutMs?: number }): Promise<void>;
}

const REMOTE_RUNTIME_ENV_KEYS = [
  "ZCODE_ENV",
  "ZCODE_BASE_URL",
  "ZCODE_ENDPOINT_ORIGIN",
  "ZCODE_TEST_BASE_URL",
  "ZCODE_PRODUCTION_BASE_URL",
  "ZAI_OAUTH_ORIGIN",
  "ZAI_TEST_OAUTH_ORIGIN",
  "ZAI_PRODUCTION_OAUTH_ORIGIN",
  "ZAI_BUSINESS_BASE_URL",
  "ZAI_TEST_BUSINESS_BASE_URL",
  "ZAI_PRODUCTION_BUSINESS_BASE_URL",
  "ZAI_OAUTH_CLIENT_ID",
  "ZAI_TEST_OAUTH_CLIENT_ID",
  "ZAI_PRODUCTION_OAUTH_CLIENT_ID",
  // Desktop Main 已完成的单功能灰度结果；远端 server 只消费，不重新分桶。
  ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV,
  // 同上：本地覆盖由 Desktop Main 按构建档位写定（buildHostProcessEnv），
  // 透传后 SSH/WSL/Docker 远端 Host 与本地 Host 得到同一档位。
  ZCODE_DYNAMIC_WORKFLOW_MODE_ENV,
] as const;

export type RemoteRuntimeEnvKey = (typeof REMOTE_RUNTIME_ENV_KEYS)[number];
export type RemoteRuntimeEnv = Partial<Record<RemoteRuntimeEnvKey, string>>;

export function pickRemoteRuntimeEnv(env: Record<string, string | undefined>): RemoteRuntimeEnv {
  const picked: RemoteRuntimeEnv = {};
  for (const key of REMOTE_RUNTIME_ENV_KEYS) {
    const value = env[key]?.trim();
    if (value) {
      picked[key] = value;
    }
  }
  return picked;
}

function createRemoteConnectAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }
  const error = new Error("Remote connection canceled");
  error.name = "AbortError";
  return error;
}

function throwIfRemoteConnectAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw createRemoteConnectAbortError(signal);
  }
}

/**
 * Connect to a remote zcode server via an IRemoteBackend.
 *
 * Steps:
 * 1. detect() → { platform, arch }
 * 2. Deploy if needed (upload node + server bundle + node-pty)
 * 3. exec server command
 * 4. Handshake (read hello, send ack)
 * 5. Wrap stdio → ISocket → SocketProtocol → ChannelClient → RemoteServiceAccess
 */
export async function connectRemote(
  backend: IRemoteBackend,
  options?: ConnectOptions,
): Promise<RemoteConnection> {
  const signal = options?.signal;
  let backendDisposed = false;
  const disposeBackendOnce = () => {
    if (backendDisposed) {
      return;
    }
    backendDisposed = true;
    backend.dispose();
  };
  if (signal?.aborted) {
    disposeBackendOnce();
    throw createRemoteConnectAbortError(signal);
  }

  let removeAbortListener: () => void = () => undefined;
  try {
    const connecting = connectRemoteUnchecked(backend, options);
    if (!signal) {
      return await connecting;
    }
    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = () => {
        // 窗口 Host 合并后不能再通过杀独立 SSH Host 进程来取消连接；如果这里只
        // 结束 logical waiter，detect/deploy/upload 会继续占用旧凭据和连接。连接初始化尚未
        // 对外发布，可以安全释放它独占的 backend，并让调用方立即结束等待。
        disposeBackendOnce();
        reject(createRemoteConnectAbortError(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    });
    const guardedConnecting = connecting.then((connection) => {
      if (signal.aborted) {
        connection.dispose();
        throw createRemoteConnectAbortError(signal);
      }
      return connection;
    });
    return await Promise.race([guardedConnecting, aborted]);
  } catch (error) {
    // detect/deploy/handshake 任一步失败时尚未返回 RemoteConnection，调用方无从 dispose backend。
    disposeBackendOnce();
    throw error;
  } finally {
    removeAbortListener();
  }
}

async function connectRemoteUnchecked(
  backend: IRemoteBackend,
  options?: ConnectOptions,
): Promise<RemoteConnection> {
  const clientId = options?.clientId ?? `desktop-${Date.now()}`;

  const log = (...args: unknown[]) =>
    console.log(formatLogPrefix("connectRemote", process.pid), ...args);

  // 1. Detect remote environment
  log("detecting remote env...");
  const env = await backend.detect();
  throwIfRemoteConnectAborted(options?.signal);
  log("detected:", env);
  assertSupportedRemoteEnvironment(env);

  const remoteRuntimeNetwork = await resolveRemoteRuntimeNetwork(
    backend,
    options?.remoteRuntimeNetwork,
    log,
  );

  // 2. Deploy server if needed
  if (!options?.skipDeploy) {
    log("deploying server...");
    await deployServer(backend, env, options);
    throwIfRemoteConnectAborted(options?.signal);
    log("deploy complete");
  }

  // 3. Launch server
  log("launching remote server...");
  const stream = await backend.exec(buildRemoteServerCommand(options, remoteRuntimeNetwork));
  throwIfRemoteConnectAborted(options?.signal);
  log("remote server exec started");

  // Forward stderr for debugging
  stream.stderr.on("data", (chunk: Buffer) => {
    // 远端 zcode-server 的服务日志走 stderr，直接写 host stderr 时可能被结构化日志中继吞掉。
    // 这里转成 host 的 console 日志，让 remote sqlite 初始化/锁冲突日志能稳定出现在连接日志面板和启动终端。
    console.log(`[remote] ${chunk.toString().trimEnd()}`);
  });

  // 4. Handshake
  log("performing handshake...");
  const { hello, remaining } = await performHandshake(stream, clientId, options?.handshakeTimeout);
  throwIfRemoteConnectAborted(options?.signal);
  log("handshake done, server version:", hello.version);

  // 5. Wrap into RPC channel
  // If there's remaining data from handshake, push it back to the stream
  // so it gets picked up by wrapStdioStream's data listener
  if (remaining && remaining.length > 0) {
    (stream.stdout as NodeJS.ReadableStream & { unshift(chunk: Buffer): void }).unshift(remaining);
  }

  const socket = wrapStdioStream(stream);
  const protocol = new SocketProtocol(socket);
  const client = new ChannelClient(protocol);
  const reverseServer = options?.topicResourceChannel
    ? new ChannelServer(protocol, "desktop-resource")
    : undefined;
  if (reverseServer && options?.topicResourceChannel)
    reverseServer.registerChannel(TOPIC_RESOURCE_RELAY_CHANNEL, options.topicResourceChannel);
  const services = new RemoteServiceAccess(client);
  let hasReportedRemoteClose = false;
  let hasStreamClosed = false;
  let resolveStreamClosed!: () => void;
  const streamClosed = new Promise<void>((resolve) => {
    resolveStreamClosed = resolve;
  });
  const reportRemoteClose = (code: number) => {
    if (hasReportedRemoteClose) {
      return;
    }
    hasReportedRemoteClose = true;
    options?.onDidRemoteClose?.({ code });
  };

  const backendDisconnectDisposable = backend.onDidDisconnect?.((event) => {
    // SSH keepalive 发现半开连接时，远端 server stdio channel 未必立刻 close。
    // 这里把 backend 断连并入同一条关闭上报链路，让 host/main/UI 复用既有 session-close 收口。
    const errorMessage = event.error?.message;
    log(
      errorMessage
        ? `remote backend disconnected: ${event.reason}: ${errorMessage}`
        : `remote backend disconnected: ${event.reason}`,
    );
    reportRemoteClose(BACKEND_DISCONNECT_EXIT_CODE);
  });
  const streamCloseDisposable = stream.onClose((code) => {
    hasStreamClosed = true;
    resolveStreamClosed();
    reportRemoteClose(code);
  });

  let disposalStarted = false;
  let backendDisposed = false;
  let disposeAndWaitInFlight: Promise<void> | null = null;
  const beginDisposal = () => {
    if (disposalStarted) {
      return;
    }
    disposalStarted = true;
    backendDisconnectDisposable?.dispose();
    reverseServer?.dispose();
    client.dispose();
    protocol.dispose();
    // stdin.end 必须在任何 await 之前同步触发，让远端 stdio server 立即收到 EOF。
    socket.dispose();
  };
  const disposeBackend = () => {
    if (backendDisposed) {
      return;
    }
    backendDisposed = true;
    streamCloseDisposable.dispose();
    backend.dispose();
  };
  const disposeBackendAndWait = async () => {
    if (backendDisposed) {
      return;
    }
    backendDisposed = true;
    streamCloseDisposable.dispose();
    if (backend.disposeAndWait) {
      await backend.disposeAndWait();
      return;
    }
    backend.dispose();
  };

  return {
    services,
    client,
    dispose() {
      beginDisposal();
      disposeBackend();
    },
    disposeAndWait(disposeOptions) {
      if (disposeAndWaitInFlight) {
        return disposeAndWaitInFlight;
      }
      beginDisposal();
      if (backendDisposed || hasStreamClosed) {
        disposeBackend();
        return Promise.resolve();
      }

      const timeoutMs = Math.max(disposeOptions?.timeoutMs ?? 5_000, 0);
      disposeAndWaitInFlight = (async () => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<"timed-out">((resolve) => {
          timeout = setTimeout(() => resolve("timed-out"), timeoutMs);
        });
        const result = await Promise.race([streamClosed.then(() => "closed" as const), deadline]);
        if (timeout) {
          clearTimeout(timeout);
        }
        if (result === "timed-out") {
          log(`remote stdio close timed out after ${timeoutMs}ms`);
        }
        await disposeBackendAndWait();
      })();
      return disposeAndWaitInFlight;
    },
  };
}

async function resolveRemoteRuntimeNetwork(
  backend: IRemoteBackend,
  network: RemoteRuntimeNetworkOptions | undefined,
  log: (...args: unknown[]) => void,
): Promise<RemoteRuntimeNetworkOptions | undefined> {
  if (!network || !backend.resolveRuntimeProxy) {
    // 只有实现了远端代理解析能力的 WSL backend 才接收这条权威网络边界；
    // SSH/Docker 即使误传 options 也保持原有启动命令。
    return undefined;
  }
  if (!network.httpProxy?.trim()) {
    return network;
  }

  try {
    const resolvedProxy = await backend.resolveRuntimeProxy(network.httpProxy);
    if (resolvedProxy !== network.httpProxy) {
      log(
        "resolved remote runtime proxy via wsl-host-gateway",
        formatWslProxyForLog(network.httpProxy),
        "->",
        formatWslProxyForLog(resolvedProxy),
      );
    }
    return { ...network, httpProxy: resolvedProxy };
  } catch (error) {
    // 代理解析只是运行时增强；解析失败时沿用设置页原值，避免把 WSL 本地工作区变成不可连接。
    log(
      "remote runtime proxy resolution failed; using configured endpoint",
      error instanceof Error ? error.message : String(error),
    );
    return network;
  }
}

function buildRemoteServerCommand(
  options: ConnectOptions | undefined,
  remoteRuntimeNetwork: RemoteRuntimeNetworkOptions | undefined,
): string {
  const envParts = [
    `${SERVICE_AUTHORITY_MODE_ENV}="desktop-attached-remote"`,
    'ZCODE_SERVER_RUNTIME_ROOT="$HOME/.zcode/server"',
  ];
  for (const [key, value] of Object.entries(
    pickRemoteRuntimeEnv(options?.remoteRuntimeEnv ?? {}),
  )) {
    envParts.push(`${key}=${quotePosixShellArg(value)}`);
  }
  const appVersion = options?.appVersion?.trim();
  if (appVersion) {
    // 远端 server 是通过 SSH/WSL/Docker 单独启动的，不会继承桌面 host env。
    // 这里显式把 app 版本作为远端进程 env 注入，远端 agent 才能在模型请求 header 中带上版本。
    envParts.push(`${ZCODE_APP_VERSION_ENV}=${quotePosixShellArg(appVersion)}`);
  }
  if (remoteRuntimeNetwork?.authoritative) {
    envParts.push(`${ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY}='1'`);
    if (remoteRuntimeNetwork.httpProxy !== undefined) {
      envParts.push(
        `${ZCODE_REMOTE_HTTP_PROXY_ENV_KEY}=${quotePosixShellArg(remoteRuntimeNetwork.httpProxy)}`,
      );
    }
    if (remoteRuntimeNetwork.noProxy !== undefined) {
      envParts.push(
        `${ZCODE_REMOTE_NO_PROXY_ENV_KEY}=${quotePosixShellArg(remoteRuntimeNetwork.noProxy)}`,
      );
    }
  }
  return `${envParts.join(" ")} ~/.zcode/server/node ~/.zcode/server/zcode-server.cjs --prepare-credentials`;
}
