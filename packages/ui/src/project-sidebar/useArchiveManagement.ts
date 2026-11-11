import { remoteHostLabel } from "@/project-sidebar/RemoteHostSection.js";
import type { V4SessionDeletionPreview } from "@zcode/shared/zcode-protocol-v4";
import { useEffect, useRef, useState } from "react";
import type { ProjectTask } from "@/project-sidebar/contract.js";
import { useProjectDirectory } from "@/project-sidebar/ProjectDirectoryProvider.js";
import {
  mutateProjectTask,
  previewProjectTaskDeletion,
  permanentlyDeleteProjectTask,
} from "@/project-sidebar/task-mutation.js";
import { archiveTaskKey } from "@/project-sidebar/archive-view.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { resolveRemoteWorkspaceSessionIdForTarget } from "@/hooks/useResolvedRemoteWorkspaceSessionId.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { clearBrowserRecentVisitsForTask } from "@/store/browserRecentVisitsStore.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";

export type ArchiveOperation = "unarchive" | "delete";
export function useArchiveManagement() {
  const directory = useProjectDirectory();
  const { zcodeTaskService: service, windowControllerService: controller } =
    useBaseWorkspaceServices();
  const removeTaskState = useZCodeSessionStore((s) => s.removeTaskState);
  const confirm = useConfirmDialog();
  const { intl } = useZCodeIntl();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    succeeded: number;
    failed: number;
    skipped: number;
    details: string[];
  } | null>(null);
  const activeOperation = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      activeOperation.current?.abort();
      activeOperation.current = null;
    },
    [],
  );
  const latest = useRef(directory);
  latest.current = directory;
  const run = async (tasks: ProjectTask[], operation: ArchiveOperation) => {
    if (activeOperation.current || !tasks.length) return;
    // 固定确认时的身份集合；搜索变化、新归档和重复点击不能扩充已经确认的批次。
    const candidates = [
      ...new Map(tasks.filter((t) => t.archived).map((t) => [archiveTaskKey(t), t])).values(),
    ];
    if (!candidates.length) return;
    const operationLifetime = new AbortController();
    activeOperation.current = operationLifetime;
    setBusy(true);
    setResult(null);
    const counts = { succeeded: 0, failed: 0, skipped: 0, details: [] as string[] };
    const msg = (id: string, values?: Record<string, string | number>) =>
      intl.formatMessage({ id: `archives.${id}` }, values);
    const reason = (value?: string) =>
      msg(
        `reason.${value && ["running", "in-use", "not-found", "not-archived", "changed"].includes(value) ? value : "unavailable"}`,
      );
    const label = (task: ProjectTask) => {
      const project =
        latest.current.tree.projects.find((project) => project.id === task.projectId)?.name ??
        msg("unclassified");
      const host = latest.current.directory.hosts.find((host) => host.id === task.hostId);
      return `${task.title} · ${project} · ${host ? remoteHostLabel(host) : msg("localDevice")} · ${task.workspacePath}`;
    };
    const previews = new Map<
      string,
      { preview: V4SessionDeletionPreview; remoteSessionId?: string | null }
    >();
    try {
      if (operation === "delete") {
        const willDelete: string[] = [];
        const retained: string[] = [];
        const blocked: string[] = [];
        const section = (heading: string, items: string[]) =>
          `${msg(heading)}\n${items.length ? items.map((item) => `• ${item}`).join("\n") : msg("none")}`;
        const progress = (completed: number) =>
          `${msg("checkingProgress", { completed, total: candidates.length })}\n\n${msg("checkingDescription")}`;
        if (
          !(await confirm(
            {
              intent: "archive-management-delete",
              title: msg("deleteTitle", { count: candidates.length }),
              description: progress(0),
              confirmLabel: msg("checking"),
              confirmDisabled: true,
              confirmVariant: "destructive",
              scrollableDescription: true,
              prepare: async ({ signal, update }) => {
                let completed = 0;
                for (const task of candidates) {
                  if (signal.aborted) return;
                  try {
                    const remoteSessionId = resolveRemoteWorkspaceSessionIdForTarget({
                      ...task,
                      state: useRemoteWorkspaceSessionStore.getState(),
                    });
                    const preview = await previewProjectTaskDeletion(
                      { service, controller },
                      task,
                      remoteSessionId,
                    );
                    if (signal.aborted) return;
                    if (preview.blockedReason) {
                      blocked.push(`${label(task)} — ${reason(preview.blockedReason)}`);
                      continue;
                    }
                    previews.set(archiveTaskKey(task), { preview, remoteSessionId });
                    willDelete.push(
                      msg("deleteItem", {
                        title: label(task),
                        children: Math.max(0, preview.sessionIds.length - 1),
                        files: preview.deletedFiles,
                      }),
                    );
                    for (const fork of preview.forks)
                      retained.push(msg("keepFork", { title: fork.title || fork.sessionId }));
                    for (const file of preview.retainedArtifacts)
                      retained.push(
                        msg("keepAttachment", {
                          name: file.fileName,
                          referrers:
                            file.referrers.map((ref) => ref.title || ref.sessionId).join(", ") ||
                            msg("previousReference"),
                        }),
                      );
                    if (preview.incomplete)
                      willDelete.push(msg("resumeDeletion", { title: task.title }));
                  } catch (error) {
                    if (signal.aborted) return;
                    blocked.push(`${label(task)} — ${reason()}`);
                    logger.warn("[archive-management] 永久删除预检失败", {
                      taskId: task.taskId,
                      error,
                    });
                  } finally {
                    completed++;
                    if (!signal.aborted)
                      update({ description: progress(completed), confirmDisabled: true });
                  }
                }
                if (signal.aborted) return;
                update({
                  title: msg("deleteTitle", { count: previews.size }),
                  description: [
                    msg("deleteDescription"),
                    section("willDelete", willDelete),
                    section("willKeep", [...retained, msg("keepShares"), msg("keepExternal")]),
                    section("cannotDelete", blocked),
                  ].join("\n\n"),
                  confirmLabel: msg("deleteCount", { count: previews.size }),
                  confirmDisabled: previews.size === 0,
                });
              },
            },
            operationLifetime.signal,
          ))
        )
          return;
        counts.skipped = blocked.length;
        counts.details.push(...blocked);
      }
      for (const task of candidates) {
        if (operation === "delete" && !previews.has(archiveTaskKey(task))) continue;
        if (
          !latest.current.tree.tasks.some(
            (t) => archiveTaskKey(t) === archiveTaskKey(task) && t.archived,
          )
        ) {
          counts.skipped++;
          counts.details.push(`${label(task)} — ${reason("not-archived")}`);
          continue;
        }
        try {
          if (operation === "delete") {
            const approved = previews.get(archiveTaskKey(task));
            if (!approved) continue;
            const result = await permanentlyDeleteProjectTask(
              { service, controller },
              task,
              approved.preview.revision,
              crypto.randomUUID(),
              approved.remoteSessionId,
            );
            if (result.status !== "deleted") {
              if (result.status === "blocked") counts.skipped++;
              else counts.failed++;
              counts.details.push(
                `${label(task)} — ${result.status === "incomplete" ? msg("incomplete") : reason(result.reason)}`,
              );
              continue;
            }
            counts.details.push(
              msg("deletedResult", { title: task.title, count: result.retainedArtifacts }),
            );
            for (const id of result.sessionIds) {
              clearBrowserRecentVisitsForTask(
                task.workspaceIdentity?.trim() || task.workspacePath,
                id,
              );
              removeTaskState(task.workspacePath, id, task.workspaceIdentity);
            }
          } else {
            const remoteSessionId = resolveRemoteWorkspaceSessionIdForTarget({
              ...task,
              state: useRemoteWorkspaceSessionStore.getState(),
            });
            await mutateProjectTask(
              { service, controller },
              task,
              { kind: "archive", archived: false },
              remoteSessionId,
            );
          }
          counts.succeeded++;
        } catch (error) {
          counts.failed++;
          counts.details.push(`${label(task)} — ${msg("incomplete")}`);
          logger.error("[archive-management] 任务操作失败", {
            taskId: task.taskId,
            workspaceIdentity: task.workspaceIdentity,
            operation,
            error,
          });
        }
      }
      await latest.current
        .refresh()
        .catch((error) => logger.warn("[archive-management] 刷新失败", { error }));
      setResult(counts);
    } finally {
      if (activeOperation.current === operationLifetime) {
        activeOperation.current = null;
        setBusy(false);
      }
    }
  };
  return { ...directory, busy, result, run };
}
