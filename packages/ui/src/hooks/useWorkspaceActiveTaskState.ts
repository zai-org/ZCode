import { useEffect, useRef, useState } from "react";
import type { ZCodeProvider, ZCodeTaskMeta } from "@zcode/shared";
import { useZCodeTaskService } from "@/hooks/useZCodeTaskService.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useTaskNativeSessionLogFile } from "@/hooks/useTaskNativeSessionLogFile.js";
import { useTaskSessionFilePath } from "@/hooks/useTaskSessionFilePath.js";
import { logger } from "@/logger.js";
import { resolveWorkspaceHeaderProvider } from "@/lib/workspaceHeaderProvider.js";
import { selectWorkspaceZCodeState, useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

interface UseWorkspaceActiveTaskStateParams {
  workspaceAbsPath: string;
  activeTaskId: string | null;
  workspaceRemoteSessionId?: string | null;
  workspaceIdentity?: string;
  selectedProvider: ZCodeProvider;
  intl: {
    formatMessage(descriptor: { id: string }): string;
  };
}

function areTaskMetaJsonFieldsEqual(left: unknown, right: unknown) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function areResolvedTaskMetasEqual(left: ZCodeTaskMeta | null, right: ZCodeTaskMeta | null) {
  if (left === right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  return (
    left.taskId === right.taskId &&
    left.traceId === right.traceId &&
    left.title === right.title &&
    left.titleOverridden === right.titleOverridden &&
    left.workspacePath === right.workspacePath &&
    left.workspaceIdentity === right.workspaceIdentity &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    left.mode === right.mode &&
    left.model === right.model &&
    left.thoughtLevel === right.thoughtLevel &&
    left.runtimeEpoch === right.runtimeEpoch &&
    left.provider === right.provider &&
    left.migrationSource === right.migrationSource &&
    left.forkedFromTaskId === right.forkedFromTaskId &&
    left.unreadAt === right.unreadAt &&
    left.status === right.status &&
    areTaskMetaJsonFieldsEqual(left.lastError, right.lastError) &&
    areTaskMetaJsonFieldsEqual(left.repairState, right.repairState) &&
    areTaskMetaJsonFieldsEqual(left.changeSummary, right.changeSummary) &&
    areTaskMetaJsonFieldsEqual(left.target, right.target)
  );
}

/**
 * 任务元数据只读 Host 的 tasks-index（唯一数据源）：先订阅再读取，任务列表或项目变化时重读。
 * 会话头部与按 cwd 工作的界面（docs/git/worktree.md §3.7）共用这一份读取逻辑。
 */
export function useIndexedTaskMeta({
  workspacePath: workspaceAbsPath,
  workspaceIdentity,
  remoteSessionId: workspaceRemoteSessionId,
  taskId: activeTaskId,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string | null;
  taskId: string | null;
}): ZCodeTaskMeta | null {
  const service = useZCodeTaskService(
    workspaceAbsPath,
    workspaceRemoteSessionId,
    workspaceIdentity,
  );
  const { broadcastService } = useBaseWorkspaceServices();
  const version = useZCodeSessionStore(
    (state) =>
      selectWorkspaceZCodeState(state, workspaceAbsPath, workspaceIdentity).taskListVersion,
  );
  const targetKey = JSON.stringify([
    workspaceIdentity?.trim() || workspaceAbsPath,
    activeTaskId,
    workspaceRemoteSessionId ?? null,
  ]);
  const [indexed, setIndexed] = useState<{
    service: typeof service;
    targetKey: string;
    meta: ZCodeTaskMeta | null;
  } | null>(null);
  useEffect(() => {
    if (!activeTaskId) return;
    let disposed = false;
    let serial = 0;
    const target = { workspacePath: workspaceAbsPath, workspaceIdentity, taskId: activeTaskId };
    const refresh = async () => {
      const request = ++serial;
      try {
        // Bugfix: 旧列表退场后，标题 fallback 的 readSession 早于 V4 冷恢复而报
        // Session is not active。标题只读 Host 索引；正文恢复不再决定标题是否可用。
        const meta = await service.getTaskMeta(target);
        if (!disposed && request === serial) setIndexed({ service, targetKey, meta });
      } catch (error) {
        if (!disposed && request === serial)
          logger.warn("[active-task-meta] 读取 Host 任务元数据失败", { ...target, error });
      }
    };
    // 先订阅再查询，避免读取与订阅之间漏掉重命名/归档；同目标的迟到结果也不能覆盖新结果。
    const events = service.onDynamicWorkspaceEvent(target)((event) => {
      if (event.type === "workspace_task_list_changed") void refresh();
    });
    const projects = broadcastService.onMessage((event) => {
      if (event.channel === "state:projects") void refresh();
    });
    void refresh();
    return () => {
      disposed = true;
      events.dispose();
      projects.dispose();
    };
  }, [
    service,
    broadcastService,
    workspaceAbsPath,
    workspaceIdentity,
    activeTaskId,
    targetKey,
    version,
  ]);
  // 同 ID 可存在于不同远端；渲染时即拒绝旧目标，不能等 effect 才清标题。
  const indexedMeta =
    indexed?.service === service && indexed.targetKey === targetKey ? indexed.meta : null;
  return indexedMeta;
}

export function useStableResolvedActiveTaskMeta(taskMeta: ZCodeTaskMeta | null) {
  const stableTaskMetaRef = useRef<ZCodeTaskMeta | null>(null);
  const stableTaskMeta = stableTaskMetaRef.current;
  // stream chunk 只更新消息流时，active task meta 经列表/乐观层重新合成后可能字段相同但引用变了。
  // Header/Shell 依赖 memo props；这里复用等价 meta 的旧引用，避免连续流式更新拖动标题栏重渲。
  if (!areResolvedTaskMetasEqual(stableTaskMeta, taskMeta)) {
    stableTaskMetaRef.current = taskMeta;
  }
  return stableTaskMetaRef.current;
}

export function useWorkspaceActiveTaskState({
  workspaceAbsPath,
  activeTaskId,
  workspaceRemoteSessionId,
  workspaceIdentity,
  selectedProvider,
  intl,
}: UseWorkspaceActiveTaskStateParams) {
  const optimisticMeta = useZCodeSessionStore((state) => {
    const workspace = selectWorkspaceZCodeState(state, workspaceAbsPath, workspaceIdentity);
    return activeTaskId ? (workspace.optimisticTaskListByTaskId[activeTaskId] ?? null) : null;
  });
  const indexedMeta = useIndexedTaskMeta({
    workspacePath: workspaceAbsPath,
    workspaceIdentity,
    remoteSessionId: workspaceRemoteSessionId,
    taskId: activeTaskId,
  });
  const activeTaskMeta = indexedMeta ?? optimisticMeta;
  const resolvedActiveTaskMeta = useStableResolvedActiveTaskMeta(activeTaskMeta);
  // M5② store 收尾：taskMessagesByTaskId 已无写入方（旧 ChatView/bot 消息回放均退役），
  // 由消息流派生的实时改动摘要恒为空；摘要展示回落到 task meta.changeSummary（持久化侧）。
  const activeTaskChangeSummary = null;
  const activeTraceId = resolvedActiveTaskMeta?.traceId ?? null;
  const activeSessionId = resolvedActiveTaskMeta?.taskId ?? null;
  const activeTaskProvider = resolvedActiveTaskMeta?.provider ?? null;
  const workspaceHeaderProvider = resolveWorkspaceHeaderProvider(
    activeTaskProvider,
    selectedProvider,
  );
  // 切换任务后 Host 元数据异步返回；用“新建任务”填补空标题会先闪占位再跳成真标题。
  // 等待时保持标题为空，不保留上个任务的标题，也不增加另一份标题缓存。
  const activeTaskTitle = resolvedActiveTaskMeta?.title?.trim()
    ? resolvedActiveTaskMeta.title
    : resolvedActiveTaskMeta?.forkedFromTaskId
      ? intl.formatMessage({ id: "taskList.forkedUntitled" })
      : "";
  const taskNativeSessionLogFile = useTaskNativeSessionLogFile(
    workspaceAbsPath,
    activeTaskId,
    activeTaskProvider,
    workspaceIdentity,
  );
  const taskSessionFile = useTaskSessionFilePath(workspaceAbsPath, activeTaskId, workspaceIdentity);

  return {
    activeTaskMeta,
    resolvedActiveTaskMeta,
    activeTraceId,
    activeSessionId,
    activeTaskProvider,
    workspaceHeaderProvider,
    activeTaskChangeSummary,
    activeTaskTitle,
    taskNativeSessionLogFile,
    taskSessionFile,
  };
}
