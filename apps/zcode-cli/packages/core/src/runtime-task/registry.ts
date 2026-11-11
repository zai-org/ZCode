import type {
  ModelUsage,
  SessionId,
  SubagentTaskSnapshot,
  TraceContext,
  TurnId,
} from "@zcode/contracts";
import type { AgentOutput } from "@zcode/contracts";

// local_dynamic_workflow 与 local_workflow 刻意分开：后者是 legacy `Workflow` 工具（不可取消），
// 前者是 workflow run（经 DynamicWorkflowRunPort.cancel 可取消）。合成一个类型，取消分派就无法区分。
export type RuntimeTaskType =
  | "local_agent"
  | "local_bash"
  | "local_workflow"
  | "local_dynamic_workflow"
  | "monitor_mcp";

export interface RuntimeTaskUsageSnapshot {
  durationMs?: number;
  modelUsage?: ModelUsage;
  toolUseCount?: number;
  totalTokens?: number;
}

export interface RuntimeTaskPendingMessage {
  id: string;
  isMeta?: boolean;
  message: string;
  origin?: {
    kind: "coordinator";
    toolCallId?: string;
  };
  queuedAt: Date;
  summary?: string;
  traceContext?: TraceContext;
}

export interface RuntimeTaskMessageSink {
  send(message: RuntimeTaskPendingMessage): Promise<"queued" | "steered">;
}

export interface SubagentRunningToolActivity {
  toolCallId: string;
  toolName: string;
  startedAt: number;
  /** Bash 命令、Read 路径等一行摘要；只给模型判断用，有长度上限。 */
  summary?: string;
}

/** 后台 Agent 的进展事实（subagent/background-stall.ts 写，停滞提醒与 TaskOutput 读）。 */
export interface SubagentActivitySnapshot {
  lastProgressAt: number;
  runningTools: SubagentRunningToolActivity[];
  /** child 正在等用户审批；此时无进展是在等人，不提醒主代理。由 pendingPermissionToolCallIds 派生。 */
  waitingForPermission: boolean;
  /**
   * 还在等审批的工具调用。并行工具组里可能同时有多个审批挂起，一个结束不代表全部结束
   * （!3563 评审 SG-02）；缺省按空处理（旧快照）。
   */
  pendingPermissionToolCallIds?: string[];
  /**
   * 已经结束的审批（requestId）与工具调用（toolCallId），各保留最近 64 个。审批请求的发布可能
   * 晚于超时、取消后的 Resolved / ToolCallError 到达，迟到的 PermissionRequested 不能把已结束的
   * 审批重新挂起（!3563 评审第四轮 CR-01）。
   */
  endedPermissionRequestIds?: string[];
  endedToolCallIds?: string[];
}

export interface RuntimeTaskSnapshot extends SubagentTaskSnapshot {
  /** local_agent 的进展事实；只在有 child 事件后出现。 */
  activity?: SubagentActivitySnapshot;
  /** 内存执行归属；重启不会恢复闲时后台任务。 */
  offPeakExecutionId?: string;
  offPeakCancelled?: boolean;
  /** task 注册时所属 active conversation branch；用于迟到 completion fencing。 */
  branchGeneration?: number;
  exitCode?: number;
  type: RuntimeTaskType;
  isBackgrounded?: boolean;
  messageSink?: RuntimeTaskMessageSink;
  output?: AgentOutput;
  parentSessionId?: SessionId;
  pendingMessages?: RuntimeTaskPendingMessage[];
  prompt?: string;
  /**
   * workflow run 产物的序列化文本。TaskOutput 的投影只读得到 registry 条目（dwf 从不写
   * outputFile），所以产物必须在终态更新时就存到条目上。
   */
  resultText?: string;
  /**
   * 是谁请求停止这个任务（"user" = GUI / 后台面板，"model" = TaskStop）。dwf 停止分支在调
   * 端口 cancel 之前写下它；终态通知稍后由 waiter 结算时读它。重臂（resume 新生命）随结算面复位。
   */
  stopInitiator?: "user" | "model";
  taskType?: RuntimeTaskType;
  traceContext?: TraceContext;
  turnId?: TurnId;
  usage?: RuntimeTaskUsageSnapshot;
}

