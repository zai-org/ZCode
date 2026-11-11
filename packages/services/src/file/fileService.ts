/* eslint-disable max-lines */
import type { Dirent } from "node:fs";
import { mkdir, open, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, relative, sep } from "node:path";
import type {
  FileBinaryPreview,
  FileEntry,
  FileMediaPreview,
  FileTextSlice,
  WorkspaceFileEntry,
} from "@zcode/shared";
import { getMediaPreviewFormat, REMOTE_WORKSPACE_PREPARATION_TIMEOUT_MS } from "@zcode/shared";
import { packWorkspaceFileEntries } from "@zcode/shared/workspaceFileEntriesCodec";
import type { IFileService, WorkspaceFileSearchParams } from "./file.js";
import { WORKSPACE_FILE_SEARCH_DISPLAY_CAP } from "@zcode/shared/workspaceFileSearch";
import { buildHostFileSearchCandidates, searchHostFileCandidates } from "./workspaceFileSearch.js";
import {
  defaultWorkspaceFileSearchFilter,
  type WorkspaceFileSearchFilter,
} from "./workspaceFileMentionFilter.js";
import {
  WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME,
  isWorkspaceFileSearchPathIgnored,
  loadWorkspaceFileSearchIgnoreRules,
  readWorkspaceFileSearchIgnore,
  transformWorkspaceFileSearchIgnore,
  writeWorkspaceFileSearchIgnore,
} from "./workspaceFileIgnore.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { getConversationWorkspaceDir } from "../paths.js";
const DEFAULT_TEXT_READ_BYTES = 128 * 1024;
const MAX_TEXT_READ_BYTES = 256 * 1024;
const DEFAULT_MEDIA_PREVIEW_BYTES = 4 * 1024 * 1024;
const MAX_MEDIA_PREVIEW_BYTES = 8 * 1024 * 1024;
const DEFAULT_BINARY_READ_BYTES = 256 * 1024;
const MAX_BINARY_READ_BYTES = 1024 * 1024;
const DEFAULT_BINARY_PREVIEW_BYTES = 25 * 1024 * 1024;
const MAX_BINARY_PREVIEW_BYTES = 25 * 1024 * 1024;
const FILE_EXISTENCE_CACHE_TTL_MS = 60_000;
const FILE_EXISTENCE_CACHE_MAX_ENTRIES = 100;
const FILE_EXISTENCE_BATCH_LIMIT = 15;
const IMAGE_EXTENSION_TO_MEDIA_TYPE: Record<string, string> = {
  ".apng": "image/apng",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};
