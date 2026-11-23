import { useEffect, useMemo, useState } from "react";
import type { ProjectTree } from "@zcode/services";
import type { ZCodeProvider, ZCodeTaskMeta } from "@zcode/shared";
import { buildSessionMentionMarkdown } from "@/mentions/mentionMarkdown.js";
import { filterMentionItemsWithOptions } from "@/mentions/mentionSearch.js";
import type { MentionCategoryResult, MentionItem } from "@/mentions/mentionTypes.js";
import type { SessionMentionWorkspaceScope } from "@/mentions/mentionPanelRouting.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";

interface SessionMentionItem extends MentionItem {
  /** 只在候选聚合阶段分桶，不写入 Lexical node 或 canonical mention。 */
  workspaceKey: string;
}

function compareSessionTasks(
  left: ZCodeTaskMeta,
  right: ZCodeTaskMeta,
  currentWorkspaceKey?: string,
) {
  if (currentWorkspaceKey) {
    const leftCurrent =
      buildTaskWorkspaceKey(left.workspacePath, left.workspaceIdentity) === currentWorkspaceKey;
    const rightCurrent =
      buildTaskWorkspaceKey(right.workspacePath, right.workspaceIdentity) === currentWorkspaceKey;
    if (leftCurrent !== rightCurrent) return leftCurrent ? -1 : 1;
  }
  if (right.updatedAt !== left.updatedAt) return right.updatedAt - left.updatedAt;
  if (right.createdAt !== left.createdAt) return right.createdAt - left.createdAt;
  return left.title.localeCompare(right.title);
}

function getSessionLabel(task: ZCodeTaskMeta): string {
  const title = task.title.replace(/^#(?:sess|session)_[a-zA-Z0-9._-]+\s*/, "").trim();
  return title || "Untitled session";
}

function getWorkspaceLabel(task: ZCodeTaskMeta): string {
  const raw = task.workspacePath.trim() || task.workspaceIdentity?.trim() || "";
  return raw.split(/[\\/]/).filter(Boolean).at(-1) ?? raw;
}

function mapTaskToMentionItem(task: ZCodeTaskMeta, provider: ZCodeProvider): SessionMentionItem {
  const sessionId = task.taskId;
  const itemProvider = task.provider ?? provider;
  return {
    id: `session:${task.taskId}`,
    category: "sessions",
    label: getSessionLabel(task),
    description: getWorkspaceLabel(task),
    value: sessionId,
    markdown: buildSessionMentionMarkdown(sessionId, getSessionLabel(task)),
    keywords: [
      task.title,
      task.taskId,
      task.workspacePath,
      task.workspaceIdentity ?? "",
      task.model ?? "",
      itemProvider,
    ],
    workspaceKey: buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity),
  };
}

export function collectSessionMentionItems(
  tasks: ZCodeTaskMeta[],
  provider: ZCodeProvider,
  options: {
    workspacePath?: string;
    workspaceIdentity?: string;
  } = {},
): SessionMentionItem[] {
  const currentWorkspaceKey = options.workspacePath
    ? buildTaskWorkspaceKey(options.workspacePath, options.workspaceIdentity)
    : undefined;
  const taskBySessionId = new Map<string, ZCodeTaskMeta>();
  for (const task of tasks) {
    if (task.migrationSource) {
      continue;
    }
    const sessionId = task.taskId;
    const current = taskBySessionId.get(sessionId);
    if (!current || task.updatedAt > current.updatedAt) {
      taskBySessionId.set(sessionId, task);
    }
  }

  return [...taskBySessionId.values()]
    .sort((left, right) => compareSessionTasks(left, right, currentWorkspaceKey))
    .map((task) => mapTaskToMentionItem(task, provider));
}

