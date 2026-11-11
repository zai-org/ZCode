import {
  generateTraceId,
  resolveWorkspaceKey,
  ZCODE_AGENT_PROVIDER,
  type ZCodeTaskMeta,
} from "@zcode/shared";
import type { SessionsIndexReconcileResult } from "@zcode/shared/zcode-protocol-v4";
import type {
  TaskFactChange,
  TaskFactSource,
  TaskFactStore,
  TaskFactsContract,
  TaskWorkspace,
  TaskFactTarget,
} from "#src/task-facts/contract.js";
export type {
  TaskFactsContract,
  TaskFactStore,
  TaskFactSource,
  TaskFactTarget,
  TaskFactMutation,
} from "#src/task-facts/contract.js";

export function createTaskFacts(options: {
  store: TaskFactStore;
  source: TaskFactSource;
  changed(change: TaskFactChange): void;
}): TaskFactsContract {
  const { store, source, changed } = options;
  // 仅保留在途请求的代际，不缓存会话状态。新帧到达即撤销旧请求的落库资格。
  const refreshes = new Map<string, symbol>();
  const key = (target: TaskFactTarget) =>
    JSON.stringify([resolveWorkspaceKey(target), target.taskId]);
  const mirror = async (
    target: TaskWorkspace,
    result: SessionsIndexReconcileResult,
    current: () => boolean,
    publish = true,
  ) => {
    for (const fact of result.sessions) {
      if (!current()) return;
      const task = {
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        taskId: fact.sessionId,
      };
      if (!fact.exists) {
        await store.markCliOrphan(task);
        continue;
      }
      const before = publish ? await store.getTaskMeta(task) : null;
      if (!current()) return;
      const meta = await store.applyCliFacts({
        meta: {
          ...task,
          traceId: generateTraceId(fact.sessionId),
          title: fact.title,
          createdAt: fact.createdAt,
          updatedAt: fact.updatedAt,
          mode: "default",
          provider: ZCODE_AGENT_PROVIDER,
          // 对账可能先于摘要完成首次入库；两条路径必须保留相同的父子关系。
          ...(fact.parentSessionId ? { forkedFromTaskId: fact.parentSessionId } : {}),
        },
        titleSource: fact.titleSource,
        lastOutcome: fact.lastOutcome,
        deleted: fact.deleted,
      });
      if (
        publish &&
        current() &&
        (fact.deleted ||
          !before ||
          before.title !== meta.title ||
          before.updatedAt !== meta.updatedAt ||
          before.status !== meta.status)
      )
        changed({
          target: task,
          meta,
          reason: fact.deleted ? "task_deleted" : "task_title_changed",
        });
    }
  };
  const port: TaskFactsContract = {
    async ingest(target, summary) {
      refreshes.delete(key({ ...target, taskId: summary.sessionId }));
      const lastOutcome = summary.lastOutcome;
      const meta: ZCodeTaskMeta = {
        taskId: summary.sessionId,
        traceId: generateTraceId(summary.sessionId),
        title: summary.title,
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        createdAt: summary.createdAt,
        updatedAt: summary.lastActivityAt,
        mode: "default",
        provider: ZCODE_AGENT_PROVIDER,
        ...(summary.parentSessionId ? { forkedFromTaskId: summary.parentSessionId } : {}),
        ...(lastOutcome ? { status: lastOutcome === "error" ? "error" : "completed" } : {}),
      };
      return store.applyCliFacts({ meta, titleSource: summary.titleSource, lastOutcome });
    },
    async removed(target) {
      refreshes.delete(key(target));
      await store.applyCliDeletion(target);
      changed({ target, reason: "task_deleted" });
    },
    async refresh(target) {
      const id = key(target);
      const generation = Symbol();
      refreshes.set(id, generation);
      try {
        const result = await source.reconcile(target, [target.taskId]);
        await mirror(target, result, () => refreshes.get(id) === generation, false);
        return await store.getTaskMeta(target);
      } finally {
        if (refreshes.get(id) === generation) refreshes.delete(id);
      }
    },
    async mutate(target, intent) {
      await source.execute(target, intent);
      const meta = await port.refresh(target);
      changed({
        target,
        ...(meta ? { meta } : {}),
        reason: intent.type === "delete" ? "task_deleted" : "task_title_changed",
      });
      return meta;
    },
    async reconcile(target, presentSessionIds, stillCurrent) {
      const rows = (await store.listReconciliationRows(target)).filter(
        (row) => !presentSessionIds.has(row.meta.taskId) || (row.handoffPending & 3) !== 0,
      );
      for (let offset = 0; offset < rows.length && stillCurrent(); offset += 256) {
        const batch = rows.slice(offset, offset + 256);
        let result = await source.reconcile(
          target,
          batch.map((row) => row.meta.taskId),
        );
        if (!stillCurrent()) return;
        const changedIds: string[] = [];
        for (const fact of result.sessions) {
          if (!stillCurrent()) return;
          if (!fact.exists || fact.deleted) continue;
          const pending = batch.find((row) => row.meta.taskId === fact.sessionId)!;
          if ((pending.handoffPending & 3) === 0) continue;
          await source.execute(
            { ...target, taskId: fact.sessionId },
            (pending.handoffPending & 1) !== 0
              ? { type: "delete" }
              : { type: "rename", title: pending.meta.title },
          );
          changedIds.push(fact.sessionId);
        }
        if (changedIds.length && stillCurrent()) {
          const confirmed = await source.reconcile(target, changedIds);
          result = {
            sessions: [
              ...result.sessions.filter((fact) => !changedIds.includes(fact.sessionId)),
              ...confirmed.sessions,
            ],
          };
        }
        await mirror(target, result, stillCurrent);
      }
    },
  };
  return port;
}