function clampReadLength(length?: number) {
  const safeLength = Number.isFinite(length)
    ? Math.trunc(length ?? DEFAULT_TEXT_READ_BYTES)
    : DEFAULT_TEXT_READ_BYTES;
  return Math.min(Math.max(safeLength, 1), MAX_TEXT_READ_BYTES);
}
function clampMediaPreviewBytes(length?: number) {
  const safeLength = Number.isFinite(length)
    ? Math.trunc(length ?? DEFAULT_MEDIA_PREVIEW_BYTES)
    : DEFAULT_MEDIA_PREVIEW_BYTES;
  return Math.min(Math.max(safeLength, 1), MAX_MEDIA_PREVIEW_BYTES);
}
function clampBinaryReadLength(length?: number) {
  const safeLength = Number.isFinite(length)
    ? Math.trunc(length ?? DEFAULT_BINARY_READ_BYTES)
    : DEFAULT_BINARY_READ_BYTES;
  return Math.min(Math.max(safeLength, 1), MAX_BINARY_READ_BYTES);
}
function clampBinaryPreviewBytes(length?: number) {
  const safeLength = Number.isFinite(length)
    ? Math.trunc(length ?? DEFAULT_BINARY_PREVIEW_BYTES)
    : DEFAULT_BINARY_PREVIEW_BYTES;
  return Math.min(Math.max(safeLength, 1), MAX_BINARY_PREVIEW_BYTES);
}
function inferMediaTypeFromPath(path: string): string {
  return (
    IMAGE_EXTENSION_TO_MEDIA_TYPE[extname(path).toLowerCase()] ??
    getMediaPreviewFormat(path)?.mediaType ??
    "application/octet-stream"
  );
}
function isProbablyBinary(buffer: Buffer): boolean {
  if (buffer.length === 0) {
    return false;
  }
  let suspiciousBytes = 0;
  for (const value of buffer) {
    if (value === 0) {
      return true;
    }
    const isCommonWhitespace = value === 9 || value === 10 || value === 12 || value === 13;
    const isControlChar =
      (value >= 1 && value <= 8) || (value >= 14 && value <= 31) || value === 127;
    if (!isCommonWhitespace && isControlChar) {
      suspiciousBytes += 1;
    }
  }
  return suspiciousBytes / buffer.length > 0.3;
}
const SCRATCH_WORKSPACE_ROOT_NAME = "ZCodeProject";
function validateScratchWorkspaceName(name: string): string {
  const trimmedName = name.trim();
  if (!trimmedName) {
    throw new Error("Workspace name is required.");
  }
  if (/[\\/]/.test(trimmedName)) {
    throw new Error("Workspace name cannot contain path separators.");
  }
  return trimmedName;
}
function normalizeRelativePath(rootPath: string, targetPath: string): string {
  return relative(rootPath, targetPath).split(sep).join("/");
}
export function isSkippableWorkspaceFileListError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "EACCES" || code === "EPERM" || code === "ENOENT";
}

interface FileExistenceCacheEntry {
  exists: boolean;
  expiresAt: number;
}

export class FileExistenceCache {
  private readonly entries = new Map<string, FileExistenceCacheEntry>();

  get size(): number {
    return this.entries.size;
  }

  get(path: string): boolean | undefined {
    const cached = this.entries.get(path);
    if (!cached) {
      return undefined;
    }
    if (cached.expiresAt <= Date.now()) {
      this.entries.delete(path);
      return undefined;
    }

    // Map 保留插入顺序；命中后重新插入，让真正活跃的路径位于 LRU 队尾。
    this.entries.delete(path);
    this.entries.set(path, cached);
    return cached.exists;
  }

  set(path: string, exists: boolean): void {
    const now = Date.now();
    // 旧缓存只在同一路径再次读取时判断 TTL，不同路径的过期项会永久留在 Host 内存中。
    // 每次写入先清理全部过期项，再用固定容量兜住持续生成不同候选路径的长生命周期场景。
    for (const [cachedPath, cached] of this.entries) {
      if (cached.expiresAt <= now) {
        this.entries.delete(cachedPath);
      }
    }

    this.entries.delete(path);
    this.entries.set(path, {
      exists,
      expiresAt: now + FILE_EXISTENCE_CACHE_TTL_MS,
    });
    while (this.entries.size > FILE_EXISTENCE_CACHE_MAX_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (oldest.done) {
        break;
      }
      this.entries.delete(oldest.value);
    }
  }
}

async function resolveReaddirEntryType(
  entryPath: string,
  isDirectory: boolean,
  isSymbolicLink: boolean,
): Promise<FileEntry["type"]> {
  if (isDirectory) {
    return "directory";
  }
  if (!isSymbolicLink) {
    return "file";
  }
  try {
    const targetStat = await stat(entryPath);
    // Node 的 Dirent 对软链接目录只返回 isSymbolicLink，不会返回 isDirectory。
    // 目录选择器只展示 directory 类型，远程 SSH 选目录时因此看不到指向目录的软链接；这里跟随目标重新分类。
    return targetStat.isDirectory() ? "directory" : "file";
  } catch {
    return "file";
  }
}

export interface CreateFileServiceOptions {
  workspaceFileSearchFilter?: WorkspaceFileSearchFilter;
}

