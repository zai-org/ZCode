import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BotConfig, BotProviderCallbackResult, BotRuntimeInfo } from "@zcode/shared";
import { getAppConfigDir } from "../paths.js";

export const BOT_RUNTIME_LOCK_RETRY_MS = 10_000;
export const BOT_RUNTIME_LOCK_LEASE_MS = 30_000;
const BOT_RUNTIME_LOCK_HEARTBEAT_MS = 10_000;
const BOT_RUNTIME_LOCK_CLEANUP_RETRY_DELAYS_MS = [100, 250, 500] as const;
const BOT_POLLING_RETRY_BASE_MS = 5_000;
const BOT_POLLING_RETRY_MAX_MS = 5 * 60_000;

export interface BotRuntimeLogger {
  debug(traceId: string | undefined, message: string): void;
  info(traceId: string | undefined, message: string): void;
  warn(traceId: string | undefined, message: string): void;
}

export interface BotRuntimeStatusSink {
  getRuntimeStatus(botId: string): BotRuntimeInfo | undefined;
  setRuntimeStatus(status: BotRuntimeInfo): void;
}

export function createBotConnectionFingerprint(parts: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function assertBotCallbackSucceeded(
  provider: string,
  result: BotProviderCallbackResult,
): void {
  if (result.ok) {
    return;
  }
  // Bugfix: provider callback 以返回值表达可恢复的业务失败，不一定 reject。
  // 外部消费游标只能在 ok=true 后提交，否则瞬时失败会被错误确认并永久丢消息。
  throw new Error(`${provider} callback failed: status=${result.status ?? "unknown"}`);
}

/** 轮询连续失败的重试间隔：第 1 次 5 秒，之后每次翻倍，最长 5 分钟。 */
export function getBotPollingRetryDelayMs(consecutiveFailures: number): number {
  return Math.min(
    BOT_POLLING_RETRY_BASE_MS * 2 ** Math.max(0, consecutiveFailures - 1),
    BOT_POLLING_RETRY_MAX_MS,
  );
}

export function createLatestRuntimeRefreshQueue() {
  let generation = 0;
  let queue: Promise<void> = Promise.resolve();

  return {
    enqueue(reconcile: (isLatest: () => boolean) => Promise<void>): Promise<void> {
      const currentGeneration = ++generation;
      const result = queue
        .catch(() => undefined)
        .then(() => reconcile(() => currentGeneration === generation));
      // Bugfix: 配置保存会连续触发 fire-and-forget refresh。串行队列既要让后一轮等待
      // 前一轮释放连接，又不能因前一轮失败永久阻断后续最新配置。
      queue = result.catch(() => undefined);
      return result;
    },
    invalidate(): void {
      generation += 1;
    },
  };
}

interface BotRuntimeLockOwner {
  pid: number;
  botId: string;
  nonce: string;
  createdAt: number;
}

interface BotRuntimeLock {
  release(): Promise<void>;
}
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export function isBotRuntimeLockConflictError(error: unknown): boolean {
  return (
    isNodeError(error) &&
    (error.code === "EEXIST" ||
      error.code === "ENOTEMPTY" ||
      error.code === "EISDIR" ||
      error.code === "EPERM")
  );
}

function isBotRuntimeLockCleanupRetryable(error: unknown): boolean {
  return (
    isNodeError(error) &&
    (error.code === "EPERM" ||
      error.code === "EBUSY" ||
      error.code === "ENOTEMPTY")
  );
}

async function removeBotRuntimeLockPath(lockPath: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(lockPath, { recursive: true, force: true });
      return;
    } catch (error) {
      const delay = BOT_RUNTIME_LOCK_CLEANUP_RETRY_DELAYS_MS[attempt];
      if (!isBotRuntimeLockCleanupRetryable(error) || delay === undefined) {
        throw error;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
}

function getBotRuntimeLockPath(namespace: string, lockKey: string): string {
  const lockHash = createHash("sha256").update(lockKey.trim()).digest("hex");
  return join(getAppConfigDir(), "bots-runtime-locks", namespace, `${lockHash}.lock`);
}

async function readBotRuntimeLockOwner(lockPath: string): Promise<BotRuntimeLockOwner | null> {
  try {
    const raw = JSON.parse(
      await readFile(join(lockPath, "owner.json"), "utf-8"),
    ) as Partial<BotRuntimeLockOwner>;
    return typeof raw.pid === "number" &&
      typeof raw.botId === "string" &&
      typeof raw.nonce === "string"
      ? {
          pid: raw.pid,
          botId: raw.botId,
          nonce: raw.nonce,
          createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0,
        }
      : null;
  } catch {
    return null;
  }
}

async function readBotRuntimeLockLeaseAt(lockPath: string, nonce: string): Promise<number> {
  try {
    return (await stat(join(lockPath, `lease-${nonce}`))).mtimeMs;
  } catch {
    return 0;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}

async function acquireBotRuntimeLock(
  namespace: string,
  lockKey: string,
  botId: string,
): Promise<BotRuntimeLock | null> {
  const lockPath = getBotRuntimeLockPath(namespace, lockKey);
  const owner: BotRuntimeLockOwner = {
    pid: process.pid,
    botId,
    nonce: randomBytes(8).toString("hex"),
    createdAt: Date.now(),
  };
  const leasePath = join(lockPath, `lease-${owner.nonce}`);
  await mkdir(dirname(lockPath), {
    recursive: true,
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const pendingLockPath = `${lockPath}.${owner.nonce}.pending`;
    try {
      // Bugfix: 锁目录和 owner 文件必须作为一个完整状态对外可见。
      // 先在唯一临时目录写完 owner，再原子 rename，避免竞争者把尚未初始化完成的锁误判为 stale。
      await mkdir(pendingLockPath);
      await writeFile(join(pendingLockPath, "owner.json"), `${JSON.stringify(owner)}\n`);
      await writeFile(join(pendingLockPath, `lease-${owner.nonce}`), "");
      try {
        await rename(pendingLockPath, lockPath);
      } catch (error) {
        // Bugfix：Windows 将临时锁目录 rename 到已存在锁目录时返回 EPERM；这里只把 rename 冲突当作锁竞争，
        // 避免把 mkdir/writeFile 的权限错误误判为可接管锁。
        if (!isBotRuntimeLockConflictError(error)) {
          throw error;
        }
        // EPERM 也可能只是目录权限错误；只有正式锁路径确实存在时，才进入冲突接管分支。
        if (!(await stat(lockPath).catch(() => undefined))) {
          throw error;
        }
        const currentOwner = await readBotRuntimeLockOwner(lockPath);
        if (currentOwner) {
          const leaseAt = await readBotRuntimeLockLeaseAt(
            lockPath,
            currentOwner.nonce,
          );
          const leaseAge = Date.now() - leaseAt;
          if (
            isProcessAlive(currentOwner.pid) &&
            leaseAt > 0 &&
            leaseAge < BOT_RUNTIME_LOCK_LEASE_MS
          ) {
            return null;
          }
        }
        // Bugfix：陈旧目录可能短暂被 Windows 文件句柄占用；有限重试后再放弃，避免静默残留。
        await removeBotRuntimeLockPath(lockPath);
        continue;
      }
      let heartbeatWriting = false;
      const heartbeat = setInterval(() => {
        if (heartbeatWriting) return;
        heartbeatWriting = true;
        const now = new Date();
        void utimes(leasePath, now, now)
          .catch(() => undefined)
          .finally(() => {
            heartbeatWriting = false;
          });
      }, BOT_RUNTIME_LOCK_HEARTBEAT_MS);
      heartbeat.unref();
      return {
        async release() {
          clearInterval(heartbeat);
          const currentOwner = await readBotRuntimeLockOwner(lockPath);
          if (
            currentOwner?.pid === owner.pid &&
            currentOwner.botId === owner.botId &&
            currentOwner.nonce === owner.nonce
          ) {
            await removeBotRuntimeLockPath(lockPath);
          }
        },
      };
    } finally {
      await removeBotRuntimeLockPath(pendingLockPath);
    }
  }
  return null;
}

export async function acquireTelegramPollingLock(
  token: string,
  botId: string,
): Promise<BotRuntimeLock | null> {
  return acquireBotRuntimeLock("telegram-polling", token, botId);
}

export async function acquireWeixinPollingLock(
  token: string,
  botId: string,
): Promise<BotRuntimeLock | null> {
  return acquireBotRuntimeLock("weixin-polling", token, botId);
}

export function acquireFeishuWebSocketLock(
  bot: Pick<BotConfig, "id" | "provider" | "feishuAppId">,
): Promise<BotRuntimeLock | null> {
  return acquireBotRuntimeLock(`${bot.provider}-websocket`, bot.feishuAppId?.trim() ?? "", bot.id);
}

export function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onAbort = () => finish();
    const timeout = setTimeout(finish, ms);
    // Bugfix: runtime 会长期复用同一个 signal；每次等待结束都必须移除监听器，避免重试时持续累积。
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
