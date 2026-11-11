import { SessionEventType, traceContextToLogContext } from "../deps.js";
import type {
  BackgroundExecutionSnapshot,
  BackgroundTaskCancelResult,
  BackgroundTaskInfo,
  BackgroundTaskInfoStatus,
  TraceContext,
} from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { stopDynamicWorkflowBackgroundTask } from "./background-stop-dynamic-workflow.js";
import type {
  RuntimeBackgroundStopOptions,
  RuntimeBackgroundStopResult,
  RuntimeBackgroundStopStatus,
  RuntimeBackgroundStopTarget,
  TypedRuntimeBackgroundStopTarget,
} from "./background-stop-types.js";
import type { RuntimeTaskSnapshot, RuntimeTaskType } from "../../runtime-task/registry.js";
import {
  hasRunningBackgroundRuntimeTask,
  isTerminalRuntimeTask,
} from "../../runtime-task/registry.js";

// 停止分派的类型集中在 background-stop-types.ts（供各分支模块共用）；这里 re-export
// 保持既有 import 路径不变。
export type {
  RuntimeBackgroundStopOptions,
  RuntimeBackgroundStopResult,
} from "./background-stop-types.js";

/**
 * Session 常驻池的同步权威查询。
 *
 * 协议层的 activeAbortController 只覆盖前台 turn，后台 Bash/Agent/Workflow
 * 已经从前台 turn 脱离但仍需要当前 runtime 接收终态与唤醒通知。回收判定必须直接读取
 * runtime task registry，不能从协议投影或 UI 状态猜测。
 */
export function hasRunningBackgroundTasks(this: AgentRuntimeInternal): boolean {
  return hasRunningBackgroundRuntimeTask(this.runtimeTaskRegistry);
}

export async function cancelBackgroundTask(
  this: AgentRuntimeInternal,
  taskId: string,
  options: { traceContext?: TraceContext } = {},
): Promise<BackgroundTaskCancelResult> {
  // cancelBackgroundTask 只有 GUI 与后台面板会调（v4 cancelBackgroundWork）：这就是用户的手。
  const result = await this.stopBackgroundTask(taskId, {
    initiator: "user",
    traceContext: options.traceContext,
  });
  if (!result.ok) {
    return {
      cancelled: false,
      reason: result.reason,
      status: toBackgroundTaskInfoStatus(result.status) ?? "lost",
      taskId,
    };
  }
  const projection = await this.rebuildProjection();
  const status = toBackgroundTaskInfoStatus(result.status) ?? "lost";
  return {
    cancelled: status === "cancelled",
    reason: result.alreadyTerminal ? "background_task_not_running" : undefined,
    snapshot: projection.backgroundTasks.find((task) => task.taskId === taskId),
    status,
    taskId,
  };
}

export async function stopBackgroundTask(
  this: AgentRuntimeInternal,
  taskId: string,
  options: RuntimeBackgroundStopOptions,
): Promise<RuntimeBackgroundStopResult> {
  const traceContext = options.traceContext ?? this.rootTraceContext;
  if (options.expectedExecutionId !== undefined) {
    // 胶囊能力不能从历史投影恢复；父 runtime 先证明归属，子代理 owner 在提交时再次校验执行身份。
    const task = this.runtimeTaskRegistry.get(taskId);
    if (!task || task.parentSessionId !== this.sessionId || task.type !== "local_agent") {
      return { ok: false, reason: "background_task_not_found", taskId };
    }
    if (task.executionId !== options.expectedExecutionId || isTerminalRuntimeTask(task)) {
      return { ok: false, reason: "background_task_not_running", taskId, status: task.status };
    }
    return stopLocalAgentBackgroundTask.call(this, {
      currentStatus: task.status,
      existing: undefined,
      registryTask: task,
      taskId,
      taskType: "local_agent",
    }, options.initiator, options.expectedExecutionId);
  }
  const target = await resolveBackgroundStopTarget.call(this, taskId);
  if (!target) {
    return {
      ok: false,
      reason: "background_task_not_found",
      taskId,
    };
  }
  if (!isTypedBackgroundStopTarget(target)) {
    return unsupportedBackgroundStopResult(target);
  }

  if (isTerminalBackgroundStopTarget(target)) {
    if (options.strict) {
      return {
        ok: false,
        reason: "background_task_not_running",
        status: target.currentStatus,
        taskId,
        type: target.taskType,
      };
    }
    return {
      alreadyTerminal: true,
      command: commandFromRuntimeTask(target.registryTask, target.existing),
      ok: true,
      status: target.currentStatus ?? "lost",
      taskId,
      type: target.taskType,
    };
  }

  if (target.taskType === "local_agent") {
    return stopLocalAgentBackgroundTask.call(this, target, options.initiator);
  }

  if (target.taskType === "local_bash") {
    return stopLocalBashBackgroundTask.call(this, target, traceContext);
  }

  if (target.taskType === "local_dynamic_workflow") {
    return stopDynamicWorkflowBackgroundTask.call(
      this,
      target,
      unsupportedBackgroundStopResult,
      options.initiator,
    );
  }

  return unsupportedBackgroundStopResult(target);
}

