import {
  SessionEventType,
  traceContextToLogContext,
  type BackgroundExecutionSnapshot,
  type ExecutionPort,
  type SessionEvent,
  type TraceContext,
  type TurnId,
} from "@zcode/contracts";
import { isSubagentDispatchToolName } from "../compat.js";
import type { ExecutableToolCall } from "../types.js";
import type { ToolExecutorDeps } from "./types.js";
import { isRecord } from "./utils.js";
import { formatTaskNotification } from "../../runtime-task/notification.js";
import { describeWorkflowScriptPath } from "../handlers/workflow-script-path.js";
import {
  claimRuntimeBackgroundTaskNotification,
  isDynamicWorkflowRunDispatchToolName,
  registerRuntimeBackgroundTask,
  releaseRuntimeBackgroundTaskNotification,
  removeRuntimeBackgroundTask,
  updateRuntimeBackgroundTask,
} from "./background-task-registry.js";
import { backgroundTaskOutputMetadata } from "./background-task-output.js";
import {
  buildWorkflowReportsNotificationSection,
  type BackgroundTaskSnapshot,
  buildWorkflowTaskSummary,
  workflowSnapshotTerminal,
  workflowTaskSubject,
  runtimeString,
  buildWorkflowNotificationOriginMeta,
  workflowSnapshotScriptPath,
  workflowSnapshotReports,
  workflowSnapshotReportCount,
  workflowSnapshotArtifacts,
  serializeWorkflowArtifact,
} from "./workflow-artifact.js";
// ⚠ 两个 artifact：上面那个是脚本的**顶层返回值**（引擎内部的 `RunSettlement.artifact`，进
// `<result>`），下面这个是脚本经 `artifact.*` **发布给用户看的产出**（进 `<artifacts>`）。
// 两者在同一条完成通知里并列出现，所以模块也分开。
import {
  buildWorkflowArtifactsNotificationSection,
  WORKFLOW_ARTIFACTS_NOTIFICATION_MAX_LINES,
} from "./workflow-published-artifacts.js";

type BackgroundTaskWaiter = {
  waitForBackgroundTask(
    taskId: string,
    options?: { signal?: AbortSignal },
  ): Promise<BackgroundTaskSnapshot | undefined>;
};

type WorkflowTaskWaiter = {
  waitForTask(
    taskId: string,
    options?: { signal?: AbortSignal },
  ): Promise<BackgroundTaskSnapshot | undefined>;
};

/**
 * 一个工具的后台生命周期提供者。这五件事若按工具名散在五处 `if (toolCall.name === …)`，
 * 每接一个后台工具就要记得同时改齐五处——`canCancelBackgroundTask` 对 legacy `Workflow`
 * 硬返回 false 就会是漏改的现场：它让 started payload 的 cancellable 恒假，取消入口直接死掉。
 * 按工具名查一次表拿到这个结构，五处分派退化成读它的字段。
 *
 * 缺省语义（字段缺席）与泛化前逐字一致：无 getSnapshot → 无快照提供者（不起 1s 轮询）；
 * 无 waitForTerminal → 无直接等待者；cancellable 缺省 false。
 */
interface BackgroundTaskLifecycleProvider {
  /** 1s 轮询的快照源。 */
  getSnapshot?: (taskId: string) => Promise<BackgroundTaskSnapshot | undefined>;
  /** 终态直接等待者（比轮询更及时，且轮询源缺席时是唯一终态来源）。 */
  waitForTerminal?: (taskId: string) => Promise<BackgroundTaskSnapshot | undefined>;
  /** 运行中的任务是否可被用户取消；决定 started/updated payload 的 `cancellable`。 */
  cancellable?: boolean;
}

export class BackgroundTaskTracker {
  private readonly backgroundPollers = new Set<string>();

  constructor(private readonly deps: ToolExecutorDeps) {}