/**
 * listWorkspaceFiles 的 Host 侧短 TTL 缓存：
 * 37 万文件 workspace 的全仓扫描即使并发化也要数秒，同一 workspace 的
 * 反复打开（@ 面板关闭即清理的 renderer 语义、Command Center、文件树）
 * 不应每次都重扫。服务内按 workspaceIdentity（缺省为 rootPath）隔离，
 * 校验 rootPath + .zcodeignore 的 mtime/size 指纹；规则编辑后缓存失效，
 * 保持"编辑规则后下次使用生效"的契约。
 */
const WORKSPACE_FILE_LIST_CACHE_TTL_MS = 60_000;
const WORKSPACE_FILE_LIST_SCAN_CONCURRENCY = 8;
const WORKSPACE_FILE_LIST_CACHE_MAX_ENTRIES = 4;
interface WorkspaceFileIndex {
  at: number;
  signature: string;
  packed: string;
  candidates?: ReturnType<typeof buildHostFileSearchCandidates>;
}

async function statWorkspaceFileSearchIgnoreFingerprint(rootPath: string): Promise<string> {
  try {
    const fileStat = await stat(join(rootPath, WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME));
    return `${fileStat.mtimeMs}:${fileStat.size}`;
  } catch {
    return "none";
  }
}

// Bug 原因（ZCT-2113660144497782784）：目录的 readdir 可能永久不返回（例如 macOS 等待文件夹访问授权、
// 网络盘无响应），且无法取消，每次调用都占住一个 libuv 线程。Desktop 重启、重连或手机端再次打开同一项目时
// 会再读一次，线程池（默认 4 个）占满后，本进程所有文件操作都不再返回。
// 修复：同一路径已有读取超过无响应阈值仍未返回时，复用它，不再占新线程；返回后立即删除，不缓存结果。
// 阈值沿用 R8 的目录无响应判定；健康目录的读取到不了阈值，行为与过去相同。
const inFlightDirectoryReads = new Map<string, { startedAt: number; entries: Promise<Dirent[]> }>();

function readDirectoryEntries(path: string): Promise<Dirent[]> {
  const pending = inFlightDirectoryReads.get(path);
  if (pending && Date.now() - pending.startedAt >= REMOTE_WORKSPACE_PREPARATION_TIMEOUT_MS)
    return pending.entries;
  const read = { startedAt: Date.now(), entries: readdir(path, { withFileTypes: true }) };
  if (!pending) {
    const clear = () => {
      if (inFlightDirectoryReads.get(path) === read) inFlightDirectoryReads.delete(path);
    };
    read.entries.then(clear, clear);
    inFlightDirectoryReads.set(path, read);
  }
  return read.entries;
}

const DESIGN_SOURCE_EXTENSIONS = new Set([".html", ".htm"]);
const DESIGN_SOURCE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * 设计工具写回按文件串行（同一 Host 进程内所有 tab 共用），先按路径、再按文件身份各取一把锁（顺序固定，不会互等）：
 * - 文件身份（设备号 + inode）：硬链接等不同路径指向同一文件时也串行（!3450 CR-01）；
 * - 路径（realpath，不分大小写、统一分隔符）：外部「写临时文件再改名」保存后 inode 变了，同一路径的写回仍串行。
 * 拿不到 inode（个别文件系统报 0）时只用路径锁；文件不存在等按原路径，之后的读取会照常报错。
 */
const designSourceLocks = new Map<string, Promise<unknown>>();

function withDesignSourceKeyLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = designSourceLocks.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  const settled = next.catch(() => undefined);
  designSourceLocks.set(key, settled);
  void settled.then(() => {
    if (designSourceLocks.get(key) === settled) designSourceLocks.delete(key);
  });
  return next;
}