async function resolveBackgroundStopTarget(
  this: AgentRuntimeInternal,
  taskId: string,
): Promise<RuntimeBackgroundStopTarget | undefined> {
  const registryTask = this.runtimeTaskRegistry.get(taskId);
  const projection = await this.rebuildProjection();
  const existing =
    projection.backgroundTasks.find((task) => task.taskId === taskId) ??
    (registryTask ? backgroundInfoFromRuntimeTask(registryTask) : undefined);
  if (!registryTask && !existing) {
    return undefined;
  }

  const taskType = registryTask?.type ?? runtimeTaskTypeFromBackgroundInfo(existing);
  return {
    currentStatus: registryTask?.status ?? existing?.status,
    existing,
    registryTask,
    taskId,
    taskType,
  };
}

function isTerminalBackgroundStopTarget(target: RuntimeBackgroundStopTarget): boolean {
  return (
    (target.registryTask ? isTerminalRuntimeTask(target.registryTask) : false) ||
    isTerminalBackgroundTaskInfoStatus(target.existing?.status)
  );
}

function isTypedBackgroundStopTarget(
  target: RuntimeBackgroundStopTarget,
): target is TypedRuntimeBackgroundStopTarget {
  return target.taskType !== undefined;
}

function unsupportedBackgroundStopResult(
  target: RuntimeBackgroundStopTarget,
): RuntimeBackgroundStopResult {
  return {
    ok: false,
    reason: "background_task_cancel_not_supported",
    status: target.currentStatus,
    taskId: target.taskId,
    ...(target.taskType ? { type: target.taskType } : {}),
  };
}

async function stopLocalAgentBackgroundTask(
  this: AgentRuntimeInternal,
  target: TypedRuntimeBackgroundStopTarget,
  initiator: RuntimeBackgroundStopOptions["initiator"],
  expectedExecutionId?: string,
): Promise<RuntimeBackgroundStopResult> {
  if (!this.subagentPort?.stopTask) {
    return unsupportedBackgroundStopResult(target);
  }
  // 停止者随停止请求传给 subagent：killed 通知据此写 "by ZCode" / "by user" / 不写。
  const snapshot = await this.subagentPort.stopTask(target.taskId, {
    initiator,
    ...(expectedExecutionId !== undefined ? { expectedExecutionId } : {}),
  });
  if (expectedExecutionId !== undefined && snapshot?.status !== "killed") {
    return {
      ok: false,
      reason: "background_task_not_running",
      taskId: target.taskId,
      status: snapshot?.status,
    };
  }
  if (!snapshot) {
    return {
      ok: false,
      reason: "background_task_not_found",
      status: "lost",
      taskId: target.taskId,
      ...(target.taskType ? { type: target.taskType } : {}),
    };
  }
  return {
    command: commandFromRuntimeTask(target.registryTask, target.existing),
    ok: true,
    status: snapshot.status,
    taskId: target.taskId,
    type: "local_agent",
  };
}