  async trackBackgroundTask(
    toolCall: ExecutableToolCall,
    output: unknown,
    traceContext: TraceContext,
    turnId: TurnId | undefined,
  ): Promise<void> {
    if (!isRecord(output)) return;
    if (!isBackgroundTaskLaunch(toolCall, output)) return;
    const taskId =
      typeof output.backgroundTaskId === "string"
        ? output.backgroundTaskId
        : typeof output.agentId === "string"
          ? output.agentId
          : undefined;
    if (!taskId || this.backgroundPollers.has(taskId)) return;

    this.backgroundPollers.add(taskId);
    registerRuntimeBackgroundTask(this.deps, toolCall, taskId, output, turnId);
    try {
      await this.emitBackgroundTaskEvent(
        SessionEventType.BackgroundTaskStarted,
        this.backgroundTaskPayload(toolCall, taskId, "running", undefined, output),
        traceContext,
        turnId,
      );
    } catch (error) {
      this.backgroundPollers.delete(taskId);
      removeRuntimeBackgroundTask(this.deps, toolCall, taskId);
      throw error;
    }

    const hasSnapshotProvider = this.hasBackgroundTaskSnapshotProvider(toolCall);
    const hasDirectWaiter = this.hasDirectBackgroundTaskWaiter(toolCall);
    this.deps.logger?.info?.("Background task tracking started", {
      ...traceContextToLogContext(traceContext),
      event: "background_task.tracking.started",
      hasDirectWaiter,
      hasSnapshotProvider,
      module: "core.tool.executor",
      taskId,
      toolName: toolCall.name,
    });

    if (!hasSnapshotProvider && !hasDirectWaiter) {
      this.deps.logger?.info?.("Background task tracking lost without snapshot source", {
        ...traceContextToLogContext(traceContext),
        event: "background_task.tracking.lost",
        module: "core.tool.executor",
        reason: "missing_snapshot_source",
        taskId,
        toolName: toolCall.name,
      });
      updateRuntimeBackgroundTask(this.deps, toolCall, taskId, "lost");
      this.maybeEnqueueBackgroundTaskNotification(
        toolCall,
        taskId,
        "lost",
        undefined,
        traceContext,
        output,
      );
      await this.emitBackgroundTaskEvent(
        SessionEventType.BackgroundTaskCompleted,
        this.backgroundTaskPayload(toolCall, taskId, "lost", undefined, output),
        traceContext,
        turnId,
      );
      this.backgroundPollers.delete(taskId);
      return;
    }

    // registry 的 terminal 先于事件持久化；owner 必须等待整个 tracker，不能只观察状态。
    const tracking = Promise.withResolvers<void>();
    this.deps.registerResidencyBlockingWork?.(tracking.promise);
    const track = (work: Promise<void>) => {
      this.deps.registerResidencyBlockingWork?.(work);
      return work;
    };
    let lastSnapshotSignature = "";
    let completing = false;
    let polling = false;
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let maxRuntimeTimer: ReturnType<typeof setTimeout> | undefined;

    const stopTracking = () => {
      if (timer) clearInterval(timer);
      timer = undefined;
      if (maxRuntimeTimer) clearTimeout(maxRuntimeTimer);
      maxRuntimeTimer = undefined;
      this.backgroundPollers.delete(taskId);
      tracking.resolve();
    };

    if (
      toolCall.name === "Bash" &&
      this.deps.runtimeScope === "subagent" &&
      this.deps.subagentBackgroundBashMaxMs !== undefined &&
      this.deps.executionPort?.cancelBackgroundTask
    ) {
      maxRuntimeTimer = setTimeout(() => {
        this.deps.logger?.warn("Subagent background Bash exceeded max runtime; cancelling", {
          ...traceContextToLogContext(traceContext),
          event: "background_task.subagent_bash.max_runtime_exceeded",
          module: "core.tool.executor",
          taskId,
          toolName: toolCall.name,
        });
        void Promise.resolve(this.deps.executionPort?.cancelBackgroundTask?.(taskId)).catch(
          (error) => {
            this.deps.logger?.warn("Subagent background Bash cancellation failed", {
              ...traceContextToLogContext(traceContext),
              errorMessage: error instanceof Error ? error.message : String(error),
              event: "background_task.subagent_bash.cancel_failed",
              module: "core.tool.executor",
              taskId,
              toolName: toolCall.name,
            });
          },
        );
      }, this.deps.subagentBackgroundBashMaxMs);
    }

    const emitRunningUpdate = async (snapshot: BackgroundTaskSnapshot) => {
      if (stopped) return;
      const signature = this.backgroundSnapshotSignature(snapshot);
      if (signature === lastSnapshotSignature) return;
      lastSnapshotSignature = signature;
      updateRuntimeBackgroundTask(this.deps, toolCall, taskId, "running", snapshot);
      await this.emitBackgroundTaskEvent(
        SessionEventType.BackgroundTaskUpdated,
        this.backgroundTaskPayload(toolCall, taskId, "running", snapshot, output),
        traceContext,
        turnId,
      );
    };

    const emitTerminalSnapshot = async (
      snapshot: BackgroundTaskSnapshot | undefined,
    ): Promise<void> => {
      if (stopped || completing) return;
      completing = true;
      try {
        if (!snapshot) {
          this.deps.logger?.info?.("Background task terminal snapshot missing", {
            ...traceContextToLogContext(traceContext),
            event: "background_task.tracking.lost",
            module: "core.tool.executor",
            reason: "snapshot_missing",
            taskId,
            toolName: toolCall.name,
          });
          updateRuntimeBackgroundTask(this.deps, toolCall, taskId, "lost");
          this.maybeEnqueueBackgroundTaskNotification(
            toolCall,
            taskId,
            "lost",
            undefined,
            traceContext,
            output,
          );
          await this.emitBackgroundTaskEvent(
            SessionEventType.BackgroundTaskCompleted,
            this.backgroundTaskPayload(toolCall, taskId, "lost", undefined, output),
            traceContext,
            turnId,
          );
          stopped = true;
          stopTracking();
          return;
        }

        if (snapshot.status === "running") {
          updateRuntimeBackgroundTask(this.deps, toolCall, taskId, "running", snapshot);
          await emitRunningUpdate(snapshot);
          if (!hasSnapshotProvider) {
            stopped = true;
            stopTracking();
          }
          return;
        }

        if (this.isNotifiedLocalAgentSnapshot(toolCall, snapshot)) {
          this.deps.logger?.debug?.(
            "Background task terminal notification already handled by subagent",
            {
              ...traceContextToLogContext(traceContext),
              event: "background_task.tracking.notification_already_handled",
              module: "core.tool.executor",
              taskId,
              toolName: toolCall.name,
            },
          );
          stopped = true;
          stopTracking();
          return;
        }

        this.deps.logger?.info?.("Background task terminal snapshot observed", {
          ...traceContextToLogContext(traceContext),
          event: "background_task.tracking.terminal",
          module: "core.tool.executor",
          taskId,
          taskStatus: snapshot.status,
          toolName: toolCall.name,
          // 与 Bash 前台 `tool.bash.process.*` 日志同一组字段，便于用 pid 对回系统侧记录。
          toolCallId: toolCall.id,
          ...(toolCall.name === "Bash"
            ? backgroundExecutionLogFields(snapshot as BackgroundExecutionSnapshot)
            : {}),
        });
        updateRuntimeBackgroundTask(this.deps, toolCall, taskId, snapshot.status, snapshot);
        this.maybeEnqueueBackgroundTaskNotification(
          toolCall,
          taskId,
          snapshot.status,
          snapshot,
          traceContext,
        );
        await this.emitBackgroundTaskEvent(
          SessionEventType.BackgroundTaskCompleted,
          this.backgroundTaskPayload(toolCall, taskId, snapshot.status, snapshot, output),
          traceContext,
          turnId,
        );
        stopped = true;
        stopTracking();
      } finally {
        completing = false;
      }
    };

    const poll = async () => {
      if (polling || stopped || !hasSnapshotProvider) return;
      polling = true;
      try {
        const snapshot = await this.getBackgroundTaskSnapshot(toolCall, taskId);
        if (stopped || completing) return;
        if (!snapshot) {
          await emitTerminalSnapshot(undefined);
          return;
        }

        if (snapshot.status === "running") {
          await emitRunningUpdate(snapshot);
          return;
        }

        await emitTerminalSnapshot(snapshot);
      } catch (error) {
        this.deps.logger?.warn("Background task polling failed", {
          ...traceContextToLogContext(traceContext),
          errorMessage: error instanceof Error ? error.message : String(error),
          module: "core.tool.executor",
          taskId,
        });
      } finally {
        polling = false;
      }
    };

    const waitForCompletion = async () => {
      try {
        const snapshot = await this.waitForBackgroundTaskSnapshot(toolCall, taskId);
        await emitTerminalSnapshot(snapshot);
      } catch (error) {
        this.deps.logger?.warn("Background task wait failed", {
          ...traceContextToLogContext(traceContext),
          errorMessage: error instanceof Error ? error.message : String(error),
          module: "core.tool.executor",
          taskId,
        });
        if (!hasSnapshotProvider) {
          stopped = true;
          stopTracking();
        }
      }
    };

    if (hasSnapshotProvider) {
      timer = setInterval(() => {
        void track(poll());
      }, 1_000);
      timer.unref?.();
      await track(poll());
    }

    if (hasDirectWaiter && !stopped) {
      void track(waitForCompletion());
    }
  }

