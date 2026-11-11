import { describe, expect, it, vi } from "vitest";
import {
  createOfficialPluginCacheRetryBudget,
  getOfficialPluginCacheRetryAttempts,
  isTransientOfficialPluginCacheFsError,
  retryOfficialPluginCacheFs,
} from "../src/app/official-plugin-cache-fs.js";

describe("official plugin cache fs helpers", () => {
  it("retries an asynchronous rejection and yields during retry waits", async () => {
    const waiting = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const operation = vi.fn().mockRejectedValueOnce(errno("EPERM")).mockResolvedValue("ok");
    let sleepEntered = false;
    const work = retryOfficialPluginCacheFs(operation, {
      budget: createOfficialPluginCacheRetryBudget({
        sleep: () => {
          sleepEntered = true;
          waiting.resolve();
          return release.promise;
        },
      }),
    });
    // 立即观察拒绝；旧同步重试不能处理异步操作失败。
    const observed = Promise.resolve(work).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await Promise.race([waiting.promise, observed]);
    try {
      expect(sleepEntered).toBe(true);
      expect(operation).toHaveBeenCalledTimes(1);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(operation).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
    }
    expect(await observed).toEqual({ value: "ok" });
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("recognizes only transient cache contention errors", () => {
    for (const code of ["EACCES", "EBUSY", "EEXIST", "ENOTEMPTY", "EPERM"]) {
      expect(isTransientOfficialPluginCacheFsError(errno(code))).toBe(true);
    }

    expect(isTransientOfficialPluginCacheFsError(errno("ENOENT"))).toBe(false);
    // overlay 下层目录的 EXDEV 不会因重试消失；它由 seed 的删除后替换路径和降级协议处理。
    expect(isTransientOfficialPluginCacheFsError(errno("EXDEV"))).toBe(false);
    expect(isTransientOfficialPluginCacheFsError(new Error("invalid manifest"))).toBe(false);
  });

  it("does not start another filesystem attempt after cancellation", async () => {
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const operation = vi.fn(async () => {
      throw errno("EPERM");
    });
    const result = retryOfficialPluginCacheFs(operation, {
      budget: createOfficialPluginCacheRetryBudget({
        signal: controller.signal,
        sleep: async () => {
          entered.resolve();
          await release.promise;
        },
      }),
    }).catch((error: unknown) => error);
    await entered.promise;
    controller.abort();
    release.resolve();
    expect(await result).toMatchObject({ name: "AbortError" });
    expect(operation).toHaveBeenCalledOnce();
  });

  it("keeps the event loop responsive through four failed EPERM attempts", async () => {
    const entered = Array.from({ length: 3 }, () => Promise.withResolvers<void>());
    const releases = Array.from({ length: 3 }, () => Promise.withResolvers<void>());
    const operation = vi.fn(async () => {
      throw errno("EPERM");
    });
    let waits = 0;
    let settled = false;
    const work = retryOfficialPluginCacheFs(operation, {
      budget: createOfficialPluginCacheRetryBudget({
        now: () => 0,
        sleep: () => {
          const index = waits++;
          entered[index]!.resolve();
          return releases[index]!.promise;
        },
      }),
    }).then(
      () => {
        settled = true;
        return undefined;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    try {
      for (let index = 0; index < entered.length; index += 1) {
        await Promise.race([entered[index]!.promise, work]);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(settled).toBe(false);
        expect(operation).toHaveBeenCalledTimes(index + 1);
        releases[index]!.resolve();
      }
      const error = await work;
      expect(error).toMatchObject({ code: "EPERM" });
      expect(getOfficialPluginCacheRetryAttempts(error)).toBe(4);
      expect(operation).toHaveBeenCalledTimes(4);
    } finally {
      for (const release of releases) release.resolve();
      await work;
    }
  });

  it("retries transient failures within the shared deadline", async () => {
    let nowMs = 0;
    const sleep = vi.fn((delayMs: number) => {
      nowMs += delayMs;
    });
    const budget = createOfficialPluginCacheRetryBudget({
      durationMs: 1_500,
      now: () => nowMs,
      sleep,
    });
    let attempts = 0;

    const result = await retryOfficialPluginCacheFs(
      () => {
        attempts += 1;
        if (attempts < 3) throw errno("EPERM");
        return "ok";
      },
      { budget },
    );

    expect(result).toBe("ok");
    expect(attempts).toBe(3);
    expect(sleep.mock.calls).toEqual([[25], [50]]);
  });

  it("stops retrying when the shared deadline cannot fit the next delay", async () => {
    let nowMs = 0;
    const budget = createOfficialPluginCacheRetryBudget({
      durationMs: 60,
      now: () => nowMs,
      sleep: (delayMs) => {
        nowMs += delayMs;
      },
    });
    const error = errno("EPERM");
    let attempts = 0;

    await expect(
      (async () =>
        await retryOfficialPluginCacheFs(
          () => {
            attempts += 1;
            throw error;
          },
          { budget },
        ))(),
    ).rejects.toThrow(error);

    expect(attempts).toBe(2);
    expect(getOfficialPluginCacheRetryAttempts(error)).toBe(2);
  });

  it("does not retry non-transient failures", async () => {
    const operation = vi.fn(() => {
      throw new Error("invalid manifest");
    });

    await expect((async () => await retryOfficialPluginCacheFs(operation))()).rejects.toThrow(
      "invalid manifest",
    );
    expect(operation).toHaveBeenCalledTimes(1);
  });
});

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}