async function stopLocalBashBackgroundTask(
  this: AgentRuntimeInternal,
  target: TypedRuntimeBackgroundStopTarget,
  traceContext: TraceContext,
): Promise<RuntimeBackgroundStopResult> {
  if (!this.executionPort?.cancelBackgroundTask) {
    return unsupportedBackgroundStopResult(target);
  }

  const cancelRequestedAt = new Date();
  if (target.existing?.status === "running") {
    await this.appendEvent(
      this.createEvent(
        SessionEventType.BackgroundTaskUpdated,
        this.buildBackgroundTaskPayload(target.taskId, target.existing, undefined, {
          cancelRequestedAt,
          cancellable: false,
          status: "running",
        }),
        traceContext,
      ),
      traceContext,
    );
  }

  const snapshot = await this.executionPort.cancelBackgroundTask(target.taskId);
  if (!snapshot) {
    const completedAt = new Date();
    if (target.registryTask) {
      this.runtimeTaskRegistry.update(target.taskId, (current) =>
        isTerminalRuntimeTask(current)
          ? current
          : {
              ...current,
              completedAt,
              isBackgrounded: true,
              status: "lost",
            },
      );
    }
    await this.appendEvent(
      this.createEvent(
        SessionEventType.BackgroundTaskCompleted,
        this.buildBackgroundTaskPayload(target.taskId, target.existing, undefined, {
          cancelRequestedAt,
          cancellable: false,
          completedAt,
          status: "lost",
        }),
        traceContext,
      ),
      traceContext,
    );
    return {
      ok: false,
      reason: "background_task_not_found",
      status: "lost",
      taskId: target.taskId,
      type: "local_bash",
    };
  }

  const status: BackgroundTaskInfoStatus =
    snapshot.status === "running" ? "cancelled" : snapshot.status;
  if (!target.registryTask) {
    await this.appendEvent(
      this.createEvent(
        SessionEventType.BackgroundTaskCompleted,
        this.buildBackgroundTaskPayload(target.taskId, target.existing, snapshot, {
          cancelRequestedAt,
          cancellable: false,
          completedAt: snapshot.completedAt ?? new Date(),
          status,
        }),
        traceContext,
      ),
      traceContext,
    );
  }
  return {
    command: commandFromRuntimeTask(target.registryTask, target.existing),
    ok: true,
    status,
    taskId: target.taskId,
    type: "local_bash",
  };
}

export async function cancelRunningRuntimeBackgroundTasks(
  this: AgentRuntimeInternal,
  input: { reason: "subagent_cancelled" | "session_closed"; traceContext?: TraceContext },
): Promise<void> {
  if (input.reason !== "session_closed" && this.config.taskType !== "subagent_child") return;
  const traceContext = input.traceContext ?? this.rootTraceContext;
  const tasks = Object.values(this.runtimeTaskRegistry.all()).filter(
    (task) =>
      task.type === "local_bash" && task.isBackgrounded === true && task.status === "running",
  );

  const results = await Promise.allSettled(
    tasks.map(async (task) => {
      this.logger?.info?.("Cancelling background task during runtime cleanup", {
        ...traceContextToLogContext(traceContext),
        event: "runtime.background_task.cleanup_cancel",
        module: "core.runtime",
        reason: input.reason,
        taskId: task.taskId,
      });
      await this.stopBackgroundTask(task.taskId, {
        traceContext,
      });
    }),
  );
  // 某个取消失败也要等其他任务完成收尾，否则上层会提前关闭共享存储和执行器。
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length) throw new AggregateError(errors, "Background tasks cleanup failed");
}