  private async emitBackgroundTaskEvent(
    type: SessionEvent["type"],
    payload: Record<string, unknown>,
    traceContext: TraceContext,
    turnId: TurnId | undefined,
  ): Promise<void> {
    await this.deps.emitEvent({
      id: crypto.randomUUID() as any,
      sessionId: this.deps.sessionId,
      turnId,
      type,
      timestamp: new Date(),
      traceId: traceContext.traceId,
      sequenceNumber: 0,
      payload,
    });
  }

  private backgroundTaskPayload(
    toolCall: ExecutableToolCall,
    taskId: string,
    status: string,
    snapshot?: BackgroundTaskSnapshot,
    output?: Record<string, unknown>,
  ): Record<string, unknown> {
    const input = isRecord(toolCall.input) ? toolCall.input : {};
    const outputMetadata = backgroundTaskOutputMetadata(snapshot, output);

    return {
      taskId,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      // V4 projection 过去从 toolName 手写推断类型，漏掉真实 Agent
      // 工具名后把后台 subagent 投成 bash/process。runtime 在事实产生处一次裁决。
      // 生命周期行为不受影响——那已经由 per-tool 的 lifecycleProvider 分派。
      taskKind: backgroundTaskKind(toolCall.name),
      childSessionId: outputMetadata.childSessionId,
      cancellable: status === "running" && this.canCancelBackgroundTask(toolCall),
      command: typeof input.command === "string" ? input.command : undefined,
      // CreateWorkflow 的输入 schema 里没有 `description`（只有 `{name?, script}`，
      // contracts/src/tools/create-workflow.ts），走通用的 input.description → snapshot.description
      // 链会整字段缺席，Workflows 分区的题名于是退到 toolName，每个 run 都显示成
      // "CreateWorkflow"。展示名与完成通知共用同一条兜底链（含 input.name），所以直接复用
      // workflowTaskSubject。它最后一环是 taskId（≡ runId）：投影会把它原样当题名，与缺席时
      // 退 toolName 并不相同——UI 侧约定 title ≡ workId 视同「无名」并换用 fallbackName，
      // 所以这一环到不了用户眼前，同时保住了「description 恒非空」的简单性。
      // dwf 分派名扩到 ResumeWorkflowRun：同一条兜底链（它也只有 run_id，无 description）。
      description: isDynamicWorkflowRunDispatchToolName(toolCall.name)
        ? workflowTaskSubject(toolCall, taskId, snapshot, output)
        : typeof input.description === "string"
          ? input.description
          : snapshot && "description" in snapshot
            ? snapshot.description
            : undefined,
      status,
      pid: snapshot && "pid" in snapshot ? snapshot.pid : undefined,
      startedAt: snapshot?.startedAt,
      completedAt: snapshot?.completedAt,
      outputPath: outputMetadata.outputFile,
      stderrPersistedOutputPath: outputMetadata.stderrFile,
      stdoutPersistedOutputPath: outputMetadata.stdoutFile,
      outputBytes: outputMetadata.outputBytes,
      outputTruncated: outputMetadata.outputTruncated,
      outputTail: outputMetadata.outputTail,
      stderrBytes: outputMetadata.stderrBytes,
      stderrTail: outputMetadata.stderrTail,
      stdoutBytes: outputMetadata.stdoutBytes,
      stdoutTail: outputMetadata.stdoutTail,
      terminalId: taskId,
    };
  }

