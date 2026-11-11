import { describe, expect, it, vi } from "vitest";
import { OfficialPluginCatalogRefresh } from "../src/plugin-discovery/refresh.js";
describe("official catalog refresh", () => {
  it("coalesces callers and throttles successful and failed refresh attempts", async () => {
    let now = 1_000_000;
    const refresh = new OfficialPluginCatalogRefresh(() => now);
    const update = vi.fn(async () => {});
    const signal = new AbortController().signal;
    await Promise.all(
      [1, 2, 3].map(() => refresh.ensure("root", undefined, update, { force: false, signal })),
    );
    expect(update).toHaveBeenCalledOnce();
    await refresh.ensure("root", undefined, update, { force: false, signal });
    expect(update).toHaveBeenCalledOnce();
    now += 600_001;
    update.mockRejectedValue(new Error("offline"));
    expect(await refresh.ensure("root", undefined, update, { force: false, signal })).toEqual({
      stale: true,
    });
    await refresh.ensure("root", undefined, update, { force: false, signal });
    expect(update).toHaveBeenCalledTimes(2);
    await refresh.ensure("root", undefined, update, { force: true, signal });
    expect(update).toHaveBeenCalledTimes(3);
  });
  it.each([true, false])("restarts after the last reader cancels and ignores the old completion (force=%s)", async (force) => {
    const refresh = new OfficialPluginCatalogRefresh();
    const cancel = new AbortController();
    const waiting = Promise.withResolvers<void>();
    const started = Promise.withResolvers<AbortSignal>();
    const old = refresh.ensure("root", undefined, async (signal) => {
      started.resolve(signal);
      await waiting.promise;
      signal.throwIfAborted();
    }, { force: false, signal: cancel.signal });
    const oldSignal = await started.promise;
    const rejected = expect(old).rejects.toThrow();
    cancel.abort();
    const update = vi.fn(async (signal: AbortSignal) => signal.throwIfAborted());
    const options = { force, signal: new AbortController().signal };
    const next = refresh.ensure("root", undefined, update, options);
    try {
      await rejected;
      expect(oldSignal.aborted).toBe(true);
      expect(update).toHaveBeenCalledOnce();
      expect(await next).toEqual({ stale: false });
    } finally {
      waiting.resolve();
    }
    // 让已取消的刷新最后完成，验证它不能污染新请求写入的缓存。
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(await refresh.ensure("root", undefined, update, { ...options, force: false })).toEqual({ stale: false });
    expect(update).toHaveBeenCalledOnce();
  });
  it("one cancelled reader does not cancel another reader's refresh", async () => {
    const refresh = new OfficialPluginCatalogRefresh();
    const first = new AbortController();
    let finish!: () => void;
    const update = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const a = refresh.ensure("root", undefined, update, { force: false, signal: first.signal });
    const b = refresh.ensure("root", undefined, update, {
      force: false,
      signal: new AbortController().signal,
    });
    first.abort();
    await expect(a).rejects.toThrow();
    finish();
    expect(await b).toEqual({ stale: false });
  });
});
