// 彻底删除项目数据（设置 → 项目的「同时删除 ZCode 数据」）。
// 规格：docs/superpowers/specs/2026-10-24-project-management.md「彻底删除数据」。
import { z } from "zod";
import type { ProjectRepositoryContract } from "#src/project-storage/contract.js";
import type { ProjectDataRepositoryContract } from "#src/project-storage/index.js";
import type { IProjectService } from "#src/project/contract.js";
import type {
  ProjectDataMeasure,
  ProjectDataPort,
  ProjectDataSession,
} from "#src/project/data/contract.js";

const idsSchema = z.array(z.string().min(1)).min(1);

/**
 * 每个项目可删除的目录 = roots ∪ 会话 cwd，扣除仍被范围外的项目作为 root、或被范围外
 * 任务作为 cwd 使用的目录（共享目录的记忆与检查点保留）。同批多个项目共享的目录只分给第一个。
 * 必须在删除任务行之前调用：候选 cwd 来自项目现有的任务行。
 */
function deletableDirectories(
  repository: ProjectRepositoryContract,
  rows: ProjectDataRepositoryContract,
  scope: readonly string[],
  extraInUse: readonly string[] = [],
): Map<string, string[]> {
  const inScope = new Set(scope);
  const projects = repository.readTree({ includeDeleted: true, includeTasks: false }).projects;
  const inUse = new Set([
    ...projects
      // 已软删除的项目也算：它们可以恢复，宁可保留共享目录的数据（2026-10-25 裁决）。
      .filter((project) => !inScope.has(project.id))
      .flatMap((project) => project.roots.map((root) => root.rootPath)),
    ...rows
      .readTaskDirectories()
      .filter((task) => task.projectId === null || !inScope.has(task.projectId))
      .map((task) => task.cwd),
    ...extraInUse,
  ]);
  const assigned = new Set<string>();
  return new Map(
    scope.map((id) => {
      const project = projects.find((entry) => entry.id === id);
      const candidates = [
        ...(project?.roots.map((root) => root.rootPath) ?? []),
        ...rows.readProjectTaskRefs(id).map((task) => task.cwd),
      ];
      const directories = [...new Set(candidates)].filter(
        (path) => !inUse.has(path) && !assigned.has(path),
      );
      for (const path of directories) assigned.add(path);
      return [id, directories];
    }),
  );
}

export function createProjectDataCommands(options: {
  repository(): Promise<ProjectRepositoryContract>;
  ownerHostId?: string;
  data?: { port: ProjectDataPort; repository(): Promise<ProjectDataRepositoryContract> };
  changed(): Promise<void>;
}): Pick<IProjectService, "measureProjectData" | "deleteProjectData"> {
  // 数据只在本机删除：远程项目的数据在其设备上，Source Server 自身也不开放这条路径。
  const requireLocal = (hostId?: string) => {
    const owner = options.ownerHostId ?? "local";
    if (owner !== "local" || (hostId && hostId !== owner))
      throw new Error("project.data-local-only");
    if (!options.data) throw new Error("project.data-unavailable");
    return options.data;
  };
  return {
    async measureProjectData(ids, hostId) {
      idsSchema.parse(ids);
      const data = requireLocal(hostId);
      const repository = await options.repository();
      const rows = await data.repository();
      const directories = deletableDirectories(repository, rows, ids);
      const sessions = new Map<string, ProjectDataSession[]>(
        ids.map((id) => [
          id,
          rows
            .readProjectTaskRefs(id)
            .map((task) => ({ sessionId: task.taskId, workspacePath: task.workspacePath })),
        ]),
      );
      const measured = await data.port.measure({
        sessions: [...sessions.values()].flat(),
        directories: [...directories.values()].flat(),
      });
      const sessionBytes = new Map(
        measured.sessions.map((entry) => [entry.sessionId, entry.bytes]),
      );
      const directoryBytes = new Map(measured.directories.map((entry) => [entry.path, entry]));
      const projects: ProjectDataMeasure[] = ids.map((id) => {
        const own = (directories.get(id) ?? []).map((path) => directoryBytes.get(path));
        return {
          id,
          sessions: sessions.get(id)!.length,
          sessionBytes: sessions
            .get(id)!
            .reduce((sum, session) => sum + (sessionBytes.get(session.sessionId) ?? 0), 0),
          memoryBytes: own.reduce((sum, entry) => sum + (entry?.memoryBytes ?? 0), 0),
          checkpointBytes: own.reduce((sum, entry) => sum + (entry?.checkpointBytes ?? 0), 0),
        };
      });
      return { projects };
    },

    async deleteProjectData(id, hostId) {
      z.string().min(1).parse(id);
      const data = requireLocal(hostId);
      const repository = await options.repository();
      const rows = await data.repository();
      const project = repository
        .readTree({ includeDeleted: true, includeTasks: false })
        .projects.find((entry) => entry.id === id);
      if (!project) throw new Error("project.not-found");
      // 只删已移除的项目：保证不会删到侧栏里仍在使用的项目。
      if (!project.deleted) throw new Error("project.data-requires-removed");
      const tasks = rows.readProjectTaskRefs(id);
      const sessions = await data.port.purgeSessions(
        tasks.map((task) => ({ sessionId: task.taskId, workspacePath: task.workspacePath })),
      );
      const deleted = new Set(sessions.deleted.map((entry) => entry.sessionId));
      const deletedTasks = tasks.filter((task) => deleted.has(task.taskId));
      // 保留下来的会话仍在用自己的 cwd：其记忆与检查点不能删。
      const survivors = tasks.filter((task) => !deleted.has(task.taskId)).map((task) => task.cwd);
      // 修复原因：目录曾在删除任务行之后才计算，已删任务独有的 cwd（如 roots 变更前的旧目录）
      // 从候选里消失，记忆与检查点永久漏删。任务行此时都还在。
      const directories = deletableDirectories(repository, rows, [id], survivors).get(id) ?? [];
      const folders = directories.length
        ? await data.port.purgeDirectories(directories)
        : { bytes: 0, failed: [] };
      // CLI 已删行后才动 Host 行；CLI 失败的会话行原样保留，重试仍能找到。
      if (folders.failed.length) {
        // 修复原因：目录删除失败后曾照样删任务行和项目行，重试只得到 project.not-found，残留永远删不掉。
        // 只隐藏这些行并保留软删除项目，重试按它们重新算出失败的目录。
        rows.markTasksDeleted(deletedTasks);
      } else {
        rows.purgeTasks(deletedTasks);
        rows.purgeProjectIfUnreferenced(id);
      }
      await options.changed();
      return {
        freedBytes: sessions.deleted.reduce((sum, entry) => sum + entry.bytes, 0) + folders.bytes,
        deletedSessions: sessions.deleted.length,
        runningSessions: sessions.kept.filter((entry) => entry.reason === "running").length,
        referencedSessions: sessions.kept.filter((entry) => entry.reason === "referenced").length,
        failed: sessions.failed.length + folders.failed.length,
      };
    },
  };
}