  private backgroundSnapshotSignature(snapshot: BackgroundTaskSnapshot): string {
    return JSON.stringify({
      pid: snapshot && "pid" in snapshot ? snapshot.pid : undefined,
      stderrBytes: snapshot && "stderrBytes" in snapshot ? snapshot.stderrBytes : undefined,
      stderrTail: snapshot && "stderrTail" in snapshot ? snapshot.stderrTail : undefined,
      stdoutBytes: snapshot && "stdoutBytes" in snapshot ? snapshot.stdoutBytes : undefined,
      stdoutTail: snapshot && "stdoutTail" in snapshot ? snapshot.stdoutTail : undefined,
    });
  }

  private canCancelBackgroundTask(toolCall: ExecutableToolCall): boolean {
    return this.lifecycleProvider(toolCall).cancellable === true;
  }

  private isNotifiedLocalAgentSnapshot(
    toolCall: ExecutableToolCall,
    snapshot: BackgroundTaskSnapshot,
  ): boolean {
    const record = snapshot as unknown as Record<string, unknown>;
    return (
      isSubagentDispatchToolName(toolCall.name) &&
      record.type === "local_agent" &&
      record.notified === true
    );
  }

  private maybeEnqueueBackgroundTaskNotification(
    toolCall: ExecutableToolCall,
    taskId: string,
    status: string,
    snapshot: BackgroundTaskSnapshot | undefined,
    traceContext: TraceContext,
    output?: Record<string, unknown>,
  ): void {
    if (!this.deps.enqueueBackgroundTaskNotification) {
      this.deps.logger?.debug?.("Background task notification queue unavailable", {
        ...traceContextToLogContext(traceContext),
        event: "background_task.notification.queue_unavailable",
        module: "core.tool.executor",
        taskId,
        taskStatus: status,
        toolName: toolCall.name,
      });
      return;
    }

    // 被修订替代的 run 不发终态通知：
    // 停下它的那次 AmendWorkflow 的工具结果就是模型对这次停止的
    // 全部所知，再来一条「你停了 run A，现在去修订它」会把模型送进循环。仍然 claim：让稍后的
    // TaskOutput 读取不把它当成一条没送达的通知。
    if (workflowSnapshotTerminal(status, snapshot)?.stopReason === "superseded") {
      claimRuntimeBackgroundTaskNotification(this.deps, toolCall, taskId);
      this.deps.logger?.info?.("Background task notification suppressed: run superseded", {
        ...traceContextToLogContext(traceContext),
        event: "background_task.notification.suppressed",
        module: "core.tool.executor",
        reason: "workflow_run_superseded",
        taskId,
        taskStatus: status,
        toolName: toolCall.name,
      });
      return;
    }

    if (
      this.deps.shouldEnqueueBackgroundTaskNotification?.({
        runtimeScope: this.deps.runtimeScope,
        status,
        taskId,
        toolName: toolCall.name,
        traceContext,
      }) === false
    ) {
      this.deps.logger?.info?.("Background task notification suppressed by runtime policy", {
        ...traceContextToLogContext(traceContext),
        event: "background_task.notification.suppressed",
        module: "core.tool.executor",
        taskId,
        taskStatus: status,
        toolName: toolCall.name,
      });
      return;
    }

    const text = this.formatBackgroundTaskNotification(toolCall, taskId, status, snapshot, output);
    if (!text) {
      this.deps.logger?.debug?.("Background task notification skipped without formatted message", {
        ...traceContextToLogContext(traceContext),
        event: "background_task.notification.skipped",
        module: "core.tool.executor",
        reason: "empty_message",
        taskId,
        taskStatus: status,
        toolName: toolCall.name,
      });
      return;
    }
    // TaskOutput 读取终态会先把同一 registry task 标成 notified；
    // completion 只有成功 claim 后才能入队，避免模型同时收到 tool result 和重复通知。
    if (!claimRuntimeBackgroundTaskNotification(this.deps, toolCall, taskId)) {
      this.deps.logger?.debug?.("Background task notification already claimed", {
        ...traceContextToLogContext(traceContext),
        event: "background_task.tracking.notification_already_handled",
        module: "core.tool.executor",
        taskId,
        taskStatus: status,
        toolName: toolCall.name,
      });
      return;
    }
    try {
      this.deps.enqueueBackgroundTaskNotification({
        ...(toolCall.name === "Bash"
          ? {
              originMeta: {
                backgroundSource: "bash" as const,
                title: resolveBashBackgroundResultTitle(toolCall, taskId),
                workId: taskId,
              },
            }
          : {}),
        // workflow run 的终态回合要渲染成后台结果头，而不是退化成一条裸 model-only 消息，
        // 所以 originMeta 必须带上（workId ≡ runId）。CreateWorkflow 与 ResumeWorkflowRun
        // 两个入口同构（分派见 isDynamicWorkflowRunDispatchToolName）。manifest 载荷
        // （workflowNotification）在此处发射侧铸造：GUI 渲染的唯一数据源，随 originMeta 走全管线。
        ...(isDynamicWorkflowRunDispatchToolName(toolCall.name)
          ? {
              originMeta: buildWorkflowNotificationOriginMeta(
                toolCall,
                taskId,
                status,
                snapshot,
                output,
              ),
            }
          : {}),
        taskId,
        text,
        toolName: toolCall.name,
        traceContext,
      });
    } catch (error) {
      releaseRuntimeBackgroundTaskNotification(this.deps, toolCall, taskId);
      this.deps.logger?.warn("Background task notification enqueue failed", {
        ...traceContextToLogContext(traceContext),
        errorMessage: error instanceof Error ? error.message : String(error),
        module: "core.tool.executor",
        taskId,
      });
      return;
    }
    this.deps.logger?.info?.("Background task notification enqueued", {
      ...traceContextToLogContext(traceContext),
      event: "background_task.notification.enqueued",
      module: "core.tool.executor",
      taskId,
      taskStatus: status,
      toolName: toolCall.name,
    });
  }