export function buildBackgroundTaskPayload(
  this: AgentRuntimeInternal,
  taskId: string,
  existing: BackgroundTaskInfo | undefined,
  snapshot: BackgroundExecutionSnapshot | undefined,
  overrides: {
    cancelRequestedAt?: Date;
    cancellable?: boolean;
    completedAt?: Date;
    status?: BackgroundTaskInfoStatus;
  } = {},
): BackgroundTaskInfo {
  const result = snapshot?.result;
  const stdoutBytes = result?.stdout.bytes ?? snapshot?.stdoutBytes ?? existing?.stdoutBytes;
  const stderrBytes = result?.stderr.bytes ?? snapshot?.stderrBytes ?? existing?.stderrBytes;
  const stdoutTail = result?.stdout.text || snapshot?.stdoutTail || existing?.stdoutTail;
  const stderrTail = result?.stderr.text || snapshot?.stderrTail || existing?.stderrTail;
  const stdoutPersistedOutputPath =
    snapshot?.stdoutPersistedOutputPath ??
    result?.stdout.artifactPath ??
    existing?.stdoutPersistedOutputPath;
  const stderrPersistedOutputPath =
    snapshot?.stderrPersistedOutputPath ??
    result?.stderr.artifactPath ??
    existing?.stderrPersistedOutputPath;
  const outputBytes =
    stdoutBytes === undefined && stderrBytes === undefined
      ? existing?.outputBytes
      : (stdoutBytes ?? 0) + (stderrBytes ?? 0);
  const outputPath =
    snapshot?.outputPath ??
    stdoutPersistedOutputPath ??
    stderrPersistedOutputPath ??
    existing?.outputPath;
  const outputTruncated =
    result === undefined
      ? existing?.outputTruncated
      : result.stdout.truncated ||
        result.stderr.truncated ||
        result.stdout.artifactTruncated ||
        result.stderr.artifactTruncated;
  const status =
    overrides.status ??
    ((snapshot?.status ?? existing?.status ?? "lost") as BackgroundTaskInfoStatus);

  return {
    taskId,
    toolCallId: existing?.toolCallId,
    toolName: existing?.toolName,
    // 此构造器只服务 local Bash stop/update；Agent 终态由 subagent runner 产生。
    taskKind: "bash",
    blocked: existing?.blocked,
    blockedReason: existing?.blockedReason,
    cancellable: overrides.cancellable ?? (status === "running" && Boolean(snapshot)),
    cancelRequestedAt: overrides.cancelRequestedAt ?? existing?.cancelRequestedAt,
    command: existing?.command,
    description: existing?.description,
    status,
    pid: snapshot?.pid ?? result?.pid ?? existing?.pid,
    startedAt: snapshot?.startedAt ?? result?.startedAt ?? existing?.startedAt,
    completedAt: overrides.completedAt ?? snapshot?.completedAt ?? existing?.completedAt,
    outputPath,
    stderrPersistedOutputPath,
    stdoutPersistedOutputPath,
    outputBytes,
    outputTruncated,
    outputTail: stdoutTail ?? stderrTail ?? existing?.outputTail,
    stderrBytes,
    stderrTail,
    stdoutBytes,
    stdoutTail,
    terminalId: existing?.terminalId ?? taskId,
  };
}

function backgroundInfoFromRuntimeTask(task: RuntimeTaskSnapshot): BackgroundTaskInfo {
  return {
    taskId: task.taskId,
    toolCallId: typeof task.parentToolCallId === "string" ? task.parentToolCallId : undefined,
    toolName: toolNameFromRuntimeTaskType(task.type),
    cancellable: task.status === "running",
    command: commandFromRuntimeTask(task, undefined),
    description: task.description,
    status: toBackgroundTaskInfoStatus(task.status) ?? "lost",
    pid: task.pid,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    outputPath: task.outputFile,
    terminalId: task.taskId,
  };
}

function commandFromRuntimeTask(
  task: RuntimeTaskSnapshot | undefined,
  existing: BackgroundTaskInfo | undefined,
): string | undefined {
  // TaskStop 对 local_agent 返回短 description；旧 projection 的 command
  // 可能已保存为完整 prompt，因此运行时任务必须先于 existing.command 取值。
  if (task?.type === "local_agent") return task.description;
  if (!task && existing?.toolName === "Agent") return existing.description;
  if (existing?.command) return existing.command;
  if (task?.type === "local_bash") return task.description || task.prompt;
  return task?.prompt;
}

function runtimeTaskTypeFromBackgroundInfo(
  task: BackgroundTaskInfo | undefined,
): RuntimeTaskType | undefined {
  switch (task?.toolName) {
    case "Bash":
      return "local_bash";
    case "Agent":
      return "local_agent";
    case "Workflow":
      return "local_workflow";
    case "CreateWorkflow":
    case "AmendWorkflow":
      return "local_dynamic_workflow";
    default:
      return undefined;
  }
}

function toolNameFromRuntimeTaskType(type: RuntimeTaskType): string {
  switch (type) {
    case "local_agent":
      return "Agent";
    case "local_bash":
      return "Bash";
    case "local_workflow":
      return "Workflow";
    case "local_dynamic_workflow":
      return "CreateWorkflow";
    case "monitor_mcp":
      return "Monitor";
  }
}

function isTerminalBackgroundTaskInfoStatus(status: BackgroundTaskInfoStatus | undefined): boolean {
  return Boolean(status && status !== "running");
}

function toBackgroundTaskInfoStatus(
  status: RuntimeBackgroundStopStatus | undefined,
): BackgroundTaskInfoStatus | undefined {
  switch (status) {
    case "cancelled":
    case "killed":
    case "stopped":
      return "cancelled";
    case "completed":
    case "failed":
    case "lost":
    case "running":
    case "spawn_error":
    case "timed_out":
      return status;
    default:
      return undefined;
  }
}