export function useSessionsMentionProvider(
  provider: ZCodeProvider,
  workspacePath: string,
  workspaceIdentity: string | undefined,
  query: string,
  enabled: boolean,
  workspaceScope: SessionMentionWorkspaceScope,
  emptyText: string,
  title: string,
  unclassifiedTitle = title,
): MentionCategoryResult {
  const { services } = useWorkspaceServicesResolution(workspacePath, undefined, workspaceIdentity);
  const [snapshot, setSnapshot] = useState<{
    services: typeof services;
    tree: ProjectTree;
    error: Error | null;
    loading: boolean;
  } | null>(null);
  useEffect(() => {
    if (!enabled) {
      setSnapshot(null);
      return;
    }
    let current = true;
    let generation = 0;
    const refresh = async () => {
      const request = ++generation;
      // Bug 根因（ZCT-2122356778527907840）：state:projects 刷新时先清空成加载占位，
      // 候选列表高度塌缩，用户滚到中段的位置丢失。同一服务下已有成功结果时保留旧树，
      // 新树回来后整体替换。
      setSnapshot((previous) =>
        previous?.services === services && !previous.loading && previous.error === null
          ? previous
          : { services, tree: { projects: [], tasks: [] }, error: null, loading: true },
      );
      try {
        if (!services.projectService) throw new Error("project.service-unavailable");
        // 候选行由 Host 组织态与 CLI 镜像决定；不能让缺席的 sessions-index 或 tab 隐藏历史任务。
        const tree = await services.projectService.readTree({ includeDeleted: true });
        if (current && request === generation)
          setSnapshot({ services, tree, error: null, loading: false });
      } catch (error) {
        if (current && request === generation)
          setSnapshot({
            services,
            tree: { projects: [], tasks: [] },
            error: error instanceof Error ? error : new Error(String(error)),
            loading: false,
          });
      }
    };
    const listener = services.broadcastService.onMessage((event) => {
      if (event.channel === "state:projects") void refresh();
    });
    void refresh();
    return () => {
      current = false;
      listener.dispose();
    };
  }, [enabled, services]);
  const tree = snapshot?.services === services ? snapshot.tree : null;
  const groups = useMemo(() => {
    if (!tree) return [];
    const currentKey = buildTaskWorkspaceKey(workspacePath, workspaceIdentity);
    const visibleTasks = tree.tasks.filter(
      (task) =>
        workspaceScope !== "current-workspace" ||
        buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity) === currentKey,
    );
    const buckets = new Map<string, { id: string; title: string; tasks: ZCodeTaskMeta[] }>();
    for (const task of visibleTasks) {
      const id =
        workspaceScope === "current-workspace"
          ? "sessions"
          : JSON.stringify([task.hostId, task.projectId]);
      const project = tree.projects.find(
        (project) => project.id === task.projectId && project.hostId === task.hostId,
      );
      const bucket = buckets.get(id) ?? {
        id,
        title:
          workspaceScope === "current-workspace" ? title : (project?.name ?? unclassifiedTitle),
        tasks: [],
      };
      bucket.tasks.push(task);
      buckets.set(id, bucket);
    }
    return [...buckets.values()].map((bucket) => ({
      id: bucket.id,
      title: bucket.title,
      items: filterMentionItemsWithOptions(
        collectSessionMentionItems(bucket.tasks, provider),
        query,
        {
          limit: workspaceScope === "current-workspace" ? Number.POSITIVE_INFINITY : 20,
          requireQuery: false,
        },
      ),
    }));
  }, [
    tree,
    workspacePath,
    workspaceIdentity,
    workspaceScope,
    title,
    unclassifiedTitle,
    provider,
    query,
  ]);
  return {
    items: enabled ? groups.flatMap((group) => group.items) : [],
    groups: enabled && workspaceScope !== "current-workspace" ? groups : undefined,
    loading: enabled && (!snapshot || snapshot.services !== services || snapshot.loading),
    error: snapshot?.services === services ? snapshot.error : null,
    emptyText,
    title,
  };
}