  private formatBackgroundTaskNotification(
    toolCall: ExecutableToolCall,
    taskId: string,
    status: string,
    snapshot: BackgroundTaskSnapshot | undefined,
    output?: Record<string, unknown>,
  ): string | undefined {
    // workflow run 复用 legacy Workflow 的通知格式（复用 formatWorkflowTaskNotification）。
    // legacy "Workflow" 保持独立并列：它没有 dwf 的产物/reports 语义，只在共享格式器里
    // 走自己的 output.response 回退分支。
    if (toolCall.name === "Workflow" || isDynamicWorkflowRunDispatchToolName(toolCall.name)) {
      return this.formatWorkflowTaskNotification(toolCall, taskId, status, snapshot, output);
    }
    if (toolCall.name !== "Bash") return undefined;

    const input = isRecord(toolCall.input) ? toolCall.input : {};
    const command = typeof input.command === "string" ? input.command : undefined;
    const description = typeof input.description === "string" ? input.description : undefined;
    const result = snapshot && "result" in snapshot ? snapshot.result : undefined;
    const outputMetadata = backgroundTaskOutputMetadata(snapshot, output);
    const notificationStatus = normalizeBashTaskNotificationStatus(status);
    const summary = buildBackgroundTaskSummary({
      command,
      description,
      exitCode: result?.exitCode,
      lost: status === "lost",
      status: notificationStatus,
    });
    return formatTaskNotification({
      description,
      outputFile: outputMetadata.outputFile,
      status: notificationStatus,
      summary,
      taskId,
      taskType: "local_bash",
      toolUseId: toolCall.id,
    });
  }

