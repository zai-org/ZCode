import { lstat, readdir, rm } from "node:fs/promises";
import { basename, dirname, join, relative, isAbsolute } from "node:path";

import type { SessionDataDirectory, SessionDataFilesPort, SessionDataFile } from "./contract.js";

export type { SessionDataDirectory, SessionDataFilesPort } from "./contract.js";

export interface NodeSessionDataFilesOptions {
  cliStorageRoot: string;
  /** 返回 `<cli>/memories/projects/<slug>-<hash>/memory`；删除其父目录。 */
  memoryRoot(directory: SessionDataDirectory): string;
}

/** 会话目录（每个会话一个子目录）与模型调用轨迹（每个会话一个文件）所在的位置。 */
const SESSION_DIRECTORY_ROOTS = ["artifacts", "exec", "agents", "sessions"] as const;
const MODEL_IO_DIRECTORIES = ["debug", "rollout"] as const;
const MEMORY_PROJECTS_PATH = ["memories", "projects"] as const;
// 会话 ID 直接拼进路径，必须是单个安全文件名段。
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/;

export function createNodeSessionDataFiles(
  options: NodeSessionDataFilesOptions,
): SessionDataFilesPort {
  const root = options.cliStorageRoot;
  const sessionPaths = (sessionId: string) => {
    if (!SAFE_SESSION_ID.test(sessionId)) throw new Error("session-data.invalid-session-id");
    return [
      ...SESSION_DIRECTORY_ROOTS.map((name) => join(root, name, sessionId)),
      ...MODEL_IO_DIRECTORIES.map((name) => join(root, name, `model-io-${sessionId}.jsonl`)),
    ];
  };
  const memoryPath = (directory: SessionDataDirectory) => {
    const projectFolder = dirname(options.memoryRoot(directory));
    const projects = join(root, ...MEMORY_PROJECTS_PATH);
    const inside = relative(projects, projectFolder);
    // 只允许 memories/projects 的直接子目录，防止解析结果越界删到别处。
    if (
      !inside ||
      inside.startsWith("..") ||
      isAbsolute(inside) ||
      inside.includes("/") ||
      inside.includes("\\")
    )
      throw new Error("session-data.memory-outside-storage");
    return projectFolder;
  };
  const measureAll = async (paths: string[]) =>
    (await Promise.all(paths.map(measurePath))).reduce((sum, bytes) => sum + bytes, 0);
  const removeAll = async (paths: string[]) => {
    const bytes = await measureAll(paths);
    // rm 不跟随目录内的符号链接；顶层是链接时只删除链接本身。
    await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
    return bytes;
  };
  const listSessionFiles = async (sessionId: string): Promise<SessionDataFile[]> => {
    const result: SessionDataFile[] = [];
    for (const path of sessionPaths(sessionId)) {
      const kind = path === join(root, "artifacts", sessionId) ? "artifact" : "record";
      const walk = async (current: string): Promise<void> => {
        let stats;
        try {
          stats = await lstat(current);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
          throw error;
        }
        if (stats.isSymbolicLink()) {
          result.push({
            name: basename(current),
            relativePath: relative(root, current),
            kind,
            bytes: 0,
          });
          return;
        }
        if (stats.isDirectory()) {
          for (const entry of await readdir(current)) await walk(join(current, entry));
          return;
        }
        result.push({
          name: basename(current),
          relativePath: relative(root, current),
          kind,
          bytes: stats.size,
        });
      };
      // 存储类别目录若被换成链接，不能沿祖先链接清理用户文件。
      const parent = await lstat(dirname(path)).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (parent?.isSymbolicLink()) throw new Error("session-data.symlink-root");
      await walk(path);
    }
    return result.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  };
  const removeSession = async (
    sessionId: string,
    retained: readonly string[] = [],
  ): Promise<number> => {
    const paths = sessionPaths(sessionId);
    const manifest = await listSessionFiles(sessionId);
    if (!retained.length) {
      await removeAll(paths);
      return manifest.reduce((sum, file) => sum + file.bytes, 0);
    }
    // 保留 URI 定位所需的附件文件，绝不因为引用而留下正文、执行日志或其他独占附件。
    const keep = (file: SessionDataFile) =>
      file.kind === "artifact" && retained.some((id) => file.name.includes(id));
    let bytes = 0;
    for (const file of manifest) {
      if (keep(file)) continue;
      await rm(join(root, file.relativePath), { force: true });
      bytes += file.bytes;
    }
    for (const path of paths.slice(1)) await rm(path, { recursive: true, force: true });
    return bytes;
  };
  return {
    measureSession: async (sessionId) => measureAll(sessionPaths(sessionId)),
    removeSession,
    listSessionFiles,
    measureMemory: async (directory) => measureAll([memoryPath(directory)]),
    removeMemory: async (directory) => removeAll([memoryPath(directory)]),
  };
}

async function measurePath(path: string): Promise<number> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  if (stats.isSymbolicLink()) return 0;
  if (!stats.isDirectory()) return stats.size;
  const entries = await readdir(path);
  const sizes = await Promise.all(entries.map((entry) => measurePath(join(path, entry))));
  return sizes.reduce((sum, bytes) => sum + bytes, 0);
}
