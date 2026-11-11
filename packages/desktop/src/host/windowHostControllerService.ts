/* eslint-disable max-lines -- Controller source 聚合、路由、订阅与生命周期属于同一个 Host 边界。 */
import { Emitter, Event } from "@zcode/rpc";
import type { ZCodeTaskMeta } from "@zcode/shared";
import type {
  ControllerSubscribeParams,
  WindowHostControllerTaskRow,
  WindowHostTaskAddress,
} from "@zcode/shared/zcode-protocol-v4";
import {
  CONTROLLER_TASKS_INDEX_TOPIC,
  matchesTaskListMembershipKind,
  windowHostTaskAddressSchema,
} from "@zcode/shared/zcode-protocol-v4";
import type {
  IWindowControllerService,
  IZCodeAgentService,
  IZCodeTaskService,
  WindowHostControllerFrame,
  WindowHostControllerTaskListItem,
  WindowHostControllerTaskListResult,
  WindowHostTaskUnreadSignal,
  WindowHostTasksRemovedSignal,
  ZCodeTaskListQuery,
  ZCodeTaskListWorkspaceScope,
} from "@zcode/services";
import {
  createWindowHostControllerProjection,
  type WindowHostControllerMutation,
  type WindowHostControllerMutationResult,
  type WindowHostControllerSessionOverlay,
  type WindowHostControllerSourceScope,
} from "./windowHostControllerProjection.js";
import {
  createWindowHostSessionsIndexObserver,
  type WindowHostSessionsIndexObserver,
} from "./windowHostSessionsIndexObserver.js";

export interface ResolvedWindowHostControllerSource {
  scope: WindowHostControllerSourceScope;
  taskService?: IZCodeTaskService;
  agentService?: IZCodeAgentService;
  sourceAvailability: "online" | "offline";
}

function sourceKey(scope: WindowHostControllerSourceScope): string {
  return `${scope.kind}\0${scope.kind === "remote" ? (scope.sourceServerId ?? scope.remoteSessionId) : "local"}\0${scope.workspaceIdentity?.trim() || scope.workspacePath}`;
}

function taskKey(task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">) {
  return `${task.workspaceIdentity?.trim() || task.workspacePath}\0${task.taskId}`;
}

function normalizeTaskMeta(
  meta: ZCodeTaskMeta,
  scope: WindowHostControllerSourceScope,
): ZCodeTaskMeta {
  return {
    ...meta,
    workspacePath: scope.workspacePath,
    ...(scope.workspaceIdentity
      ? { workspaceIdentity: scope.workspaceIdentity }
      : { workspaceIdentity: undefined }),
  };
}

function compareItems(
  left: WindowHostControllerTaskListItem,
  right: WindowHostControllerTaskListItem,
  sortBy: ZCodeTaskListQuery["sortBy"],
): number {
  const leftAt = sortBy === "created" ? left.createdAt : left.updatedAt;
  const rightAt = sortBy === "created" ? right.createdAt : right.updatedAt;
  return rightAt - leftAt || left.taskId.localeCompare(right.taskId);
}

function mutationParams(address: WindowHostTaskAddress) {
  return {
    taskId: address.taskId,
    workspacePath: address.workspacePath,
    ...(address.workspaceIdentity ? { workspaceIdentity: address.workspaceIdentity } : {}),
  };
}

function sessionOverlay(
  summary: import("@zcode/shared/zcode-protocol-v4").SessionSummary,
): WindowHostControllerSessionOverlay {
  const liveStatus: WindowHostControllerSessionOverlay["liveStatus"] =
    summary.pendingInteraction ||
    (summary.pendingInteractionSummary &&
      summary.pendingInteractionSummary.permissionCount +
        summary.pendingInteractionSummary.userInputCount >
        0)
      ? "waiting"
      : summary.phase === "prewarming" || summary.phase === "running"
        ? "running"
        : summary.phase === "error"
          ? "error"
          : summary.phase === "completedSuccess" || summary.phase === "completedInterrupted"
            ? "completed"
            : "idle";
  return {
    taskId: summary.sessionId,
    liveStatus,
    title: summary.title,
    ...(summary.titleSource ? { titleSource: summary.titleSource } : {}),
    updatedAt: summary.lastActivityAt,
    ...(summary.pendingInteraction
      ? {
          pendingInteraction: {
            interactionId: summary.pendingInteraction.interactionId,
            kind: summary.pendingInteraction.kind,
            ...(summary.pendingInteraction.toolName
              ? { toolName: summary.pendingInteraction.toolName }
              : {}),
            ...(summary.pendingInteraction.autoResolution
              ? { autoResolution: summary.pendingInteraction.autoResolution }
              : {}),
          },
        }
      : {}),
    activity: {
      phase: summary.phase,
      lastActivityAt: summary.lastActivityAt,
      hasBackgroundWork: summary.hasBackgroundWork,
      ...(summary.pendingInteractionSummary
        ? { pendingInteractions: summary.pendingInteractionSummary }
        : {}),
      ...(summary.workflowActivity ? { workflowActivity: summary.workflowActivity } : {}),
    },
  };
}

function liveStatusFromMeta(meta: ZCodeTaskMeta): WindowHostControllerTaskRow["liveStatus"] {
  if (meta.status === "completed") return "completed";
  if (meta.status === "error") return "error";
  return "idle";
}

/**
 * WindowHostControllerRuntime 是 Local Host 内的聚合权威。它不持久化数据；每次在线查询都从
 * 对应 source 的 tasks-index 重建投影，断连时只冻结最后一次成功的内存快照。
 */
