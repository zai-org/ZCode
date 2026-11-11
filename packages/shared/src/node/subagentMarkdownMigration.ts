import { randomUUID } from "node:crypto";
import { chmod, lstat, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { migrateSubagentMarkdownProvider } from "../subagent-markdown-selection.js";
import { importSubagentStateSelections } from "../subagent-state-migration.js";
import { withFileLock } from "./privateFilePersistence.js";

export interface SubagentMarkdownMigrationResult {
  migrated: string[];
  failures: Array<{ path: string; error: unknown }>;
}

/** 共享原子导入边界：JSON 的旧字段只在这里解释，完成落盘后 reader 只读当前字段。 */
export async function migrateSubagentStateFile(path: string): Promise<void> {
  try {
    await migrateFile(path, (original) => {
      const parsed: unknown = JSON.parse(original);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return original;
      const next = importSubagentStateSelections(parsed as Record<string, unknown>);
      return JSON.stringify(next) === JSON.stringify(parsed)
        ? original
        : JSON.stringify(next, null, 2);
    });
  } catch (error) {
    // 损坏文件维持既有空覆盖语义，不覆盖原文；IO 错误不冒充迁移成功。
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

async function migrateFile(
  path: string,
  transform: (original: string) => string,
): Promise<boolean> {
  const info = await lstat(path);
  if (!info.isFile()) return false;
  return withFileLock(path, async () => {
    const before = await lstat(path);
    if (!before.isFile() || (before.mode & 0o222) === 0) return false;
    const original = await readFile(path, "utf8");
    const next = transform(original);
    if (next === original) return false;
    const directory = dirname(path);
    const physicalDirectory = await realpath(directory);
    const temp = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
    try {
      await writeFile(temp, next, { flag: "wx", mode: before.mode & 0o777 });
      await chmod(temp, before.mode & 0o777);
      // 外部编辑器不持有应用锁：写前比较原文和文件身份，不能覆盖并发修改。
      const current = await lstat(path);
      if (
        !current.isFile() ||
        current.ino !== before.ino ||
        current.dev !== before.dev ||
        (await realpath(directory)) !== physicalDirectory ||
        (await readFile(path, "utf8")) !== original
      ) {
        throw new Error("Subagent file changed during migration");
      }
      await rename(temp, path);
      return true;
    } finally {
      await rm(temp, { force: true });
    }
  });
}

/** 调用方只传所属环境的用户 agents 根目录；项目/插件不得进入自动写入入口。 */
export async function migrateUserSubagentMarkdown(
  userRoot: string,
): Promise<SubagentMarkdownMigrationResult> {
  const result: SubagentMarkdownMigrationResult = { migrated: [], failures: [] };
  try {
    // 不能沿用户目录内的链接写到项目/插件或其他目录。
    const rootStat = await lstat(userRoot);
    if (!rootStat.isDirectory()) return result;
    // 旧迁移会递归扫描历史 CLI 安装目录，拖慢工作区冷启动。
    // 与自定义 Agent 加载范围一致，只检查根目录直接文件，不进入子目录。
    for (const entry of await readdir(userRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.(md|markdown)$/iu.test(entry.name)) continue;
      const path = join(userRoot, entry.name);
      try {
        if (await migrateFile(path, migrateSubagentMarkdownProvider)) result.migrated.push(path);
      } catch (error) {
        result.failures.push({ path, error });
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      result.failures.push({ path: userRoot, error });
  }
  return result;
}