export interface RuntimeTaskRegistry {
  subscribe?(listener: () => void): () => void;
  setOffPeakExecutionId?(executionId: string | undefined): void;
  all(): Record<string, RuntimeTaskSnapshot>;
  get(id: string): RuntimeTaskSnapshot | undefined;
  drainMessages(id: string): RuntimeTaskPendingMessage[];
  queueMessage(id: string, message: RuntimeTaskPendingMessage): RuntimeTaskSnapshot | undefined;
  register(task: RuntimeTaskSnapshot): void;
  remove(id: string): void;
  requestBackground(id: string): boolean;
  setActiveBranchGeneration?(generation: number): void;
  update(
    id: string,
    patcher: (task: RuntimeTaskSnapshot) => RuntimeTaskSnapshot,
  ): RuntimeTaskSnapshot | undefined;
  waitForBackgroundRequest(
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<RuntimeTaskSnapshot | undefined>;
  waitForTerminal(
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<RuntimeTaskSnapshot | undefined>;
}

interface RuntimeTaskWaiter {
  onAbort?: () => void;
  reject: (error: unknown) => void;
  resolve: (task: RuntimeTaskSnapshot | undefined) => void;
  signal?: AbortSignal;
}

const TERMINAL_STATUSES = new Set<RuntimeTaskSnapshot["status"]>([
  "completed",
  "failed",
  "cancelled",
  "killed",
  "stopped",
  "lost",
]);

export class InMemoryRuntimeTaskRegistry implements RuntimeTaskRegistry {
  private offPeakExecutionId: string | undefined;
  private readonly listeners = new Set<() => void>();
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  setOffPeakExecutionId(executionId: string | undefined): void {
    this.offPeakExecutionId = executionId;
  }
  private changed(): void {
    for (const listener of this.listeners) listener();
  }
  private activeBranchGeneration = 0;
  private readonly backgroundWaiters = new Map<string, Set<RuntimeTaskWaiter>>();
  private readonly tasks = new Map<string, RuntimeTaskSnapshot>();
  private readonly terminalWaiters = new Map<string, Set<RuntimeTaskWaiter>>();

  register(task: RuntimeTaskSnapshot): void {
    const stamped = {
      ...task,
      ...((task.offPeakExecutionId ?? this.offPeakExecutionId)
        ? { offPeakExecutionId: task.offPeakExecutionId ?? this.offPeakExecutionId }
        : {}),
      branchGeneration: task.branchGeneration ?? this.activeBranchGeneration,
    };
    this.tasks.set(stamped.taskId, stamped);
    this.resolveIfTerminal(stamped.taskId, stamped);
    this.resolveIfBackgrounded(stamped.taskId, stamped);
    this.changed();
  }

  setActiveBranchGeneration(generation: number): void {
    this.activeBranchGeneration = generation;
  }

  update(
    id: string,
    patcher: (task: RuntimeTaskSnapshot) => RuntimeTaskSnapshot,
  ): RuntimeTaskSnapshot | undefined {
    const current = this.tasks.get(id);
    if (!current) return undefined;
    const next = patcher(current);
    this.tasks.set(id, next);
    this.resolveIfTerminal(id, next);
    this.resolveIfBackgrounded(id, next);
    this.changed();
    return next;
  }

  requestBackground(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || isTerminalRuntimeTask(task)) return false;
    const next: RuntimeTaskSnapshot = { ...task, isBackgrounded: true };
    this.tasks.set(id, next);
    this.resolveBackgroundWaiters(id, next);
    this.changed();
    return true;
  }

  remove(id: string): void {
    this.tasks.delete(id);
    this.resolveTerminalWaiters(id, undefined);
    this.resolveBackgroundWaiters(id, undefined);
    this.changed();
  }

  get(id: string): RuntimeTaskSnapshot | undefined {
    return this.tasks.get(id);
  }

  all(): Record<string, RuntimeTaskSnapshot> {
    return Object.fromEntries(this.tasks);
  }

  queueMessage(id: string, message: RuntimeTaskPendingMessage): RuntimeTaskSnapshot | undefined {
    return this.update(id, (task) => ({
      ...task,
      pendingMessages: [...(task.pendingMessages ?? []), message],
    }));
  }

  drainMessages(id: string): RuntimeTaskPendingMessage[] {
    const task = this.tasks.get(id);
    if (!task || !task.pendingMessages || task.pendingMessages.length === 0) return [];
    const messages = task.pendingMessages;
    this.tasks.set(id, { ...task, pendingMessages: [] });
    this.changed();
    return messages;
  }

  waitForBackgroundRequest(
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<RuntimeTaskSnapshot | undefined> {
    const current = this.tasks.get(id);
    if (!current || current.isBackgrounded || isTerminalRuntimeTask(current)) {
      return Promise.resolve(current?.isBackgrounded ? current : undefined);
    }
    return this.waitFor(this.backgroundWaiters, id, options);
  }

  waitForTerminal(
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<RuntimeTaskSnapshot | undefined> {
    const current = this.tasks.get(id);
    if (!current || isTerminalRuntimeTask(current)) return Promise.resolve(current);
    return this.waitFor(this.terminalWaiters, id, options);
  }

  private waitFor(
    waitersByTask: Map<string, Set<RuntimeTaskWaiter>>,
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<RuntimeTaskSnapshot | undefined> {
    const signal = options?.signal;
    if (signal?.aborted) return Promise.reject(abortReason(signal));

    return new Promise((resolve, reject) => {
      const waiter: RuntimeTaskWaiter = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          this.removeWaiter(waitersByTask, id, waiter);
          reject(abortReason(signal));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      let waiters = waitersByTask.get(id);
      if (!waiters) {
        waiters = new Set();
        waitersByTask.set(id, waiters);
      }
      waiters.add(waiter);
    });
  }

  private resolveIfBackgrounded(id: string, task: RuntimeTaskSnapshot): void {
    if (task.isBackgrounded) {
      this.resolveBackgroundWaiters(id, task);
    }
  }

  private resolveIfTerminal(id: string, task: RuntimeTaskSnapshot): void {
    if (isTerminalRuntimeTask(task)) {
      this.resolveTerminalWaiters(id, task);
      this.resolveBackgroundWaiters(id, undefined);
    }
  }

  private resolveBackgroundWaiters(id: string, task: RuntimeTaskSnapshot | undefined): void {
    this.resolveWaiters(this.backgroundWaiters, id, task);
  }

  private resolveTerminalWaiters(id: string, task: RuntimeTaskSnapshot | undefined): void {
    this.resolveWaiters(this.terminalWaiters, id, task);
  }

  private resolveWaiters(
    waitersByTask: Map<string, Set<RuntimeTaskWaiter>>,
    id: string,
    task: RuntimeTaskSnapshot | undefined,
  ): void {
    const waiters = waitersByTask.get(id);
    if (!waiters) return;
    waitersByTask.delete(id);
    for (const waiter of waiters) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.resolve(task);
    }
  }

  private removeWaiter(
    waitersByTask: Map<string, Set<RuntimeTaskWaiter>>,
    id: string,
    waiter: RuntimeTaskWaiter,
  ): void {
    const waiters = waitersByTask.get(id);
    if (!waiters) return;
    waiters.delete(waiter);
    if (waiters.size === 0) waitersByTask.delete(id);
  }
}

export function isTerminalRuntimeTask(task: Pick<RuntimeTaskSnapshot, "status">): boolean {
  return TERMINAL_STATUSES.has(task.status);
}

export function hasRunningBackgroundRuntimeTask(registry: RuntimeTaskRegistry): boolean {
  return Object.values(registry.all()).some(
    (task) => task.isBackgrounded === true && task.status === "running",
  );
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Runtime task wait aborted");
}
