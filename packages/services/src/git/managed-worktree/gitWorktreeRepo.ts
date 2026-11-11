// 受管 worktree 的 Git 操作（docs/git/worktree.md §3.4、§6.3、§6.5）。
// 唯一事实源是 `git worktree list --porcelain` + 受管目录布局；本模块不缓存、不持久化任何副本。
// gitCliRepo 已超出行数上限，worktree 能力独立成模块，只复用同一个 GitCommandProvider。
import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { copyFile, lstat, mkdir, realpath, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import type {
  CreateManagedWorktreeRequest,
  CreateManagedWorktreeResult,
  ListManagedWorktreesRequest,
  ListManagedWorktreesResult,
  ManagedWorktreeErrorCode,
  ManagedWorktreeInfo,
  ManagedWorktreeStartRefs,
  PruneWorktreesRequest,
  RemoveManagedWorktreeRequest,
  RemoveManagedWorktreeResult,
} from "@zcode/shared";
import {
  MANAGED_WORKTREE_SPOTLIGHT_MARKER,
  isSamePath,
  managedWorktreeDirectoryName,
  parseManagedWorktreePath,
  resolveManagedWorktreeRoot,
} from "@zcode/shared/managed-worktree";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import {
  DEFAULT_GIT_COMMAND_TIMEOUT_MS,
  DEFAULT_GIT_OUTPUT_BYTES,
  normalizeGitPath,
} from "../config.js";
import type {
  GitCommandExecutionResult,
  GitCommandProvider,
} from "../providers/gitCommandProvider.js";
import type { GitWorktreeCreateOptions, GitWorktreeRepo } from "./contract.js";

const log = createServiceLogger("git-worktree");

/** `git worktree add` 是一次完整 checkout，大仓库可能需要几十秒；普通 15s 超时会误判失败。 */
const WORKTREE_ADD_TIMEOUT_MS = 10 * 60_000;
/** `git worktree remove` 需要删除整棵目录树（含被忽略的依赖目录）。 */
const WORKTREE_REMOVE_TIMEOUT_MS = 5 * 60_000;
/** bucket 冲突时的最大重试次数；4 位 hex 共 65536 个，正常远小于这个次数就能命中空位。 */
const MAX_BUCKET_ATTEMPTS = 64;
const BUCKET_BYTES = 2;
const STDERR_DETAIL_LIMIT = 2_000;
const GIT_DIRNAME = ".git";
const HEAD_REF = "HEAD";
/** 源仓库根目录中声明"新 worktree 需要拷贝哪些被忽略文件"的清单（§3.4）。 */
export const WORKTREE_INCLUDE_FILE = ".worktreeinclude";
/** 清单可能展开到很多文件；列举命令单独放宽输出与超时，避免默认 512KB 截断。 */
const FILE_LIST_OUTPUT_BYTES = 32 * 1024 * 1024;
const FILE_LIST_TIMEOUT_MS = 2 * 60_000;
/** check-ignore 按参数批量传入候选路径，控制单条命令行长度（Windows 命令行上限约 32K）。 */
const CHECK_IGNORE_BATCH = 100;
const COPY_CONCURRENCY = 16;
/** 写时复制优先（APFS / btrfs / xfs），不支持时由 Node 退回普通拷贝；EXCL 保证不覆盖已有文件。 */
const COPY_MODE = fsConstants.COPYFILE_EXCL | fsConstants.COPYFILE_FICLONE;
/** fork 带入改动时的临时补丁文件，写在 bucket 中（worktree 之外），应用后删除。 */
const CARRY_STAGED_PATCH = ".zcode-carry-staged.patch";
const CARRY_UNSTAGED_PATCH = ".zcode-carry-unstaged.patch";

class WorktreeCopyError extends Error {
  constructor(
    readonly relativePath: string,
    cause: unknown,
  ) {
    super(`${relativePath}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

interface SourceRepository {
  /** sourcePath 所在 checkout 的 toplevel（执行 worktree add 的位置）。 */
  checkoutRoot: string;
  /** 主仓库 toplevel（common dir 的父目录）。 */
  sourceRoot: string;
  /** sourcePath 相对 checkoutRoot 的路径，用于计算 worktree 中的任务 cwd。 */
  relativeCwd: string;
}

interface PorcelainWorktree {
  path: string;
  head: string | null;
  branchName: string | null;
  prunable: boolean;
  bare: boolean;
}

function failure(code: ManagedWorktreeErrorCode, detail?: string) {
  return { ok: false as const, error: { code, ...(detail ? { detail } : {}) } };
}

function stderrDetail(result: GitCommandExecutionResult): string {
  return (result.stderr || result.stdout).trim().slice(0, STDERR_DETAIL_LIMIT);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function realpathOr(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/** 解析 `git worktree list --porcelain -z`：字段以 NUL 分隔，记录之间多一个空字段。 */
export function parseWorktreeListPorcelain(output: string): PorcelainWorktree[] {
  const records: PorcelainWorktree[] = [];
  let current: PorcelainWorktree | null = null;
  for (const field of output.split("\0")) {
    if (field === "") {
      if (current) records.push(current);
      current = null;
      continue;
    }
    const spaceIndex = field.indexOf(" ");
    const key = spaceIndex < 0 ? field : field.slice(0, spaceIndex);
    const value = spaceIndex < 0 ? "" : field.slice(spaceIndex + 1);
    if (key === "worktree") {
      if (current) records.push(current);
      current = { path: value, head: null, branchName: null, prunable: false, bare: false };
      continue;
    }
    if (!current) continue;
    if (key === "HEAD") current.head = value || null;
    else if (key === "branch") current.branchName = value.replace(/^refs\/heads\//, "");
    else if (key === "prunable") current.prunable = true;
    else if (key === "bare") current.bare = true;
  }
  if (current) records.push(current);
  return records;
}

export function createGitWorktreeRepo(options: {
  commandProvider: GitCommandProvider;
  /** 数据根目录（与 CLI 一致：ZCODE_DATA_BASE_DIR 优先，否则 homedir）。 */
  dataBaseDir: () => string;
  platform?: NodeJS.Platform;
}): GitWorktreeRepo {
  const { commandProvider } = options;
  const platform = options.platform ?? process.platform;

  function run(
    cwd: string,
    args: string[],
    timeoutMs = DEFAULT_GIT_COMMAND_TIMEOUT_MS,
    extra: { maxOutputBytes?: number; onOutput?: (text: string) => void } = {},
  ) {
    return commandProvider.run({
      cwd,
      args,
      timeoutMs,
      maxOutputBytes: extra.maxOutputBytes ?? DEFAULT_GIT_OUTPUT_BYTES,
      ...(extra.onOutput ? { onOutput: ({ text }) => extra.onOutput?.(text) } : {}),
    });
  }

  /**
   * 计算需要拷贝的相对路径：被 .worktreeinclude 匹配、未跟踪，并且被仓库标准规则忽略。
   * 先用清单取候选（通常很少），再用 check-ignore 过滤，不列举仓库里全部被忽略的文件。
   */
  async function listIncludedIgnoredFiles(sourceRoot: string): Promise<string[]> {
    if (!(await pathExists(join(sourceRoot, WORKTREE_INCLUDE_FILE)))) return [];
    const candidates = await run(
      sourceRoot,
      ["ls-files", "--others", "--ignored", `--exclude-from=${WORKTREE_INCLUDE_FILE}`, "-z"],
      FILE_LIST_TIMEOUT_MS,
      { maxOutputBytes: FILE_LIST_OUTPUT_BYTES },
    );
    if (candidates.exitCode !== 0 || candidates.outputTruncated)
      throw new WorktreeCopyError(WORKTREE_INCLUDE_FILE, stderrDetail(candidates));
    const paths = candidates.stdout.split("\0").filter(Boolean);
    const ignored: string[] = [];
    for (let index = 0; index < paths.length; index += CHECK_IGNORE_BATCH) {
      const batch = paths.slice(index, index + CHECK_IGNORE_BATCH);
      const checked = await run(sourceRoot, ["check-ignore", "-z", "--", ...batch]);
      // exit 1 = 这一批都没有被忽略；其他非 0 是真实错误。
      if (checked.exitCode === 1) continue;
      if (checked.exitCode !== 0)
        throw new WorktreeCopyError(WORKTREE_INCLUDE_FILE, stderrDetail(checked));
      ignored.push(...checked.stdout.split("\0").filter(Boolean));
    }
    return ignored;
  }

  /** 目标路径的任一父目录是符号链接时拒绝，防止写到 worktree 之外。 */
  async function assertNoSymlinkParent(worktreeRoot: string, relativePath: string): Promise<void> {
    let current = worktreeRoot;
    for (const segment of dirname(relativePath)
      .split(/[\\/]/)
      .filter((part) => part && part !== ".")) {
      current = join(current, segment);
      const info = await lstat(current).catch(() => null);
      if (!info) return;
      if (info.isSymbolicLink()) throw new Error("path passes through a symbolic link");
    }
  }

  async function copyOne(sourceRoot: string, worktreeRoot: string, relativePath: string) {
    const from = join(sourceRoot, relativePath);
    // lstat：符号链接本身不跟随，直接跳过；只拷贝普通文件。
    const info = await lstat(from).catch(() => null);
    if (!info?.isFile()) return false;
    try {
      await assertNoSymlinkParent(worktreeRoot, relativePath);
      const to = join(worktreeRoot, relativePath);
      await mkdir(dirname(to), { recursive: true });
      await copyFile(from, to, COPY_MODE);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw new WorktreeCopyError(relativePath, error);
    }
  }

  async function copyIncludedFiles(sourceRoot: string, worktreeRoot: string): Promise<number> {
    const paths = await listIncludedIgnoredFiles(sourceRoot);
    let copied = 0;
    let next = 0;
    const worker = async () => {
      while (next < paths.length) {
        const relativePath = paths[next++]!;
        if (await copyOne(sourceRoot, worktreeRoot, relativePath)) copied += 1;
      }
    };
    await Promise.all(Array.from({ length: Math.min(COPY_CONCURRENCY, paths.length) }, worker));
    return copied;
  }

  /**
   * 读取 fork 要带入的改动（§3.6）。只执行只读命令，不改动父目录；以 commit 为基准，
   * 保证在以同一 commit 检出的 worktree 中应用时不会冲突。
   */
  async function readCarriedChanges(checkoutRoot: string, commit: string) {
    const read = async (args: string[]) => {
      const result = await run(checkoutRoot, args, FILE_LIST_TIMEOUT_MS, {
        maxOutputBytes: FILE_LIST_OUTPUT_BYTES,
      });
      if (result.exitCode !== 0 || result.outputTruncated)
        throw new Error(`git ${args[0]} failed: ${stderrDetail(result) || "output too large"}`);
      return result.stdout;
    };
    const staged = await read(["diff", "--cached", "--binary", commit]);
    const unstaged = await read(["diff", "--binary"]);
    const changed = new Set([
      ...(await read(["diff", "--cached", "--name-only", "-z", commit])).split("\0"),
      ...(await read(["diff", "--name-only", "-z"])).split("\0"),
    ]);
    const untracked = (await read(["ls-files", "--others", "--exclude-standard", "-z"]))
      .split("\0")
      .filter(Boolean);
    for (const path of untracked) changed.add(path);
    changed.delete("");
    return { staged, unstaged, untracked, count: changed.size };
  }

  /** 在新 worktree 中按暂存区划分应用补丁，并复制未跟踪文件；补丁文件放在 bucket 中、worktree 之外。 */
  async function applyCarriedChanges(
    checkoutRoot: string,
    bucketDir: string,
    worktreeRoot: string,
    changes: Awaited<ReturnType<typeof readCarriedChanges>>,
  ) {
    const apply = async (name: string, patch: string, args: string[]) => {
      if (!patch) return;
      const file = join(bucketDir, name);
      await writeFile(file, patch);
      try {
        const applied = await run(worktreeRoot, ["apply", ...args, "--binary", file]);
        if (applied.exitCode !== 0)
          throw new Error(`git apply failed: ${stderrDetail(applied) || applied.exitCode}`);
      } finally {
        await rm(file, { force: true });
      }
    };
    await apply(CARRY_STAGED_PATCH, changes.staged, ["--index"]);
    await apply(CARRY_UNSTAGED_PATCH, changes.unstaged, []);
    for (const path of changes.untracked) await copyOne(checkoutRoot, worktreeRoot, path);
  }

  /** 回滚本次创建：登记过的 worktree 强制移除，再删 bucket 并 prune 半成品登记。 */
  async function rollback(sourceRoot: string, bucketDir: string, worktreeRoot: string) {
    await run(
      sourceRoot,
      ["worktree", "remove", "--force", worktreeRoot],
      WORKTREE_REMOVE_TIMEOUT_MS,
    );
    await rm(bucketDir, { recursive: true, force: true });
    await run(sourceRoot, ["worktree", "prune"]);
  }

  function managedRoot(): string {
    return resolveManagedWorktreeRoot(options.dataBaseDir());
  }

  async function resolveSourceRepository(sourcePath: string): Promise<SourceRepository | null> {
    const realSource = await realpathOr(sourcePath);
    const result = await run(realSource, [
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "--git-common-dir",
    ]);
    if (result.exitCode !== 0) return null;
    const [toplevel, commonDir] = result.stdout.split(/\r?\n/).filter(Boolean);
    if (!toplevel || !commonDir) return null;
    const checkoutRoot = await realpathOr(toplevel);
    const realCommon = await realpathOr(commonDir);
    // 只支持普通仓库（common dir = <toplevel>/.git）；bare 仓库没有可作为源的工作区。
    if (basename(realCommon) !== GIT_DIRNAME) return null;
    return {
      checkoutRoot,
      sourceRoot: dirname(realCommon),
      relativeCwd: relative(checkoutRoot, realSource),
    };
  }

  async function listPorcelain(sourceRoot: string): Promise<PorcelainWorktree[] | null> {
    const result = await run(sourceRoot, ["worktree", "list", "--porcelain", "-z"]);
    if (result.exitCode !== 0) return null;
    return parseWorktreeListPorcelain(result.stdout);
  }

  async function toManagedInfo(
    record: PorcelainWorktree,
    sourceRoot: string,
    realManagedRoot: string,
  ): Promise<ManagedWorktreeInfo | null> {
    if (record.bare) return null;
    const exists = !record.prunable && (await pathExists(record.path));
    const candidate = exists ? await realpathOr(record.path) : record.path;
    const parts = parseManagedWorktreePath(realManagedRoot, candidate);
    // 只认 <root>/<bucket>/<name> 根本身；用户自建 worktree 或更深的路径都不是受管条目。
    if (!parts || parts.relativePath !== "") return null;
    if (exists) {
      const dotGit = await stat(join(candidate, GIT_DIRNAME)).catch(() => null);
      if (!dotGit?.isFile()) return null;
    }
    return {
      path: candidate,
      bucket: parts.bucket,
      sourceRoot,
      head: exists ? record.head : null,
      branchName: exists ? record.branchName : null,
      state: exists ? "ok" : "missing",
      dirty: exists ? await isDirty(candidate) : null,
    };
  }

  /** 与删除预检同一判定：有修改或未跟踪文件即为 dirty；读取失败按 null（未知）处理。 */
  async function isDirty(worktreeRoot: string): Promise<boolean | null> {
    const status = await run(worktreeRoot, [
      "status",
      "--porcelain",
      "-z",
      "--untracked-files=normal",
    ]);
    return status.exitCode === 0 ? status.stdout.length > 0 : null;
  }

  async function list(request: ListManagedWorktreesRequest): Promise<ListManagedWorktreesResult> {
    const source = await resolveSourceRepository(request.sourcePath);
    if (!source) return { sourceRoot: null, worktrees: [] };
    const root = managedRoot();
    if (!(await pathExists(root))) return { sourceRoot: source.sourceRoot, worktrees: [] };
    const realManagedRoot = await realpathOr(root);
    const records = (await listPorcelain(source.sourceRoot)) ?? [];
    const worktrees: ManagedWorktreeInfo[] = [];
    for (const record of records) {
      const info = await toManagedInfo(record, source.sourceRoot, realManagedRoot);
      if (info) worktrees.push(info);
    }
    return { sourceRoot: source.sourceRoot, worktrees };
  }

  async function ensureManagedRoot(): Promise<string> {
    const root = managedRoot();
    await mkdir(root, { recursive: true });
    if (platform === "darwin") {
      const marker = join(root, MANAGED_WORKTREE_SPOTLIGHT_MARKER);
      if (!(await pathExists(marker))) await writeFile(marker, "");
    }
    return await realpath(root);
  }

  /** 非递归 mkdir 原子占用 bucket；EEXIST 时重新随机，保证并发创建得到不同目录。 */
  async function allocateBucket(realManagedRoot: string): Promise<string | null> {
    for (let attempt = 0; attempt < MAX_BUCKET_ATTEMPTS; attempt += 1) {
      const bucketDir = join(realManagedRoot, randomBytes(BUCKET_BYTES).toString("hex"));
      try {
        await mkdir(bucketDir);
        return bucketDir;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    return null;
  }

  async function create(
    request: CreateManagedWorktreeRequest,
    createOptions: GitWorktreeCreateOptions = {},
  ): Promise<CreateManagedWorktreeResult> {
    const emit = (text: string) => createOptions.onOutput?.(text);
    emit("[info] Starting worktree creation\n");
    const source = await resolveSourceRepository(request.sourcePath);
    if (!source) return failure("not-repository");

    if (request.carryChanges && request.startRef?.trim()) return failure("invalid-start-ref");
    const startRef = request.startRef?.trim() || HEAD_REF;
    const resolved = await run(source.checkoutRoot, [
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      `${startRef}^{commit}`,
    ]);
    const commit = resolved.stdout.trim();
    if (resolved.exitCode !== 0 || !commit) return failure("invalid-start-ref", startRef);

    if (source.relativeCwd) {
      // 项目主目录是仓库子目录时，起点 commit 中必须存在该子目录，否则任务 cwd 无从建立。
      const treePath = `${commit}:${normalizeGitPath(source.relativeCwd.split(sep).join("/"))}`;
      const kind = await run(source.checkoutRoot, ["cat-file", "-t", treePath]);
      if (kind.exitCode !== 0 || kind.stdout.trim() !== "tree") {
        return failure("start-ref-missing-subdir", source.relativeCwd);
      }
    }

    // 带入改动的快照在检出前读取：之后父任务的改动不带入（§3.6）。
    let carried: Awaited<ReturnType<typeof readCarriedChanges>> | null = null;
    if (request.carryChanges) {
      try {
        carried = await readCarriedChanges(source.checkoutRoot, commit);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        emit(`[error] Failed to read uncommitted changes: ${detail}\n`);
        return failure("carry-failed", detail);
      }
    }

    const realManagedRoot = await ensureManagedRoot();
    const bucketDir = await allocateBucket(realManagedRoot);
    if (!bucketDir) return failure("bucket-exhausted");
    const worktreeRoot = join(bucketDir, managedWorktreeDirectoryName(source.sourceRoot));
    createOptions.onPathAllocated?.(worktreeRoot);

    const added = await run(
      source.checkoutRoot,
      ["worktree", "add", "--detach", worktreeRoot, commit],
      WORKTREE_ADD_TIMEOUT_MS,
      { onOutput: emit },
    );
    if (added.exitCode !== 0 || added.timedOut) {
      // 回滚只针对本次占用的 bucket；随后 prune 清掉 git 里可能残留的半成品登记。
      await rm(bucketDir, { recursive: true, force: true });
      await run(source.sourceRoot, ["worktree", "prune"]);
      log.warn(
        undefined,
        `worktree add failed source=${source.sourceRoot} bucket=${basename(bucketDir)}`,
      );
      return failure("git-failed", stderrDetail(added));
    }

    const realWorktreeRoot = await realpath(worktreeRoot);
    emit(`Worktree created at ${realWorktreeRoot}\n`);
    if (carried) {
      try {
        await applyCarriedChanges(source.checkoutRoot, bucketDir, realWorktreeRoot, carried);
        emit(
          `Carried ${carried.count} changed file${carried.count === 1 ? "" : "s"} from ${source.checkoutRoot}\n`,
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        emit(`[error] Failed to carry uncommitted changes: ${detail}\n`);
        await rollback(source.sourceRoot, bucketDir, realWorktreeRoot);
        return failure("carry-failed", detail);
      }
    }
    try {
      // 拷贝来源始终是源仓库主 checkout（fork 时父任务可能在另一个 worktree 中）。
      const copied = await copyIncludedFiles(source.sourceRoot, realWorktreeRoot);
      if (copied > 0)
        emit(`Copied ${copied} file${copied === 1 ? "" : "s"} from ${WORKTREE_INCLUDE_FILE}\n`);
    } catch (error) {
      // 任一文件拷贝失败即整个创建失败：缺文件的 worktree 往往跑不起来，用户修复后可重试。
      const detail = error instanceof Error ? error.message : String(error);
      emit(`[error] Failed to copy ${detail}\n`);
      await rollback(source.sourceRoot, bucketDir, realWorktreeRoot);
      return failure("copy-failed", detail);
    }
    log.info(
      undefined,
      `managed worktree created source=${source.sourceRoot} path=${realWorktreeRoot}`,
    );
    return {
      ok: true,
      worktree: {
        path: realWorktreeRoot,
        bucket: basename(bucketDir),
        sourceRoot: source.sourceRoot,
        head: commit,
        branchName: null,
        state: "ok",
        dirty: false,
      },
      cwd: source.relativeCwd ? join(realWorktreeRoot, source.relativeCwd) : realWorktreeRoot,
    };
  }

  async function resolveManagedWorktree(
    path: string,
  ): Promise<{ worktreeRoot: string; sourceRoot: string } | null> {
    const root = managedRoot();
    if (!(await pathExists(root))) return null;
    const parts = parseManagedWorktreePath(await realpathOr(root), await realpathOr(path));
    if (!parts || !(await pathExists(parts.worktreeRoot))) return null;
    const source = await resolveSourceRepository(parts.worktreeRoot);
    if (!source || !isSamePath(source.checkoutRoot, parts.worktreeRoot)) return null;
    const records = (await listPorcelain(source.sourceRoot)) ?? [];
    const registered = await Promise.all(records.map((record) => realpathOr(record.path)));
    if (!registered.some((registeredPath) => isSamePath(registeredPath, parts.worktreeRoot))) {
      return null;
    }
    return { worktreeRoot: parts.worktreeRoot, sourceRoot: source.sourceRoot };
  }

  async function remove(
    request: RemoveManagedWorktreeRequest,
  ): Promise<RemoveManagedWorktreeResult> {
    const managed = await resolveManagedWorktree(request.path);
    if (!managed || !isSamePath(managed.worktreeRoot, await realpathOr(request.path))) {
      return failure("not-managed");
    }
    if (!request.force) {
      // 预检只为给出结构化原因；真正的保护仍是不带 --force 的 git worktree remove。
      const status = await run(managed.worktreeRoot, [
        "status",
        "--porcelain",
        "-z",
        "--untracked-files=normal",
      ]);
      if (status.exitCode !== 0) return failure("git-failed", stderrDetail(status));
      if (status.stdout.length > 0) return failure("worktree-dirty");
    }

    // force 只由编排层在"没有任务使用"时传入（§3.11），用于清理中断留下的残留。
    const removed = await run(
      managed.sourceRoot,
      ["worktree", "remove", ...(request.force ? ["--force"] : []), managed.worktreeRoot],
      WORKTREE_REMOVE_TIMEOUT_MS,
    );
    if (removed.exitCode !== 0 || removed.timedOut) {
      return failure("git-failed", stderrDetail(removed));
    }
    // bucket 只放一个 worktree；为空才删除，非空（例如 Windows 上删除未完成）保留现场。
    await rmdir(dirname(managed.worktreeRoot)).catch(() => undefined);
    log.info(
      undefined,
      `managed worktree removed source=${managed.sourceRoot} path=${managed.worktreeRoot}`,
    );
    return { ok: true };
  }

  async function prune(request: PruneWorktreesRequest): Promise<void> {
    const source = await resolveSourceRepository(request.sourcePath);
    if (!source) return;
    await run(source.sourceRoot, ["worktree", "prune"]);
  }

  async function listStartRefs(request: {
    sourcePath: string;
  }): Promise<ManagedWorktreeStartRefs | null> {
    const source = await resolveSourceRepository(request.sourcePath);
    if (!source) return null;
    // 起点从 sourcePath 所在 checkout 解析，与 create 使用的 checkoutRoot 保持一致。
    const [headResult, branchResult, refsResult] = await Promise.all([
      run(source.checkoutRoot, ["rev-parse", "--verify", "--quiet", "HEAD"]),
      run(source.checkoutRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
      run(source.checkoutRoot, [
        "for-each-ref",
        "--format=%(refname)",
        "refs/heads",
        "refs/remotes",
      ]),
    ]);
    const sha = headResult.exitCode === 0 ? headResult.stdout.trim() : "";
    const localBranches: string[] = [];
    const remoteBranches: string[] = [];
    for (const ref of refsResult.stdout.split(/\r?\n/).filter(Boolean)) {
      if (ref.startsWith("refs/heads/")) localBranches.push(ref.slice("refs/heads/".length));
      // <remote>/HEAD 是符号引用，不是可选的起点分支。
      else if (ref.startsWith("refs/remotes/") && !ref.endsWith("/HEAD"))
        remoteBranches.push(ref.slice("refs/remotes/".length));
    }
    return {
      head: sha
        ? {
            sha,
            branchName: branchResult.exitCode === 0 ? branchResult.stdout.trim() || null : null,
          }
        : null,
      localBranches,
      remoteBranches,
    };
  }

  return { list, create, remove, prune, resolveManagedWorktree, listStartRefs, isDirty };
}
