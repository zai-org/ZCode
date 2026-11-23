import { rename } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

const RETRYABLE_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const FIRST_DELAY_MS = 50;
const MAX_DELAY_MS = 2_000;
const MAX_WAIT_MS = 15_000;

/**
 * 修复原因：Windows 上目录中只要有文件被别的程序打开且未允许删除，整个目录就不能改名。
 * 安全软件会在新文件写出后稍晚打开它们扫描，占用几十毫秒到约 1.6 秒（ZCT-2118196504844603392 实测），
 * 原来改名一次失败就放弃，解压较慢的 Poppler 每次都撞上。这里只对 Windows 的这类临时占用退避重试，
 * 最多等 15 秒；其他错误、其他平台和超出等待上限的失败仍原样抛出。
 */
export async function renamePreinstalledPath(
  from: string,
  to: string,
  options: {
    /** 不传表示等待期间不响应取消，用于已准入、必须结算的发布。 */
    signal?: AbortSignal;
    onRetry: (detail: { code: string; attempt: number; waitedMs: number }) => void;
  },
): Promise<void> {
  const startedAt = Date.now();
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      const waitedMs = Date.now() - startedAt;
      const remainingMs = MAX_WAIT_MS - waitedMs;
      if (process.platform !== "win32" || !RETRYABLE_CODES.has(code) || remainingMs <= 0)
        throw error;
      options.onRetry({ code, attempt, waitedMs });
      // 最后一次等待截到上限，保证在第 15 秒左右还有一次尝试。
      const delayMs = Math.min(FIRST_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS, remainingMs);
      await sleep(delayMs, undefined, { signal: options.signal });
    }
  }
}
