/**
 * cli-official-command-endpoint 对外契约（ZCode Sites 技术方案 5.8）。
 * 官方插件命令（如 zcode-site）不持有凭证，经 agent 的本地端点调用 zcode-server；
 * 端点按 session token 认出会话，只放行 OFFICIAL_COMMAND_ROUTES，每个请求向 host 现取身份头。
 */
import type { ExecutionPort, Logger, OfficialMcpAuthHeadersResult } from "@zcode/contracts";

/** 放行的路径前缀与它所属的官方插件。只有这里列出的接口能借到用户身份。 */
export const OFFICIAL_COMMAND_ROUTES: readonly { prefix: string; pluginId: string }[] = [
  { prefix: "/api/v1/sites", pluginId: "zcode-site" },
];

/** 端点自己产生的错误类型（invalid / auth / network），经响应头告诉 CLI，CLI 据此区分网络错误和服务端错误。 */
export const OFFICIAL_ENDPOINT_ERROR_HEADER = "X-ZCode-Official-Endpoint-Error";

/** 发起命令的会话所在的 workspace；与该会话的 MCP 连接用同一对值。 */
export interface OfficialCommandWorkspace {
  workspacePath: string;
  workspaceIdentity?: string;
}

/** 端点为某个 session 观察到的事实。 */
export interface OfficialCommandSessionObserver {
  /** 收到 `POST /api/v1/sites/{siteId}/deployments` 时调用，早于取身份和转发，不看结果。 */
  onSiteDeploymentRequested(): void;
}

export interface OfficialCommandEndpointOptions {
  /** 经 interaction/requestOfficialMcpAuthHeaders（consumer=plugin-command）向 host 取身份头。 */
  resolveHeaders(input: {
    pluginId: string;
    targetOrigin: string;
    workspace: OfficialCommandWorkspace;
    signal: AbortSignal;
  }): Promise<OfficialMcpAuthHeadersResult>;
  /** 与官方 MCP 的可信 origin 同一个表达式，跟随 production / test 与自建环境。 */
  resolveZCodeApiOrigin(): string;
  appVersion?: string;
  /** 走 agent 的网络配置（代理、CA）；直连时请求体按流转发。 */
  fetch: typeof globalThis.fetch;
  logger?: Pick<Logger, "debug" | "info" | "warn">;
  platform?: NodeJS.Platform;
}

export interface OfficialCommandEndpoint {
  /**
   * 该 session 的 Bash/tool 子进程要带的 env；首次调用时才开始监听，同一 session 返回同一 token。
   * workspace 和 observer 记在 session 上，取身份头时带给 host。close 之后返回空对象。
   */
  envForSession(
    sessionId: string,
    workspace: OfficialCommandWorkspace,
    observer?: OfficialCommandSessionObserver,
  ): Promise<Record<string, string>>;
  /** 作废全部 token、断开连接并删除 socket 目录；可重复调用。 */
  close(): Promise<void>;
}

export interface CliOfficialCommandEndpointContract {
  /** 创建端点，不立即监听。一个 agent 进程一个，跨 session 共用。 */
  createOfficialCommandEndpoint(options: OfficialCommandEndpointOptions): OfficialCommandEndpoint;
  /**
   * 包装 session 的执行端口：前台和后台命令的 env overlay 补上端点地址与 token。
   * 保留底层的全部执行能力，包括 ExecutionPort 接口之外的 Bash 后台生命周期与后台等待，
   * 及其模式、执行选项、结果和错误；底层不支持某个能力时不暴露。
   * `base: "empty"` 的请求不注入；resolveEnv 失败时照常执行（CLI 会按未登录报错）。
   */
  withOfficialCommandEnv(
    port: ExecutionPort,
    resolveEnv: () => Promise<Record<string, string>>,
    logger?: Pick<Logger, "warn">,
  ): ExecutionPort;
}