  private formatWorkflowTaskNotification(
    toolCall: ExecutableToolCall,
    taskId: string,
    status: string,
    snapshot: BackgroundTaskSnapshot | undefined,
    launchOutput?: Record<string, unknown>,
  ): string {
    const output =
      snapshot && "output" in snapshot && isRecord(snapshot.output)
        ? snapshot.output
        : launchOutput;
    const subject = workflowTaskSubject(toolCall, taskId, snapshot, output);
    const notificationStatus = normalizeBackgroundTaskNotificationStatus(status);
    // dwf 的三终态词与停止原因从快照读：run service 把
    // journal 里的 `stopReason` 投影到 `snapshot.stopReason`，所以「谁停的」不再只活在 registry。
    // registry 的 stopInitiator 只作兼容兜底（老端口 / stub 不发 stopReason 时）。
    const terminal = workflowSnapshotTerminal(status, snapshot);
    const stopReason =
      terminal?.stopReason ??
      (status === "cancelled"
        ? this.deps.runtimeTaskRegistry?.get(taskId)?.stopInitiator
        : undefined);
    const summary = buildWorkflowTaskSummary({
      lost: status === "lost",
      status: notificationStatus,
      runStatus: terminal?.runStatus,
      stopReason,
      subject,
    });
    // dwf 与 legacy `Workflow` 在**结果**这一项上分道：
    //   - dwf 的产物是脚本的任意顶层返回值，取 `snapshot.output` 原值并统一序列化，且**绝不**
    //     回退到 launch output——后者的 `response` 是「run 已在后台启动」的陈旧散文，
    //     回退过去比缺席更糟（桌面实测 bug 的第二种表现）。
    //   - legacy `Workflow` 的 `output.response` 真实存在，launchOutput 回退是它自己的契约，
    //     逐字节保留。
    // subject 仍走上面那个 record 门控的 output（展示名不涉及产物形状）。
    // dwf 分派名扩到 ResumeWorkflowRun：恢复的 run 与新启动的 run 在通知形状上同构。
    const result = isDynamicWorkflowRunDispatchToolName(toolCall.name)
      ? serializeWorkflowArtifact(snapshot && "output" in snapshot ? snapshot.output : undefined)
      : stringField(output, "response");
    // 渐进产物（`report(item)`）只属于 dwf：legacy `Workflow` 没有这个概念，它的通知逐字节不变。
    // **三个终态一律携带**（completed / failed / cancelled）：一个死在第 12 个 ask 上的 run
    // 仍然做完了 11 个 ask 的活，只报一句「失败」等于把它全扔了——那正是 report 存在的理由。
    // 条目来自 journal 的 kind="report" 行（run service 放在快照上），不是 memory-only 的投影。
    const isDynamicWorkflow = isDynamicWorkflowRunDispatchToolName(toolCall.name);
    const reports = isDynamicWorkflow
      ? buildWorkflowReportsNotificationSection(
          workflowSnapshotReports(snapshot),
          workflowSnapshotReportCount(snapshot),
        )
      : undefined;
    // 用户面产物同样只属于 dwf（legacy `Workflow` 没有这个概念，通知逐字节不变）。三个终态
    // 一律携带：一个失败的 run 已经发布的产物仍然摆在用户面前，通知不提它，模型就会重述一遍。
    const artifacts = isDynamicWorkflow
      ? buildWorkflowArtifactsNotificationSection(
          workflowSnapshotArtifacts(snapshot),
          WORKFLOW_ARTIFACTS_NOTIFICATION_MAX_LINES,
        )
      : undefined;
    // 脚本文件同样只属于 dwf：呈现指引据它把
    // 下一步说成「就地编辑那个文件」。journal 存的是绝对路径，模型面给工作区相对写法——
    // 它接下来要 Edit 这个文件，而那正是它在别处读写文件时用的那一种路径。
    const scriptPath = isDynamicWorkflow ? workflowSnapshotScriptPath(snapshot) : undefined;
    return formatTaskNotification({
      description: subject,
      // 交付物呈现指引同样只属于 dwf。
      ...(isDynamicWorkflow ? { deliveryGuidance: true } : {}),
      ...(scriptPath === undefined
        ? {}
        : { scriptPath: describeWorkflowScriptPath(scriptPath, this.deps.getWorkingDirectory()) }),
      error: snapshot && "error" in snapshot ? runtimeString(snapshot.error) : undefined,
      ...(reports === undefined ? {} : { reports }),
      ...(artifacts === undefined ? {} : { artifacts }),
      result,
      status: notificationStatus,
      ...(terminal?.runStatus === undefined ? {} : { runStatus: terminal.runStatus }),
      ...(stopReason === undefined ? {} : { stopReason }),
      ...(terminal?.failure === undefined ? {} : { failure: terminal.failure }),
      summary,
      taskId,
      taskType: "local_workflow",
      toolUseId: toolCall.id,
    });
  }

