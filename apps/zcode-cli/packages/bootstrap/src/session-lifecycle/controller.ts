import type { ZCodeWorkspaceRef } from "@zcode/shared";
import {
  SessionLifecycleError,
  type SessionLifecycle,
  type SessionLifecycleHost,
  type SessionLifecycleOperation,
  type SessionLifecycleSnapshot,
  type SessionLifecycleState,
} from "./contract.js";

interface Entry {
  snapshot: SessionLifecycleSnapshot;
  flight?: {
    operation: SessionLifecycleOperation;
    promise: Promise<void>;
    workspace?: ZCodeWorkspaceRef;
  };
  restartWorkspace?: ZCodeWorkspaceRef;
  restartAfterStartup?: Promise<void>;
  idleRestart?: Promise<void>;
}

/** 每个 session 一个操作所有者，覆盖初始化、部分失败清理及完整重启区间。 */
export class SessionLifecycleController implements SessionLifecycle {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly host: SessionLifecycleHost) {}

  isStopping(sessionId: string): boolean {
    return this.entries.get(sessionId)?.snapshot.state === "stopping";
  }

  /** 同步准入事实；仅供协议/回收适配器使用，不查询或启动持久会话。 */
  isReady(sessionId: string): boolean {
    return (
      !this.entries.get(sessionId)?.idleRestart &&
      !this.entries.get(sessionId)?.restartAfterStartup &&
      (this.entries.get(sessionId)?.snapshot.state ?? this.initialSnapshot(sessionId).state) ===
        "ready"
    );
  }

  /** 自动重载只接管仍就绪的实例；在调用者最后一次同步检查与预留 flight 之间不得 await。 */
  restartIdle(sessionId: string): Promise<void> | undefined {
    const entry = this.entry(sessionId);
    if (entry.flight || !this.isReady(sessionId)) return undefined;
    const flight = this.restart(sessionId).finally(() => { entry.idleRestart = undefined; });
    entry.idleRestart = flight;
    return flight;
  }

  idleRestartInProgress(sessionId: string): Promise<void> | undefined {
    return this.entries.get(sessionId)?.idleRestart;
  }

  async getState(sessionId: string): Promise<SessionLifecycleSnapshot> {
    await this.assertExists(sessionId);
    const snapshot = this.entries.get(sessionId)?.snapshot ?? this.initialSnapshot(sessionId);
    return { ...snapshot, lastError: snapshot.lastError ? { ...snapshot.lastError } : null };
  }

  ensureReady(sessionId: string, workspace?: ZCodeWorkspaceRef): Promise<void> {
    const entry = this.entry(sessionId);
    const conflict = this.workspaceConflict(entry, workspace);
    if (conflict) return Promise.reject(conflict);
    if (entry.restartAfterStartup)
      return this.join(sessionId, entry.restartAfterStartup, entry.restartWorkspace, workspace);
    if (entry.flight?.operation === "stop") {
      return entry.flight.promise.then(() => this.ensureReady(sessionId, workspace));
    }
    return this.run(
      sessionId,
      "ensureReady",
      async () => {
        await this.assertExists(sessionId);
        await this.host.validateActivation(sessionId, workspace);
        if (entry.snapshot.state !== "ready")
          await this.activate(sessionId, () => this.host.activate(sessionId, workspace));
      },
      workspace,
    );
  }

  /** 产品 create/fork/resume 的内部装配入口；调用方负责其存在性规则。 */
  initialize(
    sessionId: string,
    activate: () => Promise<void>,
    workspace?: ZCodeWorkspaceRef,
    kind: "create" | "restore" = "restore",
  ): Promise<void> {
    const entry = this.entry(sessionId);
    if (entry.flight?.operation === "stop") {
      return entry.flight.promise.then(() => this.initialize(sessionId, activate, workspace, kind));
    }
    return this.run(
      sessionId,
      "ensureReady",
      async () => {
        // 新建入口已占用不存在的 ID；不能用恢复校验查询尚未落盘的会话。
        if (workspace && kind === "restore")
          await this.host.validateActivation(sessionId, workspace);
        if (entry.snapshot.state === "ready") return;
        await this.activate(sessionId, activate);
      },
      workspace,
    );
  }

  stop(sessionId: string): Promise<void> {
    return this.run(sessionId, "stop", async () => {
      await this.assertExists(sessionId);
      this.host.assertCanStop(sessionId);
      await this.release(sessionId, () => this.host.release(sessionId));
    });
  }

  restart(sessionId: string, workspace?: ZCodeWorkspaceRef): Promise<void> {
    const entry = this.entry(sessionId);
    const conflict = this.workspaceConflict(entry, workspace);
    if (conflict) return Promise.reject(conflict);
    if (entry.restartAfterStartup)
      return this.join(sessionId, entry.restartAfterStartup, entry.restartWorkspace, workspace);
    if (entry.flight?.operation === "ensureReady") {
      // 初始化尚未支持硬取消时等待其安全收口；同时关闭 ready 准入，不能并行创建实例。
      const afterStartup = () => {
        entry.restartAfterStartup = undefined;
        entry.restartWorkspace = undefined;
        return this.restart(sessionId, workspace);
      };
      entry.restartWorkspace = workspace;
      entry.restartAfterStartup = entry.flight.promise.then(afterStartup, afterStartup);
      return entry.restartAfterStartup;
    }
    return this.run(
      sessionId,
      "restart",
      async () => {
        await this.assertExists(sessionId);
        await this.host.validateActivation(sessionId, workspace);
        this.host.assertCanStop(sessionId);
        // history-first 可以只有 publisher 没有实例；重启仍必须完整失效旧发布链路。
        await this.release(sessionId, () => this.host.release(sessionId));
        await this.activate(sessionId, () => this.host.activate(sessionId, workspace));
      },
      workspace,
    );
  }

  /** 已有关闭/删除/进程退出策略使用的内部入口；策略预检必须先由调用方完成。 */
  dispose(sessionId: string, release = () => this.host.release(sessionId)): Promise<void> {
    return this.run(sessionId, "stop", async () => {
      if (this.entry(sessionId).snapshot.state === "unloaded") return;
      await this.release(sessionId, release);
    });
  }

  private run(
    sessionId: string,
    operation: SessionLifecycleOperation,
    work: () => Promise<void>,
    workspace?: ZCodeWorkspaceRef,
  ): Promise<void> {
    const entry = this.entry(sessionId);
    const conflict = this.workspaceConflict(entry, workspace);
    if (conflict) return Promise.reject(conflict);
    // 重启等待旧启动时已保留操作资格；旧启动的先注册回调不能抢先 stop。
    if (entry.restartAfterStartup && operation === "stop") {
      return Promise.reject(
        new SessionLifecycleError("conflict", "Session lifecycle restart is pending"),
      );
    }
    if (entry.flight) {
      if (
        entry.flight.operation === operation ||
        (operation === "ensureReady" && entry.flight.operation === "restart")
      ) {
        return this.join(sessionId, entry.flight.promise, entry.flight.workspace, workspace);
      }
      return Promise.reject(
        new SessionLifecycleError(
          "conflict",
          `Session lifecycle ${entry.flight.operation} is in progress`,
        ),
      );
    }
    if (entry.snapshot.state === "faulted") {
      return Promise.reject(
        new SessionLifecycleError(
          "recoveryRequired",
          "Session runtime requires workspace process recovery",
        ),
      );
    }
    const deferred = Promise.withResolvers<void>();
    const flight = { operation, promise: deferred.promise, workspace };
    // 先登记，再调用宿主：同步重入和 restart 的 unloaded 间隙不能抢占此操作。
    entry.flight = flight;
    entry.snapshot.lastError = null;
    void work().then(
      () => {
        entry.flight = undefined;
        // 保留轻量版本事实，避免 stop/reopen 后迟到状态拥有更大的 revision。
        deferred.resolve();
        this.host.onOperationSettled?.(sessionId);
      },
      (error: unknown) => {
        entry.snapshot.lastError = {
          operation,
          code:
            error instanceof SessionLifecycleError
              ? error.code
              : entry.snapshot.state === "faulted"
                ? "resourceReleaseFailed"
                : "operationFailed",
          message: error instanceof Error ? error.message : String(error),
        };
        entry.flight = undefined;
        this.publish(entry);
        deferred.reject(error);
        this.host.onOperationSettled?.(sessionId);
      },
    );
    return deferred.promise;
  }

  private join(
    sessionId: string,
    promise: Promise<void>,
    ownerWorkspace?: ZCodeWorkspaceRef,
    workspace?: ZCodeWorkspaceRef,
  ): Promise<void> {
    // 旧入口没有登记归属时，共享启动不能替代加入者的校验；等创建落盘后验证，不再激活。
    return workspace && !ownerWorkspace
      ? promise.then(() => this.host.validateActivation(sessionId, workspace))
      : promise;
  }

  private workspaceConflict(
    entry: Entry,
    workspace?: ZCodeWorkspaceRef,
  ): SessionLifecycleError | undefined {
    // 启动与排队重启的归属都必须匹配，后登记的请求不能遮蔽原启动的身份。
    if (
      workspace &&
      [entry.flight?.workspace, entry.restartWorkspace].some(
        (active) =>
          active &&
          (workspace.workspaceKey !== active.workspaceKey ||
            workspace.workspacePath !== active.workspacePath ||
            workspace.workspaceIdentity !== active.workspaceIdentity ||
            workspace.remoteSessionId !== active.remoteSessionId),
      )
    )
      return new SessionLifecycleError(
        "conflict",
        "Session activation workspace conflicts with the current operation",
      );
    return undefined;
  }

  private async activate(sessionId: string, activate: () => Promise<void>): Promise<void> {
    this.entry(sessionId).snapshot.generation += 1;
    this.transition(sessionId, "starting");
    try {
      await activate();
      this.transition(sessionId, "ready");
    } catch (error) {
      try {
        await this.release(sessionId, () => this.host.release(sessionId, true));
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Session initialization and cleanup failed",
        );
      }
      throw error;
    }
  }

  private async release(sessionId: string, release: () => Promise<void>): Promise<void> {
    this.transition(sessionId, "stopping");
    try {
      await release();
      this.transition(sessionId, "unloaded");
    } catch (error) {
      // 失败/超时并非释放成功。保留隔离状态，迟到回调也不能复活下一实例。
      this.transition(sessionId, "faulted");
      throw error;
    }
  }

  private transition(sessionId: string, state: SessionLifecycleState): void {
    const entry = this.entry(sessionId);
    entry.snapshot.state = state;
    this.publish(entry);
  }

  private publish(entry: Entry): void {
    entry.snapshot.revision += 1;
    this.host.onChange?.({ ...entry.snapshot });
  }

  private initialSnapshot(sessionId: string): SessionLifecycleSnapshot {
    return {
      sessionId,
      state: this.host.hasRuntime(sessionId) ? "ready" : "unloaded",
      generation: 0,
      revision: 0,
      lastError: null,
    };
  }

  private entry(sessionId: string): Entry {
    let entry = this.entries.get(sessionId);
    if (!entry) {
      entry = { snapshot: this.initialSnapshot(sessionId) };
      this.entries.set(sessionId, entry);
    }
    return entry;
  }

  private async assertExists(sessionId: string): Promise<void> {
    if (!(await this.host.exists(sessionId))) {
      throw new SessionLifecycleError("sessionNotFound", `Session not found: ${sessionId}`);
    }
  }
}
