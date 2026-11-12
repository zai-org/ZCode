import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  CLI_MEMORY_FILE_PATTERN,
  CLI_MEMORY_MAX_FILES,
  CLI_MEMORY_MAX_FILE_BYTES,
  sanitizeCliMemoryDiagnostic,
  type CliMemoryDiagnostic,
} from "@zcode/shared";
import { acquireFileLock, atomicWritePrivateTextFile } from "@zcode/shared/node";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const LOCK_OWNERLESS_GRACE_MS = 100;
const LOCK_TRY_MS = 25;
const MAX_FILES_PER_INSTANCE = 2;
let writing = false;

export async function writeMemoryDiagnostic(
  directory: string,
  record: CliMemoryDiagnostic,
): Promise<void> {
  if (writing) return;
  writing = true;
  let release: (() => Promise<void>) | undefined;
  try {
    const safe = sanitizeCliMemoryDiagnostic(record);
    if (!safe || !safe.instanceId) return;
    const text = JSON.stringify(safe) + "\n";
    if (Buffer.byteLength(text) > CLI_MEMORY_MAX_FILE_BYTES) return;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // 复用跨进程锁的存活 owner 判据；竞争只试一次，不创建进程内等待队列。
    release = await acquireFileLock(
      join(directory, "records"),
      [],
      LOCK_OWNERLESS_GRACE_MS,
      LOCK_TRY_MS,
    );
    const files: Array<{ path: string; name: string; mtime: number }> = [];
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      if (name.startsWith(".memory-") && name.endsWith(".tmp")) {
        await rm(path, { force: true });
      } else if (CLI_MEMORY_FILE_PATTERN.test(name)) {
        const info = await lstat(path);
        if (
          !info.isFile() ||
          info.nlink !== 1 ||
          info.size > CLI_MEMORY_MAX_FILE_BYTES ||
          Date.now() - info.mtimeMs > RETENTION_MS
        ) {
          await rm(path, { force: true });
        } else files.push({ path, name, mtime: info.mtimeMs });
      }
    }
    files.sort((a, b) => b.mtime - a.mtime);
    let ownFiles = 0;
    const retained: typeof files = [];
    for (const file of files) {
      if (
        file.name.endsWith("-" + safe.instanceId + ".jsonl") &&
        ++ownFiles >= MAX_FILES_PER_INSTANCE
      ) {
        await rm(file.path, { force: true });
      } else retained.push(file);
    }
    // 先腾出一个完整文件配额再写；临时文件也只可能有一份，崩溃后由下个持锁者回收。
    // 先替换本实例的旧记录，避免仍活跃的 CLI 很快挤掉已崩溃实例留下的最后现场。
    for (const old of retained.slice(CLI_MEMORY_MAX_FILES - 1)) await rm(old.path, { force: true });
    const filename = "memory-" + Date.now() + "-" + safe.instanceId + ".jsonl";
    await atomicWritePrivateTextFile(join(directory, filename), text, []);
  } catch {
    /* 存储不可用时丢本轮，不能阻塞或改变任务结果。 */
  } finally {
    try {
      await release?.();
    } catch {
      /* 下次使用既有 abandoned-lock 恢复。 */
    }
    writing = false;
  }
}