  private hasBackgroundTaskSnapshotProvider(toolCall: ExecutableToolCall): boolean {
    return this.lifecycleProvider(toolCall).getSnapshot !== undefined;
  }

  private hasDirectBackgroundTaskWaiter(toolCall: ExecutableToolCall): boolean {
    return this.lifecycleProvider(toolCall).waitForTerminal !== undefined;
  }

  private async waitForBackgroundTaskSnapshot(
    toolCall: ExecutableToolCall,
    taskId: string,
  ): Promise<BackgroundTaskSnapshot | undefined> {
    return this.lifecycleProvider(toolCall).waitForTerminal?.(taskId);
  }

  private async getBackgroundTaskSnapshot(
    toolCall: ExecutableToolCall,
    taskId: string,
  ): Promise<BackgroundTaskSnapshot | undefined> {
    return this.lifecycleProvider(toolCall).getSnapshot?.(taskId);
  }

  /**
   * 按工具名解析后台生命周期提供者。每个分支只描述"这个工具的四件事分别由哪个端口承担"，
   * 与泛化前的五处 if 一一对应，语义逐字保持。
   */
  private lifecycleProvider(toolCall: ExecutableToolCall): BackgroundTaskLifecycleProvider {
    const deps = this.deps;

    if (isSubagentDispatchToolName(toolCall.name)) {
      const getTask = deps.subagentPort?.getTask;
      return {
        ...(getTask
          ? { getSnapshot: (taskId: string) => getTask.call(deps.subagentPort, taskId) }
          : {}),
        // 修复原因：background Agent 的停止入口在 subagentPort.stopTask；
        // started payload 不能沿用 Bash 的 executionPort 能力判断。
        cancellable: Boolean(deps.subagentPort?.stopTask),
      };
    }

    if (isDynamicWorkflowRunDispatchToolName(toolCall.name)) {
      // workflow run：快照/等待/取消全部来自窄端口 DynamicWorkflowRunPort（runId ≡ taskId ≡ workId）。
      // 取消能力以 cancel 方法存在为准，而不是硬编码——端口在场即可取消，这正是详情页
      // Cancel 按钮与后台面板停止共用的那条唯一路径的前提。CreateWorkflow（新启动）与
      // ResumeWorkflowRun（恢复）共用同一 provider：registry 条目重臂时经 existing 合并
      // 语义沿用原始工具行的 parentToolCallId，两条入口对 tracker 完全同构。
      const port = deps.dynamicWorkflowRunPort;
      if (port === undefined) return {};
      return {
        getSnapshot: (taskId: string) => port.getTask(taskId),
        ...(typeof port.waitForTask === "function"
          ? { waitForTerminal: (taskId: string) => port.waitForTask(taskId) }
          : {}),
        cancellable: typeof port.cancel === "function",
      };
    }

    if (toolCall.name === "Workflow") {
      // legacy Workflow：只有快照与等待，没有取消——停止入口从未接过（保持泛化前的 false）。
      const getTask = deps.workflowPort?.getTask;
      const waiter = getWorkflowTaskWaiter(deps.workflowPort);
      return {
        ...(getTask
          ? { getSnapshot: (taskId: string) => getTask.call(deps.workflowPort, taskId) }
          : {}),
        ...(waiter ? { waitForTerminal: (taskId: string) => waiter.waitForTask(taskId) } : {}),
        cancellable: false,
      };
    }

    if (toolCall.name === "Bash") {
      const waiter = getBackgroundTaskWaiter(deps.executionPort);
      const getBackgroundTask = deps.executionPort?.getBackgroundTask;
      return {
        ...(getBackgroundTask
          ? { getSnapshot: (taskId: string) => getBackgroundTask.call(deps.executionPort, taskId) }
          : {}),
        ...(waiter
          ? { waitForTerminal: (taskId: string) => waiter.waitForBackgroundTask(taskId) }
          : {}),
        cancellable: Boolean(deps.executionPort?.cancelBackgroundTask),
      };
    }

    // 其余工具沿用 executionPort 的通用后台面（无直接等待者），与泛化前一致。
    const getBackgroundTask = deps.executionPort?.getBackgroundTask;
    return {
      ...(getBackgroundTask
        ? { getSnapshot: (taskId: string) => getBackgroundTask.call(deps.executionPort, taskId) }
        : {}),
      cancellable: Boolean(deps.executionPort?.cancelBackgroundTask),
    };
  }
}