export function createWindowHostControllerRuntime(options: {
  onRunStarted?: (run: import("@zcode/shared/web-remote-relay").MobilePushRun) => void;
  onNotification?: (event: import("@zcode/shared/web-remote-relay").MobilePushEvent) => void;
  createId: () => string;
  readHostTaskList: IZCodeTaskService["listTaskList"];
  resolveSource: (scope: ZCodeTaskListWorkspaceScope) => ResolvedWindowHostControllerSource | null;
  onSourceError?: (
    scope: WindowHostControllerSourceScope,
    operation: "refresh" | "search",
    error: unknown,
  ) => void;
  onTasksArchivedOrDeleted?: (scope: WindowHostControllerSourceScope, taskIds: string[]) => void;
}) {
  const projection = createWindowHostControllerProjection({ createId: options.createId });
  const unreadSignals = new Emitter<WindowHostTaskUnreadSignal>();
  const tasksRemovedSignals = new Emitter<WindowHostTasksRemovedSignal>();
  const registeredScopes = new Map<string, WindowHostControllerSourceScope>();
  const sourceAvailability = new Map<string, "online" | "offline">();
  const sourceTaskServices = new Map<string, IZCodeTaskService>();
  const sourceSnapshotTaskServices = new Map<string, IZCodeTaskService>();
  const sourceEventSubscriptions = new Map<string, { dispose(): void }>();
  const sourceRefreshFlights = new Map<
    string,
    { taskService: IZCodeTaskService; promise: Promise<void> }
  >();
  const sourceRefreshGenerations = new Map<string, number>();
  const sourceLiveOverlays = new Map<string, WindowHostControllerSessionOverlay[]>();
  const sourceSessionObservers = new Map<
    string,
    { agentService: IZCodeAgentService; observer: WindowHostSessionsIndexObserver }
  >();
  const pendingReplacementByNextSourceKey = new Map<string, WindowHostControllerSourceScope>();

  function forgetRegisteredSource(scope: WindowHostControllerSourceScope): void {
    const key = sourceKey(scope);
    registeredScopes.delete(key);
    sourceAvailability.delete(key);
    sourceTaskServices.delete(key);
    sourceSnapshotTaskServices.delete(key);
    sourceEventSubscriptions.get(key)?.dispose();
    sourceEventSubscriptions.delete(key);
    sourceSessionObservers.get(key)?.observer.dispose();
    sourceSessionObservers.delete(key);
    sourceLiveOverlays.delete(key);
    sourceRefreshGenerations.set(key, (sourceRefreshGenerations.get(key) ?? 0) + 1);
    sourceRefreshFlights.delete(key);
  }

  function ensureSourceSessionObserver(
    resolved: ResolvedWindowHostControllerSource,
  ): WindowHostSessionsIndexObserver | null {
    const key = sourceKey(resolved.scope);
    if (resolved.sourceAvailability !== "online") {
      return sourceSessionObservers.get(key)?.observer ?? null;
    }
    if (!resolved.agentService) {
      sourceSessionObservers.get(key)?.observer.dispose();
      sourceSessionObservers.delete(key);
      if (sourceLiveOverlays.delete(key)) {
        projection.replaceSourceSessionOverlays(resolved.scope, []);
      }
      return null;
    }
    const current = sourceSessionObservers.get(key);
    if (current?.agentService === resolved.agentService) return current.observer;
    current?.observer.dispose();
    if (sourceLiveOverlays.delete(key)) {
      projection.replaceSourceSessionOverlays(resolved.scope, []);
    }
    let observer!: WindowHostSessionsIndexObserver;
    observer = createWindowHostSessionsIndexObserver({
      agentService: resolved.agentService,
      target: {
        workspacePath: resolved.scope.workspacePath,
        ...(resolved.scope.workspaceIdentity
          ? { workspaceIdentity: resolved.scope.workspaceIdentity }
          : {}),
      },
      onRunStarted: (run) => {
        if (
          sourceSessionObservers.get(key)?.observer === observer &&
          sourceAvailability.get(key) === "online"
        )
          options.onRunStarted?.(run);
      },
      onNotification: (event) => {
        if (
          sourceSessionObservers.get(key)?.observer === observer &&
          sourceAvailability.get(key) === "online"
        )
          options.onNotification?.(event);
      },
      onSessionsChange: (sessions) => {
        if (sourceSessionObservers.get(key)?.observer !== observer) return;
        const overlays = sessions.map(sessionOverlay);
        sourceLiveOverlays.set(key, overlays);
        projection.replaceSourceSessionOverlays(resolved.scope, overlays);
      },
      onError: (error) => options.onSourceError?.(resolved.scope, "refresh", error),
    });
    sourceSessionObservers.set(key, { agentService: resolved.agentService, observer });
    return observer;
  }

  function resolveCurrentSource(
    scope: WindowHostControllerSourceScope,
  ): ResolvedWindowHostControllerSource | null {
    return options.resolveSource({
      workspacePath: scope.workspacePath,
      ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
    });
  }

  function notifyTasksRemoved(
    scope: WindowHostControllerSourceScope,
    taskIds: string[],
    permanentlyDeleted = false,
  ): void {
    options.onTasksArchivedOrDeleted?.(scope, taskIds);
    tasksRemovedSignals.fire({
      permanentlyDeleted,
      workspacePath: scope.workspacePath,
      ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
      ...(scope.kind === "remote" && scope.remoteSessionId
        ? { remoteSessionId: scope.remoteSessionId }
        : {}),
      taskIds,
    });
  }

  async function executeMutation(
    scope: WindowHostControllerSourceScope,
    address: WindowHostTaskAddress,
    mutation: WindowHostControllerMutation,
  ): Promise<WindowHostControllerMutationResult> {
    const current = resolveCurrentSource(scope);
    if (!current?.taskService || current.sourceAvailability !== "online") {
      throw new Error(
        scope.kind === "remote" ? "远程 source 当前离线，禁止列表写操作" : "本地 source 当前不可用",
      );
    }
    const service = current.taskService;
    const base = mutationParams(address);
    switch (mutation.kind) {
      case "rename":
        await service.renameTask({ ...base, title: mutation.title });
        break;
      case "pin":
        await service.setTaskPinned({ ...base, pinned: mutation.pinned });
        break;
      case "archive":
        if (mutation.archived) await service.archiveTask(base);
        else await service.unarchiveTask(base);
        break;
      case "delete":
        await service.deleteTask(base);
        break;
      case "delete-archived":
        return await service.deleteArchivedTask(base);
      case "delete-archived-batch": {
        // 确认期间远端 session 可能已替换；不能将旧地址的批次写入同 identity 的新 source。
        if (sourceKey(current.scope) !== sourceKey(scope)) {
          throw new Error("归档删除批次的 source 已替换");
        }
        return await service.deleteArchivedTasks({
          workspacePath: base.workspacePath,
          workspaceIdentity: base.workspaceIdentity,
          taskIds: mutation.taskIds,
        });
      }
      case "mark-read":
        return normalizeTaskMeta(
          await service.setTaskUnread({
            ...base,
            unread: false,
            ...(mutation.expectedUnreadAt != null
              ? { expectedUnreadAt: mutation.expectedUnreadAt }
              : {}),
          }),
          current.scope,
        );
      case "mark-unread":
        return normalizeTaskMeta(
          await service.setTaskUnread({ ...base, unread: true }),
          current.scope,
        );
      case "open":
      case "resume":
        // open/resume 的 Controller 职责是验证唯一 source；conversation 随后仍走 scoped facade。
        break;
      default: {
        const exhaustive: never = mutation;
        throw new Error(`未知 Controller mutation: ${String(exhaustive)}`);
      }
    }
  }

  function registerResolvedSource(resolved: ResolvedWindowHostControllerSource): void {
    const key = sourceKey(resolved.scope);
    if (!registeredScopes.has(key)) {
      registeredScopes.set(key, resolved.scope);
      projection.registerSource({
        scope: resolved.scope,
        mutate: (address, mutation) => executeMutation(resolved.scope, address, mutation),
      });
    }
    const previousAvailability = sourceAvailability.get(key);
    sourceAvailability.set(key, resolved.sourceAvailability);
    if (
      resolved.taskService &&
      sourceSnapshotTaskServices.has(key) &&
      sourceSnapshotTaskServices.get(key) !== resolved.taskService
    ) {
      sourceSnapshotTaskServices.delete(key);
    }
    if (
      resolved.taskService &&
      resolved.sourceAvailability === "online" &&
      typeof resolved.taskService.onDynamicWorkspaceEvent === "function" &&
      sourceTaskServices.get(key) !== resolved.taskService
    ) {
      sourceEventSubscriptions.get(key)?.dispose();
      const taskService = resolved.taskService;
      const isCurrentSource = () => {
        const current = resolveCurrentSource(resolved.scope);
        return (
          sourceTaskServices.get(key) === taskService &&
          sourceAvailability.get(key) === "online" &&
          current?.taskService === taskService &&
          current?.sourceAvailability === "online"
        );
      };
      sourceTaskServices.set(key, taskService);
      sourceEventSubscriptions.set(
        key,
        taskService.onDynamicWorkspaceEvent({
          workspacePath: resolved.scope.workspacePath,
          ...(resolved.scope.workspaceIdentity
            ? { workspaceIdentity: resolved.scope.workspaceIdentity }
            : {}),
        })((event) => {
          // Bug 根因：Controller 接管观察后只刷新列表，丢掉了 Host 的明确完成信号。
          // 沿现有 source 监听转发实时事实；旧连接、离线 source 和普通快照都不能制造未读。
          if (!isCurrentSource()) return;
          const signal: WindowHostTaskUnreadSignal | undefined =
            event.type === "workspace_task_list_changed" &&
            event.reason === "task_status_changed" &&
            event.unreadSignal === "background_terminal" &&
            event.taskMeta &&
            (event.taskMeta.status === "completed" || event.taskMeta.status === "error")
              ? {
                  address: {
                    taskId: event.taskId ?? event.taskMeta.taskId,
                    workspacePath: resolved.scope.workspacePath,
                    ...(resolved.scope.workspaceIdentity
                      ? { workspaceIdentity: resolved.scope.workspaceIdentity }
                      : {}),
                    ...(resolved.scope.kind === "remote"
                      ? {
                          ...(resolved.scope.sourceServerId
                            ? { sourceServerId: resolved.scope.sourceServerId }
                            : {}),
                          ...(resolved.scope.remoteSessionId
                            ? { remoteSessionId: resolved.scope.remoteSessionId }
                            : {}),
                        }
                      : {}),
                  },
                  updatedAt: event.taskMeta.updatedAt,
                  status: event.taskMeta.status,
                }
              : undefined;
          // Bug 根因：等列表 IO 后才通知会漏记期间的查看；立即交给窗口记录，行就绪由 mutation 验证。
          if (signal) unreadSignals.fire(signal);
          // Bug 根因：tab 清理曾挂在 executeMutation 上，自动归档、CLI 删除等不经命令入口的移除会漏掉，
          // 出声的 Browser guest 留在后台。改为跟随 source 的任务事实流；批量永久删除只针对已归档任务，事件不带 taskId。
          if (
            event.type === "workspace_task_list_changed" &&
            (event.reason === "task_archived" || event.reason === "task_deleted") &&
            event.taskId
          ) {
            notifyTasksRemoved(resolved.scope, [event.taskId]);
          }
          // workspace event 可能在列表首轮 refresh 读取途中到达；直接复用
          // single-flight 会把事件吞掉。先等在途读取结束，再把多个事件合并成下一轮 refresh。
          const inFlight = sourceRefreshFlights.get(key)?.promise;
          void (async () => {
            await inFlight?.catch(() => {});
            if (!isCurrentSource()) return;
            const current = resolveCurrentSource(resolved.scope);
            if (current) {
              // 完成信号是已收到的事实，读取投影失败不能把它吞掉；写入仍由原 mutation 验证真实行。
              await refreshSource(current, true).catch((error) =>
                options.onSourceError?.(current.scope, "refresh", error),
              );
            }
          })().catch((error) => options.onSourceError?.(resolved.scope, "refresh", error));
        }),
      );
    }
    if (resolved.sourceAvailability === "offline" && previousAvailability === "online") {
      sourceSessionObservers.get(key)?.observer.dispose();
      sourceSessionObservers.delete(key);
      sourceSnapshotTaskServices.delete(key);
      projection.disconnectSource(resolved.scope);
    }
  }

  async function readSourceTaskIndex(resolved: ResolvedWindowHostControllerSource) {
    if (!resolved.taskService || resolved.sourceAvailability !== "online") {
      throw new Error("Controller source 当前不可读取");
    }
    const request = {
      workspacePath: resolved.scope.workspacePath,
      ...(resolved.scope.workspaceIdentity
        ? { workspaceIdentity: resolved.scope.workspaceIdentity }
        : {}),
    };
    const [active, pinned, archived] = await Promise.all([
      resolved.taskService.listTasks(request),
      resolved.taskService.listPinnedTasks(request),
      resolved.taskService.listArchivedTasks(request),
    ]);
    const membershipByTaskKey = new Map<
      string,
      {
        meta: ZCodeTaskMeta;
        membership: { pinned: boolean; archived: boolean; active: boolean };
      }
    >();
    for (const task of active) {
      const normalized = normalizeTaskMeta(task, resolved.scope);
      membershipByTaskKey.set(taskKey(normalized), {
        meta: normalized,
        membership: { pinned: false, archived: false, active: true },
      });
    }
    for (const task of pinned) {
      const normalized = normalizeTaskMeta(task, resolved.scope);
      membershipByTaskKey.set(taskKey(normalized), {
        meta: normalized,
        membership: { pinned: true, archived: false, active: true },
      });
    }
    for (const task of archived) {
      const normalized = normalizeTaskMeta(task, resolved.scope);
      membershipByTaskKey.set(taskKey(normalized), {
        meta: normalized,
        membership: { pinned: false, archived: true, active: false },
      });
    }
    return Array.from(membershipByTaskKey.values());
  }

  async function replayPermanentRemovals(
    resolved: ResolvedWindowHostControllerSource,
    emit: (signal: WindowHostTasksRemovedSignal) => void,
  ): Promise<void> {
    const list = resolved.taskService?.listPermanentlyDeletedTaskIds;
    if (!list || resolved.sourceAvailability !== "online") return;
    try {
      const taskIds = await list({
        workspacePath: resolved.scope.workspacePath,
        workspaceIdentity: resolved.scope.workspaceIdentity,
      });
      const current = resolveCurrentSource(resolved.scope);
      if (
        !current ||
        current.taskService !== resolved.taskService ||
        current.sourceAvailability !== "online"
      )
        return;
      if (taskIds.length)
        emit({
          workspacePath: resolved.scope.workspacePath,
          workspaceIdentity: resolved.scope.workspaceIdentity,
          ...(resolved.scope.kind === "remote"
            ? { remoteSessionId: resolved.scope.remoteSessionId }
            : {}),
          taskIds,
          permanentlyDeleted: true,
        });
    } catch (error) {
      options.onSourceError?.(resolved.scope, "refresh", error);
    }
  }

  async function refreshSource(
    resolved: ResolvedWindowHostControllerSource,
    force = false,
    beforeCommit?: () => void,
  ): Promise<void> {
    registerResolvedSource(resolved);
    if (!resolved.taskService || resolved.sourceAvailability !== "online") {
      return;
    }
    const key = sourceKey(resolved.scope);
    await ensureSourceSessionObserver(resolved)?.start();
    if (!force && sourceSnapshotTaskServices.get(key) === resolved.taskService) return;
    const existing = sourceRefreshFlights.get(key);
    if (existing?.taskService === resolved.taskService) return existing.promise;
    const generation = (sourceRefreshGenerations.get(key) ?? 0) + 1;
    sourceRefreshGenerations.set(key, generation);
    const promise = (async () => {
      const taskIndex = await readSourceTaskIndex(resolved);
      // 手机/其他窗口可能错过实时删除事件；快照恢复前按原 source 补清最小删除凭据。
      await replayPermanentRemovals(resolved, (signal) => tasksRemovedSignals.fire(signal));
      if (sourceRefreshGenerations.get(key) !== generation) {
        throw new Error("Controller source refresh generation 已失效");
      }
      beforeCommit?.();
      const previousScope = pendingReplacementByNextSourceKey.get(key);
      projection.replaceSourceSnapshot({
        scope: resolved.scope,
        ...(previousScope ? { replacesScope: previousScope } : {}),
        taskIndex,
        // live facts 仅驻 Host 内存；observer 使用 existing-only，列表读取不会启动 Agent。
        sessionsIndex: sourceLiveOverlays.get(key) ?? [],
      });
      if (previousScope) {
        forgetRegisteredSource(previousScope);
        pendingReplacementByNextSourceKey.delete(key);
      }
      sourceAvailability.set(key, "online");
      sourceSnapshotTaskServices.set(key, resolved.taskService!);
    })();
    sourceRefreshFlights.set(key, { taskService: resolved.taskService, promise });
    try {
      await promise;
    } finally {
      if (sourceRefreshFlights.get(key)?.promise === promise) {
        sourceRefreshFlights.delete(key);
      }
    }
  }

  async function replaceDisconnectedSource(
    previousScope: WindowHostControllerSourceScope,
    resolved: ResolvedWindowHostControllerSource,
    transaction?: {
      canCommit?: () => boolean;
      rollbackOnFailure?: boolean;
    },
  ): Promise<void> {
    if (!resolved.taskService || resolved.sourceAvailability !== "online") {
      throw new Error("重连 source 尚未 online，不能替换离线投影");
    }
    registerResolvedSource(resolved);
    const previousKey = sourceKey(previousScope);
    const retainedPreviousScope =
      pendingReplacementByNextSourceKey.get(previousKey) ?? previousScope;
    if (sourceKey(retainedPreviousScope) !== previousKey) {
      // 连续重连都在首个 snapshot 前失败时，可信 rows 仍属于更早的一代 source。
      // 摘掉中间空 source，把 replacement 链压缩到最后可信 scope，避免成功后遗留孤儿投影。
      pendingReplacementByNextSourceKey.delete(previousKey);
      forgetRegisteredSource(previousScope);
      projection.removeSource(previousScope);
    }
    pendingReplacementByNextSourceKey.set(sourceKey(resolved.scope), retainedPreviousScope);
    try {
      await refreshSource(resolved, true, () => {
        if (transaction?.canCommit?.() === false) {
          throw new Error("Controller source replacement generation 已失效");
        }
      });
    } catch (error) {
      if (transaction?.rollbackOnFailure) {
        const key = sourceKey(resolved.scope);
        if (pendingReplacementByNextSourceKey.has(key)) {
          // Bug 原因：Registry 已回滚 provisional logical session 时，Controller 曾继续保留
          // 新 generation 的 pending source/订阅，下一轮又从旧 session 重试，最终泄漏孤儿 owner。
          pendingReplacementByNextSourceKey.delete(key);
          forgetRegisteredSource(resolved.scope);
          projection.discardSource(resolved.scope);
        }
      }
      throw error;
    }
  }

  function resolveQuerySources(
    scopes: ZCodeTaskListWorkspaceScope[],
  ): ResolvedWindowHostControllerSource[] {
    const resolved = new Map<string, ResolvedWindowHostControllerSource>();
    for (const scope of scopes) {
      const source = options.resolveSource(scope);
      if (!source) {
        continue;
      }
      resolved.set(sourceKey(source.scope), source);
    }
    return Array.from(resolved.values());
  }

  async function listTaskList(
    query: ZCodeTaskListQuery,
  ): Promise<WindowHostControllerTaskListResult> {
    if (query.workspaceScopes === "host") {
      // 已注册 source 也只覆盖打开过的工作区；全局历史必须直接交给持久化 owner。
      // 不 refreshSource，因此搜索不会为未打开目录创建 CLI/runtime 或远程连接。
      const result = await options.readHostTaskList(query);
      const localRows = new Map(
        projection
          .getTasks()
          .filter((row) => !row.address.sourceServerId && !row.address.remoteSessionId)
          .map((row) => [taskKey(row.meta), row]),
      );
      return {
        ...result,
        items: result.items.map((item) => {
          const projected = localRows.get(taskKey(item));
          return {
            ...item,
            sourceAvailability: "online" as const,
            liveStatus: projected?.liveStatus ?? liveStatusFromMeta(item),
            ...(projected?.activity ? { activity: projected.activity } : {}),
          };
        }),
      };
    }
    const resolvedSources = resolveQuerySources(query.workspaceScopes);
    await Promise.all(
      resolvedSources.map(async (source) => {
        try {
          await refreshSource(source);
        } catch (error) {
          // 一个 remote source 的瞬时读取失败不能清空 local 或其他 remote 的可信投影。
          options.onSourceError?.(source.scope, "refresh", error);
        }
      }),
    );

    const search = query.search?.trim();
    let items: WindowHostControllerTaskListItem[];
    if (search) {
      const results = await Promise.all(
        resolvedSources
          .filter((source) => source.sourceAvailability === "online" && source.taskService != null)
          .map(async (source) => {
            try {
              const result = await source.taskService!.listTaskList({
                ...query,
                workspaceScopes: [
                  {
                    workspacePath: source.scope.workspacePath,
                    ...(source.scope.workspaceIdentity
                      ? { workspaceIdentity: source.scope.workspaceIdentity }
                      : {}),
                  },
                ],
                limit: undefined,
              });
              return result.items.map((item) => {
                const normalized = normalizeTaskMeta(item, source.scope);
                const projected = projection
                  .getTasks()
                  .find(
                    (row) =>
                      row.address.taskId === normalized.taskId &&
                      row.address.workspacePath === normalized.workspacePath &&
                      row.address.workspaceIdentity === normalized.workspaceIdentity &&
                      row.address.remoteSessionId ===
                        (source.scope.kind === "remote" ? source.scope.remoteSessionId : undefined),
                  );
                return {
                  ...(projected?.meta ?? normalized),
                  ...(source.scope.kind === "remote"
                    ? {
                        ...(source.scope.sourceServerId
                          ? { sourceServerId: source.scope.sourceServerId }
                          : {}),
                        ...(source.scope.serverDisplayName
                          ? { serverDisplayName: source.scope.serverDisplayName }
                          : {}),
                        remoteSessionId: source.scope.remoteSessionId,
                      }
                    : {}),
                  sourceAvailability: "online" as const,
                  liveStatus: projected?.liveStatus ?? liveStatusFromMeta(normalized),
                  ...(projected?.activity ? { activity: projected.activity } : {}),
                  ...(item.searchSnippets ? { searchSnippets: item.searchSnippets } : {}),
                };
              });
            } catch (error) {
              options.onSourceError?.(source.scope, "search", error);
              return [];
            }
          }),
      );
      items = results.flat();
    } else {
      const selectedSources = new Set<string>();
      for (const source of resolvedSources) {
        const key = sourceKey(source.scope);
        selectedSources.add(key);
        const pendingPreviousScope = pendingReplacementByNextSourceKey.get(key);
        if (pendingPreviousScope) {
          // 新 source 的首个 snapshot 失败时继续展示上一代离线可信投影；只有成功的
          // replaceSourceSnapshot 才会在一个 delta frame 中移除旧 rows 并加入新 rows。
          selectedSources.add(sourceKey(pendingPreviousScope));
        }
      }
      items = projection
        .getTasks()
        .filter((row) => {
          const scope: WindowHostControllerSourceScope =
            row.address.sourceServerId || row.address.remoteSessionId
              ? {
                  kind: "remote",
                  ...(row.address.sourceServerId
                    ? { sourceServerId: row.address.sourceServerId }
                    : {}),
                  remoteSessionId: row.address.remoteSessionId,
                  workspacePath: row.address.workspacePath,
                  workspaceIdentity: row.address.workspaceIdentity!,
                }
              : {
                  kind: "local",
                  workspacePath: row.address.workspacePath,
                  ...(row.address.workspaceIdentity
                    ? { workspaceIdentity: row.address.workspaceIdentity }
                    : {}),
                };
          return (
            selectedSources.has(sourceKey(scope)) &&
            (query.kind === "all" || matchesTaskListMembershipKind(row.membership, query.kind))
          );
        })
        .map((row) => {
          const resolvedSource = resolvedSources.find((source) => {
            const addressKey = row.address.workspaceIdentity?.trim() || row.address.workspacePath;
            const scopeKeyValue =
              source.scope.workspaceIdentity?.trim() || source.scope.workspacePath;
            return (
              addressKey === scopeKeyValue &&
              (source.scope.kind !== "remote" ||
                (row.address.sourceServerId
                  ? source.scope.sourceServerId === row.address.sourceServerId
                  : source.scope.remoteSessionId === row.address.remoteSessionId))
            );
          });
          return {
            ...row.meta,
            ...(row.address.sourceServerId ? { sourceServerId: row.address.sourceServerId } : {}),
            ...(resolvedSource?.scope.kind === "remote" && resolvedSource.scope.serverDisplayName
              ? { serverDisplayName: resolvedSource.scope.serverDisplayName }
              : {}),
            ...(row.address.remoteSessionId
              ? { remoteSessionId: row.address.remoteSessionId }
              : {}),
            sourceAvailability: row.sourceAvailability,
            liveStatus: row.liveStatus,
            ...(row.activity ? { activity: row.activity } : {}),
            ...(row.searchSnippets ? { searchSnippets: row.searchSnippets } : {}),
          };
        });
    }
    items.sort((left, right) => compareItems(left, right, query.sortBy));
    const total = items.length;
    const visible = query.limit == null ? items : items.slice(0, query.limit);
    return { items: visible, total, hasMore: total > visible.length };
  }

  function createAttachmentService(
    ownsUnreadSignals = true,
  ): IWindowControllerService & { dispose(): void } {
    const frameEmitter = new Emitter<WindowHostControllerFrame>();
    const unreadEmitter = new Emitter<WindowHostTaskUnreadSignal>();
    const unreadSubscription = ownsUnreadSignals
      ? unreadSignals.event((signal) => unreadEmitter.fire(signal))
      : undefined;
    const tasksRemovedEmitter = new Emitter<WindowHostTasksRemovedSignal>();
    // Bug 根因：曾与未读信号共用 ownsUnreadSignals，手机 attachment 拿到 Event.None，
    // 归档后手机端终端等任务 tab 留在其 registry。移除信号只驱动各端清理自己的 registry，幂等，每个 attachment 都要收到。
    const tasksRemovedSubscription = tasksRemovedSignals.event((signal) =>
      tasksRemovedEmitter.fire(signal),
    );
    const subscriptions = new Map<string, { dispose(): void }>();
    let attachmentDisposed = false;
    function deletionSource(input: WindowHostTaskAddress) {
      const address = windowHostTaskAddressSchema.parse(input);
      const resolved = options.resolveSource({
        workspacePath: address.workspacePath,
        workspaceIdentity: address.workspaceIdentity,
      });
      if (
        attachmentDisposed ||
        !resolved ||
        resolved.sourceAvailability !== "online" ||
        !resolved.taskService
      )
        throw new Error("session-data.unavailable");
      const scope = resolved.scope;
      if (
        scope.workspacePath !== address.workspacePath ||
        scope.workspaceIdentity !== address.workspaceIdentity ||
        (scope.kind === "remote"
          ? (address.sourceServerId
              ? address.sourceServerId !== scope.sourceServerId
              : address.remoteSessionId !== scope.remoteSessionId) ||
            (address.remoteSessionId != null && address.remoteSessionId !== scope.remoteSessionId)
          : address.remoteSessionId != null || address.sourceServerId != null)
      )
        throw new Error("session-data.identity-mismatch");
      return resolved;
    }
    return {
      listTaskList,
      async previewArchivedTaskDeletion({ address }) {
        const source = deletionSource(address);
        const result = await source.taskService!.previewArchivedTaskDeletion(
          mutationParams(address),
        );
        if (deletionSource(address).taskService !== source.taskService)
          throw new Error("session-data.changed");
        return result;
      },
      async permanentlyDeleteArchivedTask({ address, revision, operationId }) {
        const source = deletionSource(address);
        const result = await source.taskService!.permanentlyDeleteArchivedTask({
          ...mutationParams(address),
          revision,
          operationId,
        });
        if (result.status === "deleted") {
          notifyTasksRemoved(source.scope, result.sessionIds, true);
          await refreshSource(source, true).catch((error) =>
            options.onSourceError?.(source.scope, "refresh", error),
          );
        }
        return result;
      },
      async getTaskMeta(params) {
        const address = windowHostTaskAddressSchema.parse(params.address);
        const resolved = options.resolveSource({
          workspacePath: address.workspacePath,
          ...(address.workspaceIdentity ? { workspaceIdentity: address.workspaceIdentity } : {}),
        });
        const taskService = resolved?.taskService;
        const assertCurrentSource = (current: ResolvedWindowHostControllerSource | null) => {
          if (
            attachmentDisposed ||
            !resolved ||
            !taskService ||
            !current ||
            current.sourceAvailability !== "online" ||
            current.taskService !== taskService ||
            current.scope.workspacePath !== address.workspacePath ||
            current.scope.workspaceIdentity !== address.workspaceIdentity ||
            sourceKey(current.scope) !== sourceKey(resolved.scope) ||
            (current.scope.kind === "remote" &&
              resolved.scope.kind === "remote" &&
              current.scope.remoteSessionId !== resolved.scope.remoteSessionId)
          )
            throw new Error("任务读取期间 source 已失效");
          const mismatched =
            current.scope.kind === "remote"
              ? (address.sourceServerId
                  ? address.sourceServerId !== current.scope.sourceServerId
                  : address.remoteSessionId !== current.scope.remoteSessionId) ||
                (address.remoteSessionId != null &&
                  address.remoteSessionId !== current.scope.remoteSessionId)
              : address.remoteSessionId != null || address.sourceServerId != null;
          if (mismatched) throw new Error("任务地址与 source 不匹配");
        };
        assertCurrentSource(resolved);
        // Bug 根因：列表读取失败可保留旧投影；把它当已读 marker 会漏清或误清。
        // 直接读唯一持久 owner，IO 前后复查同一服务与 attachment，不吞错、不物化整表。
        const result = await taskService!.getTaskMeta(mutationParams(address));
        assertCurrentSource(resolveCurrentSource(resolved!.scope));
        if (result && result.taskId !== address.taskId) throw new Error("任务读取返回地址不匹配");
        return result ? normalizeTaskMeta(result, resolved!.scope) : null;
      },
      async deleteArchivedTasks({ address, taskIds }) {
        if (taskIds.length === 0) {
          return { deletedTaskIds: [], skippedTaskIds: [], failedTaskIds: [] };
        }
        const result = await projection.mutate(address, { kind: "delete-archived-batch", taskIds });
        if (!result || typeof result === "boolean" || !("deletedTaskIds" in result)) {
          throw new Error("归档删除批次未返回逐项目标结果");
        }
        const resolved = options.resolveSource({
          workspacePath: address.workspacePath,
          workspaceIdentity: address.workspaceIdentity,
        });
        if (resolved) {
          // 只在整批结束后收敛投影，与 source 的一次事件共享 single-flight；刷新失败不改写已提交结果。
          await refreshSource(resolved, true).catch((error) =>
            options.onSourceError?.(resolved.scope, "refresh", error),
          );
        }
        return result;
      },
      async deleteArchivedTask({ address }) {
        const deleted = await projection.mutate(address, { kind: "delete-archived" });
        const resolved = options.resolveSource({
          workspacePath: address.workspacePath,
          workspaceIdentity: address.workspaceIdentity,
        });
        if (resolved) {
          // 删除已经持久成功，列表重查失败不能改报删除失败；后续事件仍会刷新投影。
          await refreshSource(resolved, true).catch((error) =>
            options.onSourceError?.(resolved.scope, "refresh", error),
          );
        }
        return deleted === true;
      },
      async mutateTask({ address, mutation }) {
        const resolved = options.resolveSource({
          workspacePath: address.workspacePath,
          ...(address.workspaceIdentity ? { workspaceIdentity: address.workspaceIdentity } : {}),
        });
        // 项目树也包含未打开 tab 的任务；先从唯一 owner 读取行验证，不能依赖 UI 先查另一份列表。
        if (!resolved || resolved.sourceAvailability !== "online")
          throw new Error(
            resolved?.scope.kind === "remote"
              ? "远程 source 当前离线，禁止列表写操作"
              : "任务 source 当前不可用",
          );
        const taskService = resolved.taskService;
        const assertCurrentUnreadSource = () => {
          const current = resolveCurrentSource(resolved.scope);
          if (
            current?.taskService !== taskService ||
            current?.sourceAvailability !== "online" ||
            sourceAvailability.get(sourceKey(resolved.scope)) !== "online"
          ) {
            throw new Error("未读写入期间 source 已失效");
          }
        };
        await refreshSource(resolved);
        // 首次读取也会等待 IO；后置检查只能拒绝回包，挡不住 mutation 重解析后误写新 source。
        if (mutation.kind === "mark-read" || mutation.kind === "mark-unread") {
          // 缓存命中不代表在途读取已结束；先等旧快照收口，缺行时再读，避免新任务被旧快照拒绝。
          // 旧读取失败不否定已知任务的完成事实，真正缺行的刷新仍须成功后才能写入。
          await sourceRefreshFlights.get(sourceKey(resolved.scope))?.promise.catch(() => {});
          assertCurrentUnreadSource();
          const known = projection
            .getTasks()
            .some(
              (row) =>
                row.address.taskId === address.taskId &&
                row.address.workspacePath === address.workspacePath &&
                row.address.workspaceIdentity === address.workspaceIdentity &&
                (address.sourceServerId
                  ? row.address.sourceServerId === address.sourceServerId
                  : row.address.remoteSessionId === address.remoteSessionId),
            );
          if (!known) {
            await refreshSource(resolved, true);
            assertCurrentUnreadSource();
          }
        }
        const mutationResult = await projection.mutate(
          address,
          mutation as WindowHostControllerMutation,
        );
        // 未读 CAS 必须使用本次写入分配的 marker；重查投影可能已包含后一次完成，不能替换回包。
        if (mutationResult && typeof mutationResult !== "boolean" && "taskId" in mutationResult) {
          assertCurrentUnreadSource();
          // 写入已提交；读取失败只影响投影刷新，不把成功的写操作伪装成可重试失败。
          await refreshSource(resolved, true).catch((error) =>
            options.onSourceError?.(resolved.scope, "refresh", error),
          );
          assertCurrentUnreadSource();
          return mutationResult;
        }
        await refreshSource(resolved, true);
        return (
          projection
            .getTasks()
            .find(
              (row) =>
                row.address.taskId === address.taskId &&
                row.address.workspacePath === address.workspacePath &&
                row.address.workspaceIdentity === address.workspaceIdentity &&
                (address.sourceServerId
                  ? row.address.sourceServerId === address.sourceServerId
                  : row.address.remoteSessionId === address.remoteSessionId),
            )?.meta ?? null
        );
      },
      async subscribeControllerV4(params: ControllerSubscribeParams) {
        const subscription = projection.subscribe({
          topic: params.topic,
          onFrame: (frame) => frameEmitter.fire(frame),
        });
        subscriptions.set(subscription.subscriptionId, subscription);
        return { ack: subscription.ack };
      },
      async resyncControllerV4(params) {
        for (const scope of registeredScopes.values()) {
          const source = resolveCurrentSource(scope);
          if (source)
            await replayPermanentRemovals(source, (signal) => tasksRemovedEmitter.fire(signal));
        }
        if (attachmentDisposed) throw new Error("Controller attachment 已释放");
        return { ack: projection.resync(params.subscriptionId) };
      },
      async unsubscribeControllerV4(params) {
        subscriptions.get(params.subscriptionId)?.dispose();
        subscriptions.delete(params.subscriptionId);
      },
      onDynamicControllerFrame() {
        return frameEmitter.event;
      },
      onDynamicTaskUnreadSignal() {
        return ownsUnreadSignals ? unreadEmitter.event : Event.None;
      },
      onDynamicTasksRemovedSignal() {
        return (listener) => {
          const subscription = tasksRemovedEmitter.event(listener);
          let disposed = false;
          // 手机的清理监听晚于列表订阅。只在列表快照前发凭据会丢事件，必须在本监听接好后补发。
          for (const scope of registeredScopes.values()) {
            const source = resolveCurrentSource(scope);
            if (source)
              void replayPermanentRemovals(source, (signal) => {
                if (!disposed && !attachmentDisposed) listener(signal);
              });
          }
          return {
            dispose() {
              disposed = true;
              subscription.dispose();
            },
          };
        };
      },
      dispose() {
        attachmentDisposed = true;
        unreadSubscription?.dispose();
        unreadEmitter.dispose();
        tasksRemovedSubscription.dispose();
        tasksRemovedEmitter.dispose();
        for (const subscription of subscriptions.values()) {
          subscription.dispose();
        }
        subscriptions.clear();
        frameEmitter.dispose();
      },
    };
  }

  const service = createAttachmentService();
  return {
    service,
    createAttachmentService,
    /** 手机项目树叠加实时交互：只读当前投影行，不触发 source 刷新。 */
    readTaskRows: (): WindowHostControllerTaskRow[] => projection.getTasks(),
    /** 投影行任一变化即回调；订阅时会立即收到一次快照回调。 */
    subscribeTaskRows: (onChange: () => void): { dispose(): void } =>
      projection.subscribe({ topic: CONTROLLER_TASKS_INDEX_TOPIC, onFrame: () => onChange() }),
    replaceDisconnectedSource,
    async resolveTaskAddress(params: {
      taskId: string;
      workspacePath: string;
      workspaceIdentity?: string;
      attachmentScope?: import("@zcode/shared").WindowHostAttachmentScope;
      allowMissingTask?: boolean;
    }): Promise<WindowHostTaskAddress> {
      const remoteAttachmentScope =
        params.attachmentScope?.kind === "remote" ? params.attachmentScope : undefined;
      if (remoteAttachmentScope) {
        if (
          remoteAttachmentScope.workspacePath !== params.workspacePath ||
          remoteAttachmentScope.workspaceIdentity !== params.workspaceIdentity
        ) {
          throw new Error("列表 mutation 与 remote attachment scope 不匹配");
        }
      }
      const resolved = options.resolveSource({
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
      });
      const assertAttachmentSource = (source: ResolvedWindowHostControllerSource | null) => {
        if (
          remoteAttachmentScope &&
          (!source ||
            source.scope.kind !== "remote" ||
            source.scope.remoteSessionId !== remoteAttachmentScope.remoteSessionId ||
            source.scope.workspacePath !== remoteAttachmentScope.workspacePath ||
            source.scope.workspaceIdentity !== remoteAttachmentScope.workspaceIdentity)
        ) {
          throw new Error("列表 mutation 与 remote attachment source 不匹配");
        }
      };
      assertAttachmentSource(resolved);
      if (resolved) {
        // remote attachment 曾直接返回 address，跳过 source refresh；新绑定的
        // workspace 尚未读取 Controller 列表时没有投影行，导致 unread/archive 等首次写入失败。
        // 这里只物化已按完整 remoteSessionId + identity 验证的 source，继续保持 fail-closed。
        await refreshSource(resolved);
        assertAttachmentSource(resolveCurrentSource(resolved.scope));
      }
      // 侧栏可先按稳定 Source 查询，之后才创建 attachment；投影行没有新 sessionId
      // 不代表任务缺失。先验证当前 attachment，再按同一 Source 匹配，旧地址路径仍精确匹配。
      const sourceServerId =
        resolved?.scope.kind === "remote" ? resolved.scope.sourceServerId : undefined;
      const matches = projection
        .getTasks()
        .filter(
          (row) =>
            row.address.taskId === params.taskId &&
            row.address.workspacePath === params.workspacePath &&
            row.address.workspaceIdentity === params.workspaceIdentity &&
            (!remoteAttachmentScope ||
              (sourceServerId
                ? row.address.sourceServerId === sourceServerId
                : row.address.remoteSessionId === remoteAttachmentScope.remoteSessionId)),
        );
      if (matches.length !== 1) {
        if (matches.length === 0 && params.allowMissingTask && resolved) {
          // 条件删除允许已被其它客户端删除的目标到 Repo 幂等跳过；source 身份仍须完整验证。
          return {
            taskId: params.taskId,
            workspacePath: resolved.scope.workspacePath,
            ...(resolved.scope.workspaceIdentity
              ? { workspaceIdentity: resolved.scope.workspaceIdentity }
              : {}),
            ...(resolved.scope.kind === "remote"
              ? { remoteSessionId: resolved.scope.remoteSessionId }
              : {}),
          };
        }
        throw new Error(
          `列表 mutation 无法解析唯一 source，taskId=${params.taskId}, matches=${matches.length}`,
        );
      }
      return matches[0]!.address;
    },
    disconnectSource(scope: WindowHostControllerSourceScope): void {
      const key = sourceKey(scope);
      if (!registeredScopes.has(key) || sourceAvailability.get(key) === "offline") {
        return;
      }
      sourceAvailability.set(key, "offline");
      sourceRefreshGenerations.set(key, (sourceRefreshGenerations.get(key) ?? 0) + 1);
      sourceRefreshFlights.delete(key);
      sourceSessionObservers.get(key)?.observer.dispose();
      sourceSessionObservers.delete(key);
      sourceSnapshotTaskServices.delete(key);
      projection.disconnectSource(scope);
    },
    removeSource(scope: WindowHostControllerSourceScope): void {
      const key = sourceKey(scope);
      if (!registeredScopes.has(key)) {
        return;
      }
      const retainedPreviousScope = pendingReplacementByNextSourceKey.get(key);
      forgetRegisteredSource(scope);
      pendingReplacementByNextSourceKey.delete(key);
      for (const [nextKey, previousScope] of pendingReplacementByNextSourceKey) {
        if (sourceKey(previousScope) === key) {
          pendingReplacementByNextSourceKey.delete(nextKey);
        }
      }
      projection.removeSource(scope);
      if (retainedPreviousScope && sourceKey(retainedPreviousScope) !== key) {
        // 当前 logical session 在成功 resync 前仍借用上一代离线 rows；关闭当前 scope
        // 等同关闭这份 history scope，必须连同保留投影一起清理。
        forgetRegisteredSource(retainedPreviousScope);
        projection.removeSource(retainedPreviousScope);
      }
    },
    dispose(): void {
      service.dispose();
      unreadSignals.dispose();
      tasksRemovedSignals.dispose();
      for (const scope of registeredScopes.values()) {
        projection.removeSource(scope);
      }
      for (const subscription of sourceEventSubscriptions.values()) {
        subscription.dispose();
      }
      registeredScopes.clear();
      sourceAvailability.clear();
      sourceTaskServices.clear();
      sourceSnapshotTaskServices.clear();
      sourceEventSubscriptions.clear();
      sourceRefreshFlights.clear();
      sourceRefreshGenerations.clear();
      for (const entry of sourceSessionObservers.values()) entry.observer.dispose();
      sourceSessionObservers.clear();
      sourceLiveOverlays.clear();
      pendingReplacementByNextSourceKey.clear();
    },
  };
}
