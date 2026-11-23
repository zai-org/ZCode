import { useEffect, useMemo, useState } from "react";
import type { WorkspaceFileEntry } from "@zcode/shared";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { buildFileMentionMarkdown } from "@/mentions/mentionMarkdown.js";
import { WORKSPACE_FILE_SEARCH_DISPLAY_CAP } from "@zcode/shared/workspaceFileSearch";
import { getMentionGroupLimitForQuery } from "@/mentions/mentionSearch.js";
import type { MentionCategoryResult, MentionItem } from "@/mentions/mentionTypes.js";

export function isLocalWorkspaceForFileMentionIndex(workspaceIdentity?: string): boolean {
  return !workspaceIdentity?.trim();
}

type ProjectFileEntry = WorkspaceFileEntry & {
  rootPath?: string;
  rootName?: string;
  mentionPath?: string;
};

function mapWorkspaceFileToMentionItem(entry: ProjectFileEntry): MentionItem {
  const mentionPath = entry.mentionPath ?? entry.relativePath;
  return {
    id: `file:${entry.path}`,
    category: "files",
    label: entry.name,
    description: entry.relativePath,
    value: mentionPath,
    // Bugfix: 文件 mention 的标准转译格式需要保持 `[filename](path)`，
    // 之前这里误把整条 relativePath 当成链接文本，导致发送后回显和复制内容都退化成“长路径做标题”。
    // 这里恢复为只用 basename 做 label，路径只放在链接目标里，和输入框 node 样式保持一致。
    markdown: buildFileMentionMarkdown(mentionPath, entry.name, entry.type),
    keywords: [entry.relativePath, entry.path],
    data: {
      kind: entry.type,
      path: entry.path,
      relativePath: entry.relativePath,
      rootName: entry.rootName,
    },
  };
}

function normalizeRefreshQuery(query: string): string {
  return query.trim().toLowerCase();
}

/** 上一份结果属于同一生命周期、同一查询且已成功返回时，刷新期间继续展示它。 */
function isRevalidation<TScope extends { lifecycle: object }>(
  previous: {
    scope: TScope;
    query: string;
    limit: number;
    loading: boolean;
    error: Error | null;
  } | null,
  scope: TScope,
  query: string,
  limit: number,
): previous is NonNullable<typeof previous> {
  return (
    previous !== null &&
    previous.scope !== scope &&
    previous.scope.lifecycle === scope.lifecycle &&
    previous.query === query &&
    previous.limit === limit &&
    !previous.loading &&
    previous.error === null
  );
}

