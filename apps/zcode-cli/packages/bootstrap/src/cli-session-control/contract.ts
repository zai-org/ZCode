import type { SessionId, SessionStorePort, TraceContext } from "@zcode/contracts";
import type { CliScope, CliSessionControl } from "@zcode/session-control/contracts";
import type { ZCodeApp } from "../app/types.js";

/** 新根的最小启动参数；不接受 actor mode、permission、parentSessionId 或 subagent 配置。 */
export interface CliRootAppRequest {
  sessionId: SessionId;
  cwd: string;
  model?: string;
  /** 只对本 manager 刚通过 stable fork 创建的全新 session 使用。 */
  resume: boolean;
  traceContext?: TraceContext;
}

export interface CliSessionControlRuntimeOptions {
  /** 可信独立 CLI 启动范围；当前 adapter 不拥有跨进程 owner 路由。 */
  workspace: CliScope;
  sessionStore: SessionStorePort;
  /** 到达上限后拒绝新请求，不淘汰幂等回执后重放；默认 4096 requests / 128 roots。 */
  limits?: { requests?: number; roots?: number };
  /** 使用独立 CLI 配置创建 root app。不得展开 actor options 或继承其 yolo/批准。 */
  createRootApp(input: CliRootAppRequest): Promise<ZCodeApp>;
}

export interface CliSessionControlRuntime {
  readonly control: CliSessionControl;
  /** 来源来自可信启动选项；borrowed 仅决定关闭责任，不决定目标读写权限。 */
  attachRoot(app: ZCodeApp, provenance: "new-independent-root" | "unverified-history"): void;
  /** 先封闭准入，再中断、等待落盘并关闭本 manager 创建的 roots；borrowed root 由调用方关闭。 */
  close(): Promise<void>;
}
