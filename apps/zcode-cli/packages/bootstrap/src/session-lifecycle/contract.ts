import type { SessionLifecycleSnapshot, ZCodeWorkspaceRef } from "@zcode/shared";
export type {
  SessionLifecycleState,
  SessionLifecycleOperation,
  SessionLifecycleFailure,
  SessionLifecycleSnapshot,
} from "@zcode/shared";

/** 仅管理当前进程内的运行实例，不创建/删除持久会话，不替代停止生成接口。 */
export interface SessionLifecycle {
  /** 只读；缺失或删除的 session 报错，不隐式启动。 */
  getState(sessionId: string): Promise<SessionLifecycleSnapshot>;
  /** 幂等恢复已有会话；完成时实例 ready，不提供长期保活租约。 */
  ensureReady(sessionId: string, workspace?: ZCodeWorkspaceRef): Promise<void>;
  /** 幂等释放；预检拒绝无副作用，完成时 unloaded。 */
  stop(sessionId: string): Promise<void>;
  /** 原子占有整个 stop → ensureReady；完成时 ready。 */
  restart(sessionId: string, workspace?: ZCodeWorkspaceRef): Promise<void>;
}

/** 生命周期副作用由宿主注入；停止预检同步，激活预检可异步读取但不得修改归属。 */
export interface SessionLifecycleHost {
  exists(sessionId: string): Promise<boolean>;
  hasRuntime(sessionId: string): boolean;
  validateActivation(sessionId: string, workspace?: ZCodeWorkspaceRef): Promise<void>;
  activate(sessionId: string, workspace?: ZCodeWorkspaceRef): Promise<void>;
  assertCanStop(sessionId: string): void;
  release(sessionId: string, initializationFailed?: boolean): Promise<void>;
  onOperationSettled?(sessionId: string): void;
  onChange?(snapshot: SessionLifecycleSnapshot): void;
}

export class SessionLifecycleError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SessionLifecycleError";
  }
}
