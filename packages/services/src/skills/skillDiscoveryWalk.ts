import { readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  MAX_SKILL_SCAN_DEPTH,
  SKILL_FILE_NAME,
  shouldWalkSkillDirectoryEntry,
} from "@zcode/shared";

// 扫描策略来自 @zcode/shared，供桌面端（本包）与 agent 端（@zcode/adapters）共享，
// 避免两端对“该进入哪些目录”产生分歧。这里转出，保持既有导入路径不变。
export {
  MAX_SKILL_SCAN_DEPTH,
  SKILL_FILE_NAME,
  SKILL_SCAN_EXCLUDED_DIRECTORY_NAMES,
  shouldWalkSkillDirectoryEntry,
} from "@zcode/shared";

export interface WalkSkillMarkdownOptions {
  /** readdir / stat 失败时回调；不传则静默跳过该目录，调用方按需收集诊断。 */
  onError?: (path: string, error: unknown) => void;
  /** 插件技能是独立入口，不再隐式遍历其附属目录。 */
  stopAtSkill?: boolean;
}

/**
 * 自根目录起深度优先遍历，产出每个 SKILL.md 的绝对路径。
 *
 * 受 @zcode/shared 的扫描策略约束：
 * - 跳过 node_modules 等内容目录与（除 .system 外的）点目录；
 * - 限制最大深度（MAX_SKILL_SCAN_DEPTH），作为超深目录链的兜底刹车；
 * - 仅对软链接目录按 realpath 去重，避免 Windows junction / 环路造成重复或无限扫描，
 *   普通目录树不会成环，故热路径上不额外 realpath。
 *
 */
export async function* walkSkillMarkdownPaths(
  rootPath: string,
  options: WalkSkillMarkdownOptions = {},
): AsyncGenerator<string> {
  const stack: Array<{ dir: string; depth: number }> = [{ dir: rootPath, depth: 0 }];
  const visitedSymlinkTargets = new Set<string>();

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    const { dir, depth } = current;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      options.onError?.(dir, error);
      continue;
    }

    let hasSkillFile = false;
    const childDirectories: string[] = [];
    const childSymlinks: string[] = [];
    for (const entry of entries) {
      // 普通文件或指向文件的软链命名为 SKILL.md 都视为技能定义。
      if (entry.name === SKILL_FILE_NAME && !entry.isDirectory()) {
        hasSkillFile = true;
        continue;
      }
      if (!shouldWalkSkillDirectoryEntry(entry.name)) {
        continue;
      }
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        childDirectories.push(entryPath);
      } else if (entry.isSymbolicLink()) {
        childSymlinks.push(entryPath);
      }
    }

    if (hasSkillFile) {
      yield join(dir, SKILL_FILE_NAME);
      // 与 Agent 的单技能边界一致，子技能须另行声明，避免页面列出不可加载的技能。
      if (options.stopAtSkill) continue;
    }

    if (depth >= MAX_SKILL_SCAN_DEPTH) {
      continue;
    }

    for (const childDirectory of childDirectories) {
      stack.push({ dir: childDirectory, depth: depth + 1 });
    }

    // 软链目录：先确认指向目录、再按 realpath 去重，避免 junction / 环路重复或无限扫描。
    for (const childSymlink of childSymlinks) {
      let targetStat;
      try {
        targetStat = await stat(childSymlink);
      } catch (error) {
        options.onError?.(childSymlink, error);
        continue;
      }
      if (!targetStat.isDirectory()) {
        continue;
      }
      const canonical = await realpath(childSymlink).catch(() => childSymlink);
      if (visitedSymlinkTargets.has(canonical)) {
        continue;
      }
      visitedSymlinkTargets.add(canonical);
      stack.push({ dir: childSymlink, depth: depth + 1 });
    }
  }
}
