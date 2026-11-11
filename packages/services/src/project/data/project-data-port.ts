// ProjectDataPort 的装配实现：会话与记忆交给 CLI（v4/storage/sessionData/*），
// 文件检查点由 Host 自己删除（它是 git checkpoint store 的写者）。
import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  V4SessionDataMeasureResult,
  V4SessionDataParams,
  V4SessionDataPurgeResult,
} from "@zcode/shared/zcode-protocol-v4";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import type { ProjectDataPort, ProjectDataSession } from "#src/project/data/contract.js";

const log = createServiceLogger("project-data");

export interface ProjectSessionDataAgent {
  measure(params: V4SessionDataParams): Promise<V4SessionDataMeasureResult>;
  /** workspace 决定由哪个 Agent 进程执行：该 workspace 已有进程时交给它，否则交给管理面进程。 */
  purge(
    params: V4SessionDataParams & { workspace: { workspacePath: string } },
  ): Promise<V4SessionDataPurgeResult>;
}

/** 只统计普通文件；不跟随符号链接，缺失按 0。 */
async function directoryBytes(path: string): Promise<number> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  if (stats.isFile()) return stats.size;
  if (!stats.isDirectory()) return 0;
  const entries = await readdir(path);
  const sizes = await Promise.all(entries.map((entry) => directoryBytes(join(path, entry))));
  return sizes.reduce((sum, bytes) => sum + bytes, 0);
}

export function createProjectDataPort(options: {
  agent: ProjectSessionDataAgent;
  checkpointDirectory(workspacePath: string): string;
}): ProjectDataPort {
  const local = (paths: readonly string[]) => paths.map((workspacePath) => ({ workspacePath }));
  return {
    async measure({ sessions, directories }) {
      const [agent, checkpoints] = await Promise.all([
        options.agent.measure({
          sessionIds: sessions.map((session) => session.sessionId),
          directories: local(directories),
        }),
        Promise.all(directories.map((path) => directoryBytes(options.checkpointDirectory(path)))),
      ]);
      const memory = new Map(agent.memory.map((entry) => [entry.workspacePath, entry.bytes]));
      return {
        sessions: agent.sessions,
        directories: directories.map((path, index) => ({
          path,
          memoryBytes: memory.get(path) ?? 0,
          checkpointBytes: checkpoints[index]!,
        })),
      };
    },

    async purgeSessions(sessions) {
      // 修复原因：曾按会话 cwd 分组并选进程；worktree 任务的 cwd 是 worktree，没有对应进程，
      // 删除被交给管理面进程，它看不到项目进程中正在运行的会话，可能删掉运行中的会话、
      // 且项目进程的 sessions-index 仍保留它。会话属于归属 workspace 的进程（docs/git/worktree.md §2.1）。
      const byWorkspace = new Map<string, ProjectDataSession[]>();
      for (const session of sessions)
        byWorkspace.set(session.workspacePath, [
          ...(byWorkspace.get(session.workspacePath) ?? []),
          session,
        ]);
      const result: Awaited<ReturnType<ProjectDataPort["purgeSessions"]>> = {
        deleted: [],
        kept: [],
        failed: [],
      };
      // 逐个 workspace 串行：每组只交给持有这些会话运行态的那个进程，避免并发写同一个 CLI 库。
      for (const [workspacePath, group] of byWorkspace) {
        try {
          const purged = await options.agent.purge({
            workspace: { workspacePath },
            sessionIds: group.map((session) => session.sessionId),
            directories: [],
          });
          result.deleted.push(...purged.deleted);
          result.kept.push(...purged.kept);
          result.failed.push(...purged.failed.flatMap((entry) => entry.sessionId ?? []));
        } catch (error) {
          // 整组未执行：行与文件都还在，按失败计入，重试时重新执行。
          log.warn(undefined, "Session data purge failed", {
            sessions: group.length,
            error: String(error),
          });
          result.failed.push(...group.map((session) => session.sessionId));
        }
      }
      return result;
    },

    async purgeDirectories(directories) {
      let bytes = 0;
      const failed: string[] = [];
      try {
        const purged = await options.agent.purge({
          workspace: { workspacePath: directories[0]! },
          sessionIds: [],
          directories: local(directories),
        });
        bytes += purged.memory.reduce((sum, entry) => sum + entry.bytes, 0);
        failed.push(...purged.failed.flatMap((entry) => entry.workspacePath ?? []));
      } catch (error) {
        log.warn(undefined, "Memory purge failed", {
          directories: directories.length,
          error: String(error),
        });
        failed.push(...directories);
      }
      for (const path of directories) {
        const directory = options.checkpointDirectory(path);
        try {
          const size = await directoryBytes(directory);
          await rm(directory, { recursive: true, force: true });
          bytes += size;
        } catch (error) {
          log.warn(undefined, "Checkpoint purge failed", { error: String(error) });
          if (!failed.includes(path)) failed.push(path);
        }
      }
      return { bytes, failed };
    },
  };
}
