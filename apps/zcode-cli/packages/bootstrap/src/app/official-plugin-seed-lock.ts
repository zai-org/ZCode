import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { dirname, join } from "node:path";

const DEFAULT_RETRY_DELAY_MS = 50;
const DEFAULT_STALE_LOCK_AGE_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const SEED_LOCK_TIMEOUT_ERROR_CODE = "ZCODE_PLUGIN_SEED_LOCK_TIMEOUT";

interface OfficialPluginSeedLockOptions {
  signal?: AbortSignal;
  retryDelayMs?: number;
  staleLockAgeMs?: number;
  timeoutMs?: number;
}

export async function withOfficialPluginSeedLock<T>(
  targetRoot: string,
  action: () => T | Promise<T>,
  options: OfficialPluginSeedLockOptions = {},
): Promise<T> {
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const staleLockAgeMs = options.staleLockAgeMs ?? DEFAULT_STALE_LOCK_AGE_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const lockRoot = `${targetRoot}.seed-lock`;
  const startedAt = Date.now();

  await mkdir(dirname(lockRoot), { recursive: true });
  while (true) {
    options.signal?.throwIfAborted();
    try {
      await mkdir(lockRoot);
      break;
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
      await tryTakeOverStaleLock(lockRoot, staleLockAgeMs);
      if (Date.now() - startedAt >= timeoutMs) {
        throw Object.assign(
          new Error(`[official-plugin-seed-lock] timed out waiting for ${lockRoot}`),
          { code: SEED_LOCK_TIMEOUT_ERROR_CODE },
        );
      }
      await delay(retryDelayMs, undefined, { signal: options.signal });
    }
  }

  try {
    await writeFile(
      join(lockRoot, "owner.json"),
      JSON.stringify({ createdAt: new Date().toISOString(), pid: process.pid }),
    );
    // 不能直接 return Promise：finally 会提前释放锁，让其他 writer 读到半成品。
    return await action();
  } finally {
    await removeLockDirectory(lockRoot);
  }
}

/** 稳定错误码判定（项目规范：不靠错误文本分流），供调用方把等锁超时按降级处理。 */
export function isOfficialPluginSeedLockTimeoutError(
  error: unknown,
): error is NodeJS.ErrnoException {
  return errorCode(error) === SEED_LOCK_TIMEOUT_ERROR_CODE;
}

async function tryTakeOverStaleLock(lockRoot: string, staleLockAgeMs: number): Promise<void> {
  let ageMs: number;
  try {
    ageMs = Date.now() - (await stat(lockRoot)).mtimeMs;
  } catch (error) {
    if (isNotFoundError(error)) return;
    throw error;
  }

  const ownerPid = await readLockOwnerPid(lockRoot);
  if (ownerPid !== undefined && isProcessAlive(ownerPid)) return;
  if (ownerPid === undefined && ageMs < staleLockAgeMs) return;

  const staleRoot = `${lockRoot}.stale-${process.pid}-${Date.now()}`;
  try {
    // 直接删除 stale lock 存在 TOCTOU，可能误删另一进程刚创建的新锁。
    // 先原子改名取得旧锁所有权，只清理自己成功改名的目录。
    await rename(lockRoot, staleRoot);
  } catch (error) {
    if (isTransientLockRace(error)) return;
    throw error;
  }
  await removeLockDirectory(staleRoot);
}

async function readLockOwnerPid(lockRoot: string): Promise<number | undefined> {
  try {
    const owner = JSON.parse(await readFile(join(lockRoot, "owner.json"), "utf8")) as {
      pid?: unknown;
    };
    return typeof owner.pid === "number" && Number.isSafeInteger(owner.pid) && owner.pid > 0
      ? owner.pid
      : undefined;
  } catch (error) {
    if (isNotFoundError(error) || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Windows/Unix 都可能因权限返回 EPERM；这代表进程存在，只是不可探测。
    return errorCode(error) === "EPERM";
  }
}

async function removeLockDirectory(path: string): Promise<void> {
  await rm(path, {
    force: true,
    maxRetries: 5,
    recursive: true,
    retryDelay: DEFAULT_RETRY_DELAY_MS,
  });
}

function isAlreadyExistsError(error: unknown): boolean {
  return errorCode(error) === "EEXIST";
}

function isNotFoundError(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function isTransientLockRace(error: unknown): boolean {
  return ["EACCES", "EBUSY", "EEXIST", "ENOENT", "ENOTEMPTY", "EPERM"].includes(errorCode(error));
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null
    ? String((error as NodeJS.ErrnoException).code ?? "")
    : "";
}
