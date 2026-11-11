import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { acquireFileLock } from "./atomicFileLock.js";

const DEFAULT_LOCK_RETRY_DELAYS_MS = [25, 50, 100, 200, 400] as const;
const DEFAULT_LOCK_OWNERLESS_GRACE_MS = 100;
const DEFAULT_LOCK_MAX_WAIT_MS = 8_000;
const DEFAULT_RENAME_RETRY_DELAYS_MS = [50, 100, 200, 400, 800] as const;
const processFileLockTails = new Map<string, Promise<void>>();
const credentialOperationScope = new AsyncLocalStorage<ReadonlyMap<string, string>>();
export type CredentialFileGuard = <T>(operation: () => Promise<T>) => Promise<T>;

/** 登录等跨请求流程保留最初代次，不能在迟到响应写入时重新领取新代次。 */
export async function captureCredentialFileGuard(filePath: string): Promise<CredentialFileGuard> {
  const generation =
    credentialOperationScope.getStore()?.get(filePath) ?? (await credentialGeneration(filePath));
  const scope = new Map(credentialOperationScope.getStore());
  scope.set(filePath, generation);
  return (operation) =>
    credentialOperationScope.run(scope, async () => {
      await assertCredentialGeneration(filePath, generation);
      const result = await operation();
      await assertCredentialGeneration(filePath, generation);
      return result;
    });
}

async function credentialGeneration(filePath: string): Promise<string> {
  try {
    return await readFile(`${filePath}.recovery-generation`, "utf8");
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return "";
    throw error;
  }
}

async function assertCredentialGeneration(filePath: string, expected: string): Promise<void> {
  if ((await credentialGeneration(filePath)) !== expected) {
    throw Object.assign(new Error("Credential store changed; retry with the current store"), {
      code: "ZCODE_CREDENTIAL_STORE_CHANGED",
    });
  }
}

/** 恢复会使已接收的旧读写失效；代次与凭据分离，不能用进程内计数代替跨进程检查。 */
export async function withCredentialFileRead<T>(
  filePath: string,
  read: () => Promise<T>,
): Promise<T> {
  // 普通读取不能争用写锁：慢写入曾使正常登录读取等待 8 秒后超时。
  // 前后代次检查拒绝跨恢复的旧结果；恢复替换前的损坏原件仍由读取方严格解析并拒绝。
  const expected = credentialOperationScope.getStore()?.get(filePath);
  const current = await credentialGeneration(filePath);
  if (expected !== undefined) await assertCredentialGeneration(filePath, expected);
  const generation = expected ?? current;
  let result: T;
  try {
    result = await read();
  } catch (error) {
    await assertCredentialGeneration(filePath, generation);
    throw error;
  }
  await assertCredentialGeneration(filePath, generation);
  return result;
}

export async function withCredentialFileMutation<T>(
  filePath: string,
  mutate: () => Promise<T>,
): Promise<T> {
  const generation =
    credentialOperationScope.getStore()?.get(filePath) ?? (await credentialGeneration(filePath));
  return withFileLock(filePath, async () => {
    await assertCredentialGeneration(filePath, generation);
    return mutate();
  });
}

export interface SharedFileLockOptions {
  lockRetryDelaysMs?: readonly number[];
  lockOwnerlessGraceMs?: number;
  lockMaxWaitMs?: number;
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isRetryableRenameError(error: unknown): boolean {
  const code = getErrorCode(error);
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

async function renameWithRetry(
  tempFile: string,
  filePath: string,
  retryDelaysMs: readonly number[],
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(tempFile, filePath);
      return;
    } catch (error) {
      const delayMs = retryDelaysMs[attempt];
      if (delayMs === undefined || !isRetryableRenameError(error)) {
        throw error;
      }
      await sleep(delayMs);
    }
  }
}

export async function withFileLock<T>(
  filePath: string,
  operation: () => Promise<T>,
  options: SharedFileLockOptions = {},
): Promise<T> {
  // 同一进程几十个 caller 同时轮询目录锁会形成惊群，后排请求可能在
  // 很短的实际写入之后仍撞上 8 秒超时。先做进程内 FIFO，每个进程只让队首竞争 OS 锁。
  const previousTail = processFileLockTails.get(filePath) ?? Promise.resolve();
  let releaseProcessQueue!: () => void;
  const currentTail = new Promise<void>((resolve) => {
    releaseProcessQueue = resolve;
  });
  processFileLockTails.set(filePath, currentTail);
  await previousTail;

  let releaseLock: (() => Promise<void>) | undefined;
  try {
    await mkdir(dirname(filePath), { recursive: true });
    releaseLock = await acquireFileLock(
      filePath,
      options.lockRetryDelaysMs ?? DEFAULT_LOCK_RETRY_DELAYS_MS,
      options.lockOwnerlessGraceMs ?? DEFAULT_LOCK_OWNERLESS_GRACE_MS,
      options.lockMaxWaitMs ?? DEFAULT_LOCK_MAX_WAIT_MS,
    );
    return await operation();
  } finally {
    try {
      await releaseLock?.();
    } finally {
      releaseProcessQueue();
      if (processFileLockTails.get(filePath) === currentTail) {
        processFileLockTails.delete(filePath);
      }
    }
  }
}

export async function atomicWritePrivateTextFile(
  filePath: string,
  content: string,
  renameRetryDelaysMs: readonly number[] = DEFAULT_RENAME_RETRY_DELAYS_MS,
): Promise<void> {
  const directory = dirname(filePath);
  const tempPath = join(
    directory,
    `.${basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(tempPath, content, { encoding: "utf-8", mode: 0o600 });
    await renameWithRetry(tempPath, filePath, renameRetryDelaysMs);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function backupCorruptFile(filePath: string): Promise<string> {
  const content = await readFile(filePath);
  const contentId = createHash("sha256").update(content).digest("hex").slice(0, 24);
  const backupPath = `${filePath}.corrupt-${contentId}.bak`;
  try {
    // 同一损坏凭据会被 Desktop、CLI 和重试循环反复读取。按内容确定备份名并
    // 排他创建，让失败路径稳定收敛到一份证据，同时避免 copyFile 继承历史宽松权限。
    await writeFile(backupPath, content, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (getErrorCode(error) !== "EEXIST") throw error;
  }
  await chmod(backupPath, 0o600);
  return backupPath;
}
