import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

interface E2EFileReplaceOperations {
  rename(from: string, to: string): Promise<void> | void;
  wait(delayMs: number): Promise<void>;
}

interface E2EAtomicJsonFileOperations extends E2EFileReplaceOperations {
  mkdir(path: string): Promise<void> | void;
  remove(path: string, options: { force: true }): Promise<void> | void;
  write(path: string, content: string): Promise<void> | void;
}

const nodeFileOperations: E2EAtomicJsonFileOperations = {
  mkdir: async (path) => {
    await mkdir(path, { recursive: true });
  },
  remove: async (path, options) => {
    await rm(path, options);
  },
  rename,
  wait: (delayMs) => new Promise((resolveWait) => setTimeout(resolveWait, delayMs)),
  write: async (path, content) => {
    await writeFile(path, content, "utf-8");
  },
};

const FILE_REPLACE_RETRY_ATTEMPTS = 20;
const FILE_REPLACE_RETRY_DELAY_MS = 25;
const FILE_REPLACE_ERROR_CODES = new Set(["EBUSY", "EACCES", "EPERM"]);

export async function writeE2EJsonFileAtomically(
  path: string,
  value: unknown,
  operations: E2EAtomicJsonFileOperations = nodeFileOperations,
): Promise<void> {
  await operations.mkdir(dirname(path));
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;

  try {
    // Bug 根因：capture server 直接 truncate 后重写 JSON 时，另一个 WDIO worker
    // 可能读到半截内容。先完整写临时文件再 rename，reader 只会看到完整版本。
    await operations.write(temporaryPath, JSON.stringify(value, null, 2));
    // Bug 根因：Windows 不允许 rename 覆盖仍被另一个 worker 短暂持有读句柄的
    // capture.json。同步 rename 一次失败会打断 replay handler，并让 provider socket
    // 永久 pending；这里仅对 Windows 文件占用错误做有界异步重试，避免阻塞事件循环。
    await replaceE2EFileWithRetry(temporaryPath, path, operations);
  } catch (error) {
    await operations.remove(temporaryPath, { force: true });
    throw error;
  }
}

export async function replaceE2EFileWithRetry(
  temporaryPath: string,
  path: string,
  operations: E2EFileReplaceOperations = nodeFileOperations,
): Promise<void> {
  for (let attempt = 1; attempt <= FILE_REPLACE_RETRY_ATTEMPTS; attempt += 1) {
    try {
      await operations.rename(temporaryPath, path);
      return;
    } catch (error) {
      if (!isE2EFileReplaceConflict(error) || attempt === FILE_REPLACE_RETRY_ATTEMPTS) {
        throw error;
      }
      await operations.wait(FILE_REPLACE_RETRY_DELAY_MS);
    }
  }
}

/** Windows 文件占用导致的替换冲突（EBUSY / EACCES / EPERM）。 */
export function isE2EFileReplaceConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    FILE_REPLACE_ERROR_CODES.has(error.code)
  );
}