function isBackgroundTaskLaunch(
  toolCall: ExecutableToolCall,
  output: Record<string, unknown>,
): boolean {
  if (output.status === "backgrounded") return true;
  return isSubagentDispatchToolName(toolCall.name) && output.status === "async_launched";
}

type BashTaskNotificationStatus = "completed" | "failed" | "killed";

function normalizeBashTaskNotificationStatus(status: string): BashTaskNotificationStatus {
  return normalizeBackgroundTaskNotificationStatus(status);
}

function normalizeBackgroundTaskNotificationStatus(status: string): BashTaskNotificationStatus {
  switch (status) {
    case "completed":
      return "completed";
    case "cancelled":
    case "timed_out":
    case "killed":
    case "stopped":
      return "killed";
    default:
      return "failed";
  }
}

function resolveBashBackgroundResultTitle(toolCall: ExecutableToolCall, taskId: string): string {
  const input = isRecord(toolCall.input) ? toolCall.input : {};
  const description = stringField(input, "description")?.trim();
  const command = stringField(input, "command")?.trim();
  return description || command || toolCall.name || taskId;
}

function buildBackgroundTaskSummary(input: {
  command?: string;
  description?: string;
  exitCode?: number;
  lost?: boolean;
  status: BashTaskNotificationStatus;
}): string {
  const subject = input.description ?? input.command ?? "Bash background command";
  const prefix = `Background command "${subject}"`;
  // Provider-visible summary 保持简洁；完整输出路径由 task-notification 的 output-file 字段承载。
  if (input.lost) return `${prefix} failed because its in-process state was lost`;
  switch (input.status) {
    case "completed":
      return `${prefix} completed${input.exitCode !== undefined ? ` (exit code ${input.exitCode})` : ""}`;
    case "failed":
      return `${prefix} failed${input.exitCode !== undefined ? ` with exit code ${input.exitCode}` : ""}`;
    case "killed":
      return `${prefix} was stopped`;
  }
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function getBackgroundTaskWaiter(
  executionPort: ExecutionPort | undefined,
): BackgroundTaskWaiter | undefined {
  const candidate = executionPort as Partial<BackgroundTaskWaiter> | undefined;
  return typeof candidate?.waitForBackgroundTask === "function"
    ? (candidate as BackgroundTaskWaiter)
    : undefined;
}

function getWorkflowTaskWaiter(workflowPort: unknown): WorkflowTaskWaiter | undefined {
  const candidate = workflowPort as Partial<WorkflowTaskWaiter> | undefined;
  return typeof candidate?.waitForTask === "function"
    ? (candidate as WorkflowTaskWaiter)
    : undefined;
}

/**
 * 后台任务的展示类别（面板分组与图标）。`taskKind` 只是装饰：生命周期语义已经由
 * per-tool 的 lifecycleProvider 分派，所以这里的分类改动不会影响观察/等待/取消。
 *
 * legacy `Workflow`（script workflow）刻意仍归 "bash"：它不可取消、面板上也没有详情页，
 * 与 workflow run 是两种不同的东西，共用一个类别会让面板把两者混在一起。
 */
function backgroundTaskKind(toolName: string): "bash" | "subagent" | "workflow" {
  if (isSubagentDispatchToolName(toolName)) return "subagent";
  // dwf 的两个入口（CreateWorkflow / ResumeWorkflowRun）同归 "workflow"：同一个 run 的
  // 生命周期延续，面板分组与图标不该因入口不同而换类。
  return isDynamicWorkflowRunDispatchToolName(toolName) ? "workflow" : "bash";
}

function backgroundExecutionLogFields(
  execution: BackgroundExecutionSnapshot,
): Record<string, unknown> {
  return {
    pid: execution.pid ?? execution.result?.pid,
    exitCode: execution.result?.exitCode,
    signal: execution.result?.signal,
    durationMs: execution.result?.durationMs,
  };
}