export function useFileMentionProvider(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  query: string,
  enabled: boolean,
  emptyText: string,
  title: string,
  defaultPreviewLimit?: number,
  context?: { sessionId?: string | null; projectId?: string | null },
): MentionCategoryResult {
  const { services } = useWorkspaceServicesResolution(workspacePath, undefined, workspaceIdentity);
  const { fileService, projectService } = services;
  const sessionId = context?.sessionId;
  const projectId = context?.projectId;
  const [projectRevision, setProjectRevision] = useState(0);
  useEffect(() => {
    const subscription = services.broadcastService.onMessage((event) => {
      if (event.channel === "state:projects") setProjectRevision((value) => value + 1);
    });
    return () => subscription.dispose();
  }, [services]);
  const limit =
    getMentionGroupLimitForQuery(query, defaultPreviewLimit) ?? WORKSPACE_FILE_SEARCH_DISPLAY_CAP;
  // 连接实例也属于作用域：相同路径的远程重连不能接纳旧 Host 的查询结果。
  const lifecycle = useMemo(
    () => ({}),
    [fileService, projectService, workspacePath, workspaceIdentity, enabled, sessionId, projectId],
  );
  // 项目变更只开启同一生命周期内的一次重新查询（revalidate），不切换作用域。
  const scope = useMemo(
    () => ({
      lifecycle,
      error: null as Error | null,
      lastMissQuery: null as string | null,
    }),
    [lifecycle, projectRevision],
  );
  const [result, setResult] = useState<{
    scope: typeof scope;
    query: string;
    limit: number;
    entries: ProjectFileEntry[];
    loading: boolean;
    error: Error | null;
  } | null>(null);

  useEffect(() => {
    // 错误态等待面板/工作区/连接生命周期重置，避免 query 变化触发失败重试循环。
    if (!enabled || scope.error) return;
    let active = true;
    // Bug 根因（ZCT-2122356778527907840）：state:projects 会因后台任务状态变化频繁到达，
    // 之前每次都先把结果清空成加载占位，列表高度塌缩，用户滚到中段的位置随之丢失。
    // 修法：同一生命周期、同一查询的刷新保留上一份结果，新结果回来后整体替换。
    setResult((previous) =>
      isRevalidation(previous, scope, query, limit)
        ? previous
        : { scope, query, limit, entries: [], loading: true, error: null },
    );
    const readRoots = async () => {
      if ((sessionId || projectId) && !projectService)
        throw new Error("project.service-unavailable");
      if (sessionId)
        return (
          await projectService!.resolveSessionDirectories({
            taskId: sessionId,
            workspacePath,
            workspaceIdentity,
          })
        ).additionalDirectories;
      if (projectId) {
        const project = (await projectService!.readProjects()).find(
          (project) => project.id === projectId,
        );
        if (!project) throw new Error("project.not-found");
        return project.roots.map((root) => root.rootPath);
      }
      return [];
    };
    const read = async (refresh = false): Promise<ProjectFileEntry[]> => {
      const roots = [...new Set([workspacePath, ...(await readRoots())])];
      if (!active) return [];
      const results = await Promise.all(
        roots.map(async (rootPath) =>
          (
            await fileService.searchWorkspaceFiles({
              rootPath,
              workspaceIdentity,
              query,
              limit,
              ...(refresh ? { refresh: true } : {}),
            })
          ).map((entry) => ({
            ...entry,
            rootPath,
            rootName: rootPath.split(/[\\/]/).filter(Boolean).at(-1) ?? rootPath,
            mentionPath: rootPath === workspacePath ? entry.relativePath : entry.path,
          })),
        ),
      );
      const unique = new Map<string, ProjectFileEntry>();
      for (const entry of results.flat())
        if (!unique.has(entry.path)) unique.set(entry.path, entry);
      return [...unique.values()].slice(0, limit);
    };
    const search = async () => {
      try {
        let entries = await read();
        if (!active) return;
        const normalizedQuery = normalizeRefreshQuery(query);
        if (entries.length === 0 && normalizedQuery && scope.lastMissQuery !== normalizedQuery) {
          scope.lastMissQuery = normalizedQuery;
          // 无命中补扫必须绕过 Host TTL，否则外部新文件在缓存有效期内永远不可见。
          entries = await read(true);
          if (!active) return;
        }
        setResult({ scope, query, limit, entries, loading: false, error: null });
      } catch (error) {
        if (!active) return;
        scope.error = error instanceof Error ? error : new Error(String(error));
        setResult({ scope, query, limit, entries: [], loading: false, error: scope.error });
      }
    };
    void search();
    // 查询、工作区、连接或面板生命周期变化都使已发出的异步响应失效。
    return () => {
      active = false;
    };
  }, [
    enabled,
    fileService,
    projectService,
    workspacePath,
    workspaceIdentity,
    sessionId,
    projectId,
    query,
    limit,
    scope,
  ]);

  const current =
    enabled &&
    ((result?.scope === scope && result.query === query && result.limit === limit) ||
      isRevalidation(result, scope, query, limit));
  const items = useMemo(
    () => (current ? result.entries.map(mapWorkspaceFileToMentionItem) : []),
    [current, result],
  );
  return {
    items,
    loading: enabled && !scope.error && (!current || result.loading),
    error: enabled ? scope.error : null,
    emptyText,
    title,
  };
}
