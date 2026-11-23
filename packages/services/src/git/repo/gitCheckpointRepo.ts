import { copyFile, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  GitCheckpointConflict,
  GitCheckpointDiff,
  GitCheckpointMeta,
  GitCheckpointRestoreResult,
} from "@zcode/shared";
import { getGitCheckpointIndexRootDir } from "../../paths.js";
import { toWorkspaceRelativeGitPath } from "../config.js";
import {
  createGitCommandProvider,
  type GitCommandProvider,
} from "../providers/gitCommandProvider.js";
import { createGitCliRepo, type GitCliRepo } from "./gitCliRepo.js";
import {
  buildAffectedRepoPaths,
  buildCheckpointEnv,
  getCheckpointRefName,
  getWorkspacePathspec,
  mergeCheckpointDiff,
  normalizeAffectedRepoPath,
  parseLsTree,
  parseNameStatus,
  parseNumstat,
  removeFileIfExists,
  toAbsolutePath,
} from "./gitCheckpointHelpers.js";
import { ensureGitCommandSucceeded } from "./gitCliHelpers.js";

interface GitCheckpointRepo {
  createCheckpoint(params: {
    workspacePath: string;
    checkpointId: string;
  }): Promise<GitCheckpointMeta>;
  diffCheckpoints(params: {
    workspacePath: string;
    from: GitCheckpointMeta;
    to: GitCheckpointMeta;
  }): Promise<GitCheckpointDiff>;
  restoreBetweenCheckpoints(params: {
    workspacePath: string;
    from: GitCheckpointMeta;
    to: GitCheckpointMeta;
    force?: boolean;
  }): Promise<GitCheckpointRestoreResult>;
  deleteCheckpoint(params: { workspacePath: string; checkpoint: GitCheckpointMeta }): Promise<void>;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

export function createGitCheckpointRepo(options?: {
  commandProvider?: GitCommandProvider;
  gitRepo?: Pick<GitCliRepo, "resolveRepository">;
}): GitCheckpointRepo {
  const commandProvider = options?.commandProvider ?? createGitCommandProvider();
  const gitRepo = options?.gitRepo ?? createGitCliRepo({ commandProvider });

  async function ensureRepository(
    workspacePath: string,
  ): Promise<Awaited<ReturnType<typeof gitRepo.resolveRepository>>> {
    // 所有 checkpoint 操作都必须建立在“当前 workspace 对应一个真实 Git 仓库”这个前提上。
    // 这里统一做仓库解析和能力前置校验，避免各个方法各自判断后出现错误语义不一致。
    const resolution = await gitRepo.resolveRepository(workspacePath);
    if (!resolution.isGitAvailable) {
      throw new Error("Git binary is not available in the current environment.");
    }
    if (!resolution.isRepository) {
      throw new Error("Workspace is not inside a Git repository.");
    }
    return resolution;
  }

  async function computeCheckpointDiff(params: {
    workspacePath: string;
    from: GitCheckpointMeta;
    to: GitCheckpointMeta;
  }): Promise<GitCheckpointDiff> {
    // checkpoint 之间的 diff 只针对当前 workspace scope 计算，而不是整仓库。
    // 这样 monorepo 子目录打开时，后续 restore / 摘要 / 冲突检测都会天然收敛在当前工作区边界内。
    const resolution = await ensureRepository(params.workspacePath);
    const pathspec = getWorkspacePathspec(resolution.workspaceInRepoPath);
    // 统计范围收束在 workspace pathspec 内；外部 diff 与 textconv 由 GitCommandProvider 统一禁用。
    const [nameStatusResult, numstatResult] = await Promise.all([
      commandProvider.run({
        cwd: resolution.repoRoot,
        args: [
          "diff",
          "--name-status",
          "--find-renames",
          "-z",
          params.from.commitOid,
          params.to.commitOid,
          "--",
          pathspec,
        ],
      }),
      commandProvider.run({
        cwd: resolution.repoRoot,
        args: [
          "diff",
          "--numstat",
          "--find-renames",
          "-z",
          params.from.commitOid,
          params.to.commitOid,
          "--",
          pathspec,
        ],
      }),
    ]);
    ensureGitCommandSucceeded("git diff --name-status checkpoint", nameStatusResult);
    ensureGitCommandSucceeded("git diff --numstat checkpoint", numstatResult);

    // name-status 决定“改了哪些文件、是什么类型的改动”，numstat 提供 added/removed 统计。
    // 两者拼起来，得到的是给上层使用的结构化 checkpoint diff，而不是原始 Git 文本输出。
    return mergeCheckpointDiff({
      repoRoot: resolution.repoRoot,
      workspaceInRepoPath: resolution.workspaceInRepoPath,
      fromCheckpointId: params.from.checkpointId,
      toCheckpointId: params.to.checkpointId,
      nameStatusEntries: parseNameStatus(nameStatusResult.stdout),
      numstat: parseNumstat(numstatResult.stdout),
    });
  }

  async function collectWorkspaceConflicts(params: {
    repoRoot: string;
    workspaceInRepoPath: string;
    from: GitCheckpointMeta;
    affectedRepoPaths: string[];
  }): Promise<GitCheckpointConflict[]> {
    if (params.affectedRepoPaths.length === 0) {
      return [];
    }

    // 冲突检测不是判断“整个工作区是否 dirty”，而是判断 restore 将触达的这些路径，
    // 当前磁盘状态是否仍然等于调用方声明的 fromCheckpoint。
    // 只有这样，底层能力才能在存在无关改动时依然安全工作，不会把整个仓库一刀切地判成不可恢复。
    const treeResult = await commandProvider.run({
      cwd: params.repoRoot,
      args: ["ls-tree", "-r", "-z", params.from.commitOid, "--", ...params.affectedRepoPaths],
    });
    ensureGitCommandSucceeded("git ls-tree checkpoint paths", treeResult);
    const treeEntries = parseLsTree(treeResult.stdout);

    const conflicts: GitCheckpointConflict[] = [];
    for (const repoRelativePath of params.affectedRepoPaths) {
      const absolutePath = toAbsolutePath(params.repoRoot, repoRelativePath);
      const expectedEntry = treeEntries.get(repoRelativePath);

      if (!expectedEntry) {
        // fromCheckpoint 里不存在该路径，说明按基线语义它本来就不该在磁盘上出现。
        // 如果现在却存在，就意味着用户或其它流程在 checkpoint 之后新增了该文件，属于覆盖风险。
        if (!(await pathExists(absolutePath))) {
          continue;
        }
        conflicts.push({
          path: absolutePath,
          repoRelativePath,
          workspaceRelativePath: toWorkspaceRelativeGitPath(
            repoRelativePath,
            params.workspaceInRepoPath,
          ),
          reason: "unexpected-file-in-worktree",
        });
        continue;
      }

      let stats: Awaited<ReturnType<typeof lstat>>;
      try {
        stats = await lstat(absolutePath);
      } catch {
        // fromCheckpoint 里要求该文件存在，但磁盘上已经没有了，恢复时如果直接写回，
        // 就会覆盖掉“文件为何消失”的真实用户操作，所以要先显式报告冲突。
        conflicts.push({
          path: absolutePath,
          repoRelativePath,
          workspaceRelativePath: toWorkspaceRelativeGitPath(
            repoRelativePath,
            params.workspaceInRepoPath,
          ),
          reason: "missing-in-worktree",
        });
        continue;
      }

      const expectsSymlink = expectedEntry.mode === "120000";
      if (stats.isDirectory() || (expectsSymlink && !stats.isSymbolicLink())) {
        // 当前实现只处理 Git 能稳定表达的文件状态；如果 checkpoint 期待的是文件/符号链接，
        // 现在磁盘却变成了目录或其它类型，直接 restore 很容易出现语义错位，因此按类型冲突处理。
        conflicts.push({
          path: absolutePath,
          repoRelativePath,
          workspaceRelativePath: toWorkspaceRelativeGitPath(
            repoRelativePath,
            params.workspaceInRepoPath,
          ),
          reason: "type-mismatch",
        });
        continue;
      }

      const hashResult = await commandProvider.run({
        cwd: params.repoRoot,
        args: ["hash-object", "--no-filters", absolutePath],
      });
      ensureGitCommandSucceeded("git hash-object checkpoint verify", hashResult);
      if (hashResult.stdout.trim() === expectedEntry.objectId) {
        continue;
      }

      // 这里不比较时间戳、大小等弱信号，而是直接比较 blob hash。
      // 只有内容完全一致，才视为“当前磁盘仍然停留在 fromCheckpoint 基线”。
      conflicts.push({
        path: absolutePath,
        repoRelativePath,
        workspaceRelativePath: toWorkspaceRelativeGitPath(
          repoRelativePath,
          params.workspaceInRepoPath,
        ),
        reason: "content-mismatch",
      });
    }

    const deduped = new Map<string, GitCheckpointConflict>();
    for (const conflict of conflicts) {
      deduped.set(conflict.repoRelativePath, conflict);
    }
    return [...deduped.values()];
  }

  return {
    /**
     * 创建一个不可变的 workspace 文件快照。
     *
     * 整体流程：
     * 1. 解析 workspace 对应的 Git 仓库与 scope
     * 2. 用临时 GIT_INDEX_FILE 收集当前 live worktree 状态
     * 3. 通过 write-tree / commit-tree 生成内部隐藏 commit
     * 4. 用 hidden ref 挂住这份 commit，防止被 Git GC 提前清掉
     * 5. 返回 manifest 需要的元信息
     *
     * 关键约束：
     * - 不污染用户真实 index
     * - 不产生用户可见分支或普通 commit
     * - scope 永远跟随当前 workspace，而不是整个 repo 无差别快照
     */
    async createCheckpoint(params) {
      const resolution = await ensureRepository(params.workspacePath);
      const refName = getCheckpointRefName(params.workspacePath, params.checkpointId);
      const tempIndexRootDir = getGitCheckpointIndexRootDir();
      await mkdir(tempIndexRootDir, { recursive: true });
      const tempIndexDir = await mkdtemp(resolve(tempIndexRootDir, "index-"));
      const tempIndexPath = resolve(tempIndexDir, "index");
      const env = buildCheckpointEnv(tempIndexPath);
      const pathspec = getWorkspacePathspec(resolution.workspaceInRepoPath);

      try {
        // 预热临时 index：优先复制用户真实 index，降级到 read-tree HEAD，最差回到空 index。
        // 背景：空 index 下 git add -A 会对 workspace 全量文件做 open/read/hash 并写入 object store，
        // 在 Windows + Defender 环境下单文件开销被放大到 5-15ms，大仓库轻易撞破 15s 超时。
        // 复用用户 index 的 stat cache 后，未改动文件走 stat-match 快速路径，直接跳过读取与写对象，
        // Mac/Linux 同样受益（大仓库 add 从数秒降到亚秒），且最终 tree 由 worktree 决定，语义完全等价。
        // 用 rev-parse --git-path index 解析真实 index 路径，兼容 worktree / submodule 场景。
        const indexPathResult = await commandProvider.run({
          cwd: resolution.repoRoot,
          args: ["rev-parse", "--git-path", "index"],
        });
        let primed = false;
        if (indexPathResult.exitCode === 0) {
          const indexRelPath = indexPathResult.stdout.trim();
          if (indexRelPath.length > 0) {
            const userIndexPath = resolve(resolution.repoRoot, indexRelPath);
            try {
              await copyFile(userIndexPath, tempIndexPath);
              primed = true;
            } catch {
              // 用户 index 不存在（刚 init 的空仓）或无权限，降级处理。
            }
          }
        }
        if (!primed) {
          // 没有可复制的 index 时，用 HEAD tree 填充临时 index，至少让已追踪文件走 hash-match 路径。
          // HEAD 不存在（全新仓库）时 read-tree 会失败，允许静默回落到空 index。
          const readTreeResult = await commandProvider.run({
            cwd: resolution.repoRoot,
            args: ["read-tree", "HEAD"],
            env,
          });
          if (readTreeResult.exitCode === 0) {
            primed = true;
          }
        }

        // 核心实现：用临时 GIT_INDEX_FILE 把当前 workspace 的 live 状态固化成隐藏 commit，
        // 这样既能复用 Git 的对象存储能力，又不会污染用户真实 index / staged 状态。
        const addResult = await commandProvider.run({
          cwd: resolution.repoRoot,
          args: ["add", "-A", "--", pathspec],
          env,
        });
        ensureGitCommandSucceeded("git add checkpoint", addResult);

        // 临时 index 已经收集了当前 workspace scope 的完整状态，下一步把它冻结成 tree object。
        const treeResult = await commandProvider.run({
          cwd: resolution.repoRoot,
          args: ["write-tree"],
          env,
        });
        ensureGitCommandSucceeded("git write-tree checkpoint", treeResult);

        // checkpoint 不需要进入用户 branch 历史，但 Git object 必须有一个稳定锚点。
        // 因此这里创建内部 commit，再由后续 hidden ref 指向它。
        const commitResult = await commandProvider.run({
          cwd: resolution.repoRoot,
          args: [
            "commit-tree",
            treeResult.stdout.trim(),
            "-m",
            `zcode checkpoint ${params.checkpointId}`,
          ],
          env,
        });
        ensureGitCommandSucceeded("git commit-tree checkpoint", commitResult);
        const commitOid = commitResult.stdout.trim();

        // hidden ref 是 checkpoint 的“长期引用”，它保证：
        // 1. Git 不会把这份对象当成垃圾直接回收
        // 2. 后续 diff / restore / delete 都能稳定按 refName 找回对应 commit
        const updateRefResult = await commandProvider.run({
          cwd: resolution.repoRoot,
          args: ["update-ref", refName, commitOid],
        });
        ensureGitCommandSucceeded("git update-ref checkpoint", updateRefResult);

        return {
          checkpointId: params.checkpointId,
          workspacePath: params.workspacePath,
          repoRoot: resolution.repoRoot,
          workspaceInRepoPath: resolution.workspaceInRepoPath,
          createdAt: Date.now(),
          refName,
          commitOid,
          scope: "workspace",
        };
      } finally {
        // 临时 index 只服务于本次 checkpoint 构建，结束后必须清掉，避免泄露到宿主环境。
        await rm(tempIndexDir, { recursive: true, force: true });
      }
    },

    /**
     * 比较两个 checkpoint 在当前 workspace scope 下的文件差异。
     *
     * 这个方法本身不感知 ZCode Agent/task/turn，只回答一个纯文件问题：
     * “从 fromCheckpoint 到 toCheckpoint，这个工作区范围内有哪些文件发生了什么变化？”
     *
     * 返回值会被 restore、后续摘要能力、甚至潜在的调试工具复用，所以这里保持纯读、无副作用。
     */
    async diffCheckpoints(params) {
      return await computeCheckpointDiff(params);
    },

    /**
     * 把当前 live workspace 从 fromCheckpoint 安全恢复到 toCheckpoint。
     *
     * 这是整个底座最核心的方法，它的语义不是“直接恢复到某个 checkpoint”，
     * 而是“三方比较”：
     * - 调用方声明：当前磁盘应当还停留在 fromCheckpoint
     * - 实际目标：希望把文件状态恢复到 toCheckpoint
     * - 当前现实：磁盘上可能已经被用户或其它流程继续改过
     *
     * 因此执行顺序是：
     * 1. 先算 from -> to 的受影响路径
     * 2. 再检查这些路径当前是否仍等于 fromCheckpoint
     * 3. 有冲突则返回，不直接覆盖
     * 4. 无冲突或 force=true 时，再把 toCheckpoint 的内容写回 worktree
     * 5. 最后再次校验，确保恢复后的真实磁盘已经等于 toCheckpoint
     */
    async restoreBetweenCheckpoints(params) {
      const resolution = await ensureRepository(params.workspacePath);
      const diff = await computeCheckpointDiff({
        workspacePath: params.workspacePath,
        from: params.from,
        to: params.to,
      });
      // diff 里既可能有当前路径，也可能有 rename 前的旧路径。
      // 这里统一折叠成最终受影响 path 集，后面的冲突检测和删除逻辑都按这份集合工作。
      const affectedRepoPaths = buildAffectedRepoPaths(diff.files).map((path) =>
        normalizeAffectedRepoPath(resolution.repoRoot, path),
      );

      if (affectedRepoPaths.length === 0) {
        return {
          success: true,
          restoredPaths: [],
        };
      }

      const conflicts = await collectWorkspaceConflicts({
        repoRoot: resolution.repoRoot,
        workspaceInRepoPath: resolution.workspaceInRepoPath,
        from: params.from,
        affectedRepoPaths,
      });
      if (conflicts.length > 0 && params.force !== true) {
        // 默认模式下，一旦发现相关路径已经偏离 fromCheckpoint，就拒绝写入。
        // 这样上层可以把冲突信息抛给用户，而不是底层偷偷覆盖掉他们的新修改。
        return {
          success: false,
          conflicts,
        };
      }

      const restoreRepoPaths = diff.files
        .filter((file) => file.kind !== "deleted")
        .map((file) => file.repoRelativePath);
      if (restoreRepoPaths.length > 0) {
        // restore 阶段只改 worktree，不改真实 index。这样回滚能力才是“文件状态恢复”，
        // 而不是偷偷改用户暂存区的破坏性操作。
        const restoreResult = await commandProvider.run({
          cwd: resolution.repoRoot,
          args: [
            "restore",
            `--source=${params.to.commitOid}`,
            "--worktree",
            "--",
            ...restoreRepoPaths,
          ],
        });
        ensureGitCommandSucceeded("git restore checkpoint", restoreResult);
      }

      const deleteAbsolutePaths = new Set<string>();
      for (const file of diff.files) {
        if (file.kind === "deleted") {
          // toCheckpoint 不再包含这些路径，restore 之后需要把 live worktree 里的残留实体删掉。
          deleteAbsolutePaths.add(file.path);
          continue;
        }
        if (file.kind === "renamed" && file.originalPath) {
          // rename 场景下，git restore 只会把新路径内容恢复出来；
          // 旧路径要由我们显式删除，避免“新旧文件并存”。
          deleteAbsolutePaths.add(file.originalPath);
        }
      }
      for (const path of deleteAbsolutePaths) {
        await removeFileIfExists(path);
      }

      const verifyConflicts = await collectWorkspaceConflicts({
        repoRoot: resolution.repoRoot,
        workspaceInRepoPath: resolution.workspaceInRepoPath,
        from: params.to,
        affectedRepoPaths,
      });
      if (verifyConflicts.length > 0) {
        // 这里理论上不应该再有偏差；如果还有，说明 restore 过程没有把磁盘真正带到目标状态，
        // 继续向上返回 success 只会把错误状态固化，因此直接抛错让调用方感知异常。
        throw new Error("Checkpoint restore verification failed.");
      }

      return {
        success: true,
        restoredPaths: diff.files.map((file) => file.path),
      };
    },

    /**
     * 删除一个 checkpoint 的 Git 引用。
     *
     * 这里只负责删除 hidden ref；manifest 的删除由上层 store/service 完成。
     * 这样 repo 层专注于 Git 对象引用管理，store 层专注于本地元数据文件管理，职责更清晰。
     */
    async deleteCheckpoint(params) {
      const resolution = await ensureRepository(params.workspacePath);
      const deleteRefResult = await commandProvider.run({
        cwd: resolution.repoRoot,
        args: ["update-ref", "-d", params.checkpoint.refName],
      });
      ensureGitCommandSucceeded("git update-ref -d checkpoint", deleteRefResult, [0, 1]);
    },
  };
}

export type { GitCheckpointRepo };