async function withDesignSourceLock<T>(path: string, task: () => Promise<T>): Promise<T> {
  const resolved = await realpath(path).catch(() => path);
  const pathKey = `path:${resolved.replace(/\\/g, "/").toLowerCase()}`;
  return withDesignSourceKeyLock(pathKey, async () => {
    const identity = await stat(path, { bigint: true }).catch(() => null);
    if (!identity || identity.ino <= 0n) return task();
    return withDesignSourceKeyLock(`inode:${identity.dev}:${identity.ino}`, task);
  });
}

async function readDesignSource(path: string): Promise<string> {
  if (!DESIGN_SOURCE_EXTENSIONS.has(extname(path).toLowerCase())) {
    throw new Error(`Design source must be an HTML file: ${path}`);
  }
  const fileStat = await stat(path);
  if (!fileStat.isFile() || fileStat.size > DESIGN_SOURCE_MAX_BYTES) {
    throw new Error(`Design source is not a readable HTML file: ${path}`);
  }
  // Bugfix（!3450 CR-01）：以前按 "utf-8" 直接解码，GBK 等非 UTF-8 文件的非法字节变成 U+FFFD，
  // 改一个数值写回就把全文非 ASCII 字符永久替换（撤销栈里的写前内容也已损坏）。
  // 改成严格解码：不能无损往返的文件直接报错，前端按读不了处理、不写回。
  const bytes = await readFile(path);
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(`Design source is not valid UTF-8: ${path}`);
  }
}

export function createFileService(options: CreateFileServiceOptions = {}): IFileService {
  const workspaceFileSearchFilter =
    options.workspaceFileSearchFilter ?? defaultWorkspaceFileSearchFilter;
  const workspaceIgnoreLogger = createServiceLogger("workspace-file-ignore");
  const fileExistenceCache = new FileExistenceCache();
  // 索引归服务实例；不同 Host/注入过滤器不能通过模块全局缓存复用同路径结果。
  const workspaceFileListCache = new Map<string, WorkspaceFileIndex>();
  const pendingFileExistenceChecks = new Map<string, Promise<boolean>>();

  const checkFileExists = async (path: string): Promise<boolean> => {
    const cached = fileExistenceCache.get(path);
    if (cached !== undefined) {
      return cached;
    }

    const pending = pendingFileExistenceChecks.get(path);
    if (pending) {
      return pending;
    }

    const check = stat(path)
      .then((fileStat) => fileStat.isFile())
      .catch(() => false)
      .then((exists) => {
        // 正负结果都缓存：assistant 自然语言经常重复提到同一缺失路径，避免远程 Host
        // 在一分钟内为同一候选重复发起 SSH stat。
        fileExistenceCache.set(path, exists);
        return exists;
      })
      .finally(() => {
        pendingFileExistenceChecks.delete(path);
      });
    pendingFileExistenceChecks.set(path, check);
    return check;
  };

  // 全量扫描 + 打包（带 60s TTL / .zcodeignore 指纹缓存）。分块 RPC 共享同一份 packed。
  const workspaceFileListScanning = new Map<
    string,
    { signature: string; promise: Promise<WorkspaceFileIndex> }
  >();
  const ensureWorkspaceFileIndex = async (
    rootPath: string,
    workspaceIdentity?: string,
    refresh = false,
  ): Promise<WorkspaceFileIndex> => {
    const workspaceKey = workspaceIdentity?.trim() || rootPath;
    const ignoreRules = await loadWorkspaceFileSearchIgnoreRules(rootPath, workspaceIgnoreLogger);
    const cacheSignature = `${rootPath}\n${await statWorkspaceFileSearchIgnoreFingerprint(rootPath)}`;
    for (const [key, value] of workspaceFileListCache) {
      if (Date.now() - value.at >= WORKSPACE_FILE_LIST_CACHE_TTL_MS)
        workspaceFileListCache.delete(key);
    }
    const inFlight = workspaceFileListScanning.get(workspaceKey);
    // 刷新中的同作用域查询等待新索引，不能先命中旧缓存而遗漏刚创建的文件。
    if (!refresh && inFlight?.signature === cacheSignature) return inFlight.promise;
    const cached = workspaceFileListCache.get(workspaceKey);
    if (!refresh && cached?.signature === cacheSignature) {
      workspaceFileListCache.delete(workspaceKey);
      workspaceFileListCache.set(workspaceKey, cached);
      return cached;
    }
    const scanning = (async () => {
      const entries: WorkspaceFileEntry[] = [];
      const pendingDirectories: string[] = [rootPath];
      // 单线程串行 DFS 一次只 await 一个 readdir，
      // 37 万文件的 Windows workspace 实测 21.8s；改为共享目录队列的受限并发遍历，
      // 结果仍按既有规则排序，遍历顺序不影响语义。
      const traverseWorker = async (): Promise<void> => {
        for (;;) {
          const currentPath = pendingDirectories.pop();
          if (!currentPath) {
            return;
          }
          let children: Dirent[];
          try {
            children = await readdir(currentPath, { withFileTypes: true });
          } catch (error) {
            if (isSkippableWorkspaceFileListError(error)) {
              continue;
            }
            throw error;
          }
          for (const entry of children) {
            const entryPath = join(currentPath, entry.name);
            const relativePath = normalizeRelativePath(rootPath, entryPath);
            if (relativePath === WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME) {
              continue;
            }
            const type = await resolveReaddirEntryType(
              entryPath,
              entry.isDirectory(),
              entry.isSymbolicLink(),
            );
            if (isWorkspaceFileSearchPathIgnored(ignoreRules, relativePath, type)) {
              continue;
            }
            const decision = workspaceFileSearchFilter.evaluate(
              { name: entry.name, path: entryPath, relativePath, type },
              { ignoreRulesActive: true },
            );
            if (decision.include) {
              entries.push({ name: entry.name, path: entryPath, relativePath, type });
            }
            if (type === "directory" && !entry.isSymbolicLink() && decision.traverse) {
              pendingDirectories.push(entryPath);
            }
          }
        }
      };
      await Promise.all(
        Array.from({ length: WORKSPACE_FILE_LIST_SCAN_CONCURRENCY }, () => traverseWorker()),
      );
      const sorted = entries.sort((left, right) => {
        if (left.type !== right.type) {
          return left.type === "directory" ? -1 : 1;
        }
        return left.relativePath.localeCompare(right.relativePath);
      });
      const packed = packWorkspaceFileEntries(sorted);
      return { at: Date.now(), signature: cacheSignature, packed };
    })();
    workspaceFileListScanning.set(workspaceKey, { signature: cacheSignature, promise: scanning });
    try {
      const index = await scanning;
      // 显式刷新/规则变化可替换在途扫描，旧扫描完成时只服务旧请求，不覆盖新索引。
      if (workspaceFileListScanning.get(workspaceKey)?.promise === scanning) {
        workspaceFileListCache.delete(workspaceKey);
        workspaceFileListCache.set(workspaceKey, index);
        while (workspaceFileListCache.size > WORKSPACE_FILE_LIST_CACHE_MAX_ENTRIES) {
          const oldest = workspaceFileListCache.keys().next().value;
          if (oldest === undefined) break;
          workspaceFileListCache.delete(oldest);
        }
      }
      return index;
    } finally {
      if (workspaceFileListScanning.get(workspaceKey)?.promise === scanning)
        workspaceFileListScanning.delete(workspaceKey);
    }
  };

  return {
    async readdir(params: { path: string; includeHidden?: boolean }): Promise<FileEntry[]> {
      const entries = await readDirectoryEntries(params.path);
      const visibleEntries = await Promise.all(
        entries
          .filter((e) => {
            // 修复：workspace 文件树需要展示 .gitignore/.env/.github 等项目文件，
            // 但目录选择器等旧调用仍应默认隐藏 dotfiles，避免突然增加噪音。
            return params.includeHidden === true || !e.name.startsWith(".");
          })
          .map(async (e) => {
            const entryPath = join(params.path, e.name);
            return {
              name: e.name,
              path: entryPath,
              type: await resolveReaddirEntryType(entryPath, e.isDirectory(), e.isSymbolicLink()),
              isSymbolicLink: e.isSymbolicLink(),
            };
          }),
      );
      return visibleEntries.sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    },
    async stat(params: { path: string }) {
      const fileStat = await stat(params.path);
      // markdown 链接点击时需要区分文件和目录。
      // 之前统一当文件打开，目录会落到 CodeViewer 里读文件失败；这里把判断收口到服务层，
      // UI 只根据结构化结果分流到预览或临时文件树。
      const isDirectory = fileStat.isDirectory();
      return {
        path: params.path,
        type: isDirectory ? ("directory" as const) : ("file" as const),
        // 目录的 size 无意义，只对文件返回，供预览层决定二进制文件的加载策略
        ...(isDirectory ? {} : { size: fileStat.size, mtimeMs: fileStat.mtimeMs }),
      };
    },
    async checkFilesExist(params: {
      paths: string[];
    }): Promise<Array<{ path: string; exists: boolean }>> {
      if (params.paths.length > FILE_EXISTENCE_BATCH_LIMIT) {
        throw new Error(
          `File existence check supports at most ${FILE_EXISTENCE_BATCH_LIMIT} paths.`,
        );
      }

      // 调用方已按正文逆序选出候选；Promise.all 保持输入顺序，并把单批并发硬限制在 15。
      return Promise.all(
        params.paths.map(async (path) => ({
          path,
          exists: await checkFileExists(path),
        })),
      );
    },
    async resolvePath(params: { path: string }): Promise<string> {
      // 远程 workspace 可能通过符号链接别名输入（/dev vs /home/dev）。
      // 这里统一走 realpath，供上层做稳定身份计算，避免同目录被识别成两个 workspace。
      return realpath(params.path);
    },
    async createDefaultWorkspace(): Promise<{ path: string }> {
      const workspacePath = join(homedir(), SCRATCH_WORKSPACE_ROOT_NAME);
      await mkdir(workspacePath, { recursive: true });
      const workspaceStat = await stat(workspacePath);
      if (!workspaceStat.isDirectory()) {
        throw new Error(`Workspace path is not a directory: ${workspacePath}`);
      }
      return { path: workspacePath };
    },
    async ensureConversationWorkspace() {
      const workspacePath = getConversationWorkspaceDir();
      let created = false;
      try {
        created = (await mkdir(workspacePath, { recursive: true })) !== undefined;
      } catch (error) {
        const workspaceStat = await stat(workspacePath).catch(() => null);
        if (!workspaceStat) {
          throw error;
        }
        if (!workspaceStat.isDirectory()) {
          throw new Error(`Workspace path is not a directory: ${workspacePath}`, {
            cause: error,
          });
        }
      }
      const workspaceStat = await stat(workspacePath);
      if (!workspaceStat.isDirectory()) {
        throw new Error(`Workspace path is not a directory: ${workspacePath}`);
      }
      return {
        path: workspacePath,
        created,
        workspacePurpose: "conversation" as const,
      };
    },
    async createScratchWorkspace(params: { name: string }): Promise<{ path: string }> {
      const workspaceName = validateScratchWorkspaceName(params.name);
      const workspacePath = join(homedir(), SCRATCH_WORKSPACE_ROOT_NAME, workspaceName);
      await mkdir(workspacePath, { recursive: true });
      const workspaceStat = await stat(workspacePath);
      if (!workspaceStat.isDirectory()) {
        throw new Error(`Workspace path is not a directory: ${workspacePath}`);
      }
      // Start from scratch 必须通过 service 层创建空目录，UI 只提交名称。
      // 这里仅确保目录存在，不初始化 git、不写模板文件；mkdir recursive 让已存在目录幂等成功。
      return { path: workspacePath };
    },
    async readTextFile(params: {
      path: string;
      offset?: number;
      length?: number;
    }): Promise<FileTextSlice> {
      const fileStat = await stat(params.path);
      if (!fileStat.isFile()) {
        throw new Error(`Path is not a file: ${params.path}`);
      }
      const offset = Math.max(0, Math.trunc(params.offset ?? 0));
      if (offset >= fileStat.size) {
        return {
          path: params.path,
          content: "",
          offset,
          bytesRead: 0,
          totalBytes: fileStat.size,
          truncated: false,
          isBinary: false,
        };
      }
      const targetLength = clampReadLength(params.length);
      const remainingBytes = fileStat.size - offset;
      const readLength = Math.min(targetLength, remainingBytes);
      const handle = await open(params.path, "r");
      try {
        const buffer = Buffer.allocUnsafe(readLength);
        const { bytesRead } = await handle.read(buffer, 0, readLength, offset);
        const chunk = buffer.subarray(0, bytesRead);
        const isBinary = isProbablyBinary(chunk);
        // 性能说明：文本读取始终受 256KB 硬上限约束，调用方可据 truncated 决定是否展示，
        // 避免大文件或远程文件一次性 readFile 把 utility process 和 renderer 一起拖慢。
        return {
          path: params.path,
          content: isBinary ? "" : chunk.toString("utf-8"),
          offset,
          bytesRead,
          totalBytes: fileStat.size,
          truncated: offset + bytesRead < fileStat.size,
          isBinary,
        };
      } finally {
        await handle.close();
      }
    },
    async readFileRange(params: {
      path: string;
      offset: number;
      length: number;
    }): Promise<Uint8Array> {
      const fileStat = await stat(params.path);
      if (!fileStat.isFile()) {
        throw new Error(`Path is not a file: ${params.path}`);
      }
      const offset = Math.max(0, Math.trunc(params.offset));
      if (offset >= fileStat.size) {
        return new Uint8Array(0);
      }
      const targetLength = clampBinaryReadLength(params.length);
      const readLength = Math.min(targetLength, fileStat.size - offset);
      const handle = await open(params.path, "r");
      try {
        const buffer = Buffer.allocUnsafe(readLength);
        const { bytesRead } = await handle.read(buffer, 0, readLength, offset);
        // 返回顶层 Uint8Array：RPC 序列化只有顶层二进制走原始字节通道，
        // 包成对象字段会退化成 JSON+base64，大文件分段加载的体积收益就没了。
        // 这里拷贝成独立 buffer，避免 allocUnsafe 共享池的无关字节被一起克隆出去。
        return new Uint8Array(buffer.subarray(0, bytesRead));
      } finally {
        await handle.close();
      }
    },
    async readMediaPreview(params: { path: string; maxBytes?: number }): Promise<FileMediaPreview> {
      const fileStat = await stat(params.path);
      if (!fileStat.isFile()) {
        throw new Error(`Path is not a file: ${params.path}`);
      }
      const maxBytes = clampMediaPreviewBytes(params.maxBytes);
      if (fileStat.size > maxBytes) {
        throw new Error(`File is too large to preview: ${params.path}`);
      }
      // 媒体预览继续通过 service 抽象兼容 desktop / web / remote，而不是在 UI 层直接碰文件系统。
      const content = await readFile(params.path);
      return {
        path: params.path,
        mediaType: inferMediaTypeFromPath(params.path),
        dataBase64: content.toString("base64"),
        totalBytes: fileStat.size,
      };
    },
    async readBinaryPreview(params: {
      path: string;
      maxBytes?: number;
    }): Promise<FileBinaryPreview> {
      const fileStat = await stat(params.path);
      if (!fileStat.isFile()) {
        throw new Error(`Path is not a file: ${params.path}`);
      }
      const maxBytes = clampBinaryPreviewBytes(params.maxBytes);
      if (fileStat.size > maxBytes) {
        throw new Error(`File is too large to preview: ${params.path}`);
      }
      // Office 解析器需要完整的 ZIP / OLE 字节，不能复用文本分块读取。
      // 这里在 service 层先做 25 MB 硬上限，再以 base64 跨 RPC 返回，
      // 保持 desktop、Web 和远程 workspace 使用同一文件读取边界。
      const content = await readFile(params.path);
      return {
        path: params.path,
        dataBase64: content.toString("base64"),
        totalBytes: fileStat.size,
      };
    },
    async searchWorkspaceFiles(params: WorkspaceFileSearchParams): Promise<WorkspaceFileEntry[]> {
      const requestedLimit = params.limit ?? WORKSPACE_FILE_SEARCH_DISPLAY_CAP;
      if (!Number.isFinite(requestedLimit) || typeof params.query !== "string") {
        throw new Error("Invalid workspace file search query or limit");
      }
      const limit = Math.min(
        WORKSPACE_FILE_SEARCH_DISPLAY_CAP,
        Math.max(0, Math.trunc(requestedLimit)),
      );
      if (limit === 0) return [];
      const index = await ensureWorkspaceFileIndex(
        params.rootPath,
        params.workspaceIdentity,
        params.refresh,
      );
      index.candidates ??= buildHostFileSearchCandidates(index.packed, params.rootPath);
      return searchHostFileCandidates(await index.candidates, params.query, limit);
    },
    async listWorkspaceFilesLength(params: { rootPath: string }): Promise<number> {
      const { packed } = await ensureWorkspaceFileIndex(params.rootPath);
      return packed.length;
    },
    async listWorkspaceFilesRange(params: {
      rootPath: string;
      offset: number;
      length: number;
    }): Promise<string> {
      const { packed } = await ensureWorkspaceFileIndex(params.rootPath);
      const offset = Math.max(0, Math.trunc(params.offset));
      if (offset >= packed.length) {
        return "";
      }
      const length = Math.max(0, Math.trunc(params.length));
      return packed.slice(offset, Math.min(packed.length, offset + length));
    },
    async readWorkspaceFileSearchIgnore(params: {
      rootPath: string;
    }): Promise<{ content: string; source: "file" | "template" }> {
      return readWorkspaceFileSearchIgnore(params.rootPath);
    },
    async applyWorkspaceFileSearchIgnoreTransform(params: {
      rootPath: string;
      transform: "sync-gitignore" | "reset-defaults";
    }): Promise<{ content: string }> {
      return transformWorkspaceFileSearchIgnore(params.rootPath, params.transform);
    },
    async readDesignSourceFile(params: { path: string }): Promise<{ content: string }> {
      return { content: await readDesignSource(params.path) };
    },
    async writeDesignSourceFile(params: {
      path: string;
      expectedContent: string;
      content: string;
    }): Promise<{ written: boolean }> {
      // Bugfix（!3450 CR-02）：以前「读、比较、写」是分开的两步，两个 tab 同时提交时都能通过比较，后写的覆盖先写的。
      // 现在按文件串行：后进来的在前一个写完后才比较，内容已变就返回 changed。设计工具之外的写入者（Agent、编辑器）
      // 不经过这里，仍只靠内容比较兜底，窗口限于这一次读写之间。
      return withDesignSourceLock(params.path, async () => {
        if ((await readDesignSource(params.path)) !== params.expectedContent) {
          return { written: false };
        }
        await writeFile(params.path, params.content, "utf-8");
        return { written: true };
      });
    },
    async writeWorkspaceFileSearchIgnore(params: {
      rootPath: string;
      content: string;
    }): Promise<void> {
      await writeWorkspaceFileSearchIgnore(params.rootPath, params.content);
    },
  };
}
