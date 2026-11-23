import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@zcode/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  WATCH_BIND_TIMEOUT_MS,
  createRefcountedRegistry,
  createWatchedEntry,
  type WatchedEntry,
  type WatchedLoad,
} from "../src/watch/watched-source.js";

/**
 * 修复前就绪后报错立即重绑、新 watcher 又报错时无上限循环，flush 等不到 drain 结束，
 * 新会话创建被拖住（Windows 网络共享路径反复报 `UNKNOWN: unknown error, watch`）。
 * mock 按用例配置让 watcher 在就绪前或就绪后报错。
 *
 * 修复前网盘响应慢时，bind 等锚点 stat 和 watcher ready/error 都没有上限：
 * watcher 既不就绪也不报错（"never"），或 stat 挂住（hungStats），条目创建一直不返回。
 * slowStats 模拟网盘慢但没挂住：多个目标共用一个锚点时，逐目标 stat 的累计等待会超过截止时间。
 */
type Behavior = "ok" | "never" | "error-before-ready" | "error-after-ready" | "event-then-error";

const state = vi.hoisted(() => ({
  behavior: "ok" as Behavior,
  watchers: [] as Array<EventEmitter & { anchor: string; closed: boolean }>,
  /** 路径 → 放行几次后挂住（0 为一开始就挂住）；挂住的 stat 等用例调用 releaseStats。 */
  hungStats: new Map<string, number>(),
  /** 路径 → 每次 stat 延迟的毫秒数。 */
  slowStats: new Map<string, number>(),
  /** 挂住的 stat：放行时用真实 stat 结果兑现，模拟网盘迟到的响应。 */
  pendingStats: [] as Array<() => void>,
  statCalls: [] as string[],
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: (path: string) => {
      state.statCalls.push(path);
      const calls = state.statCalls.filter((called) => called === path).length;
      const passes = state.hungStats.get(path);
      if (passes !== undefined && calls > passes)
        return new Promise((resolve, reject) => {
          state.pendingStats.push(() => actual.stat(path).then(resolve, reject));
        });
      const delay = state.slowStats.get(path);
      if (delay === undefined) return actual.stat(path);
      return new Promise((resolve) => setTimeout(resolve, delay)).then(() => actual.stat(path));
    },
  };
});
vi.mock("chokidar", () => ({
  watch: (anchor: string) => {
    const watcher = Object.assign(new EventEmitter(), {
      anchor,
      closed: false,
      close: vi.fn(async () => {
        watcher.closed = true;
      }),
    });
    state.watchers.push(watcher);
    const behavior = state.behavior;
    if (behavior === "never") return watcher;
    const fail = () => watcher.emit("error", watchFailure());
    if (behavior === "error-before-ready") {
      queueMicrotask(fail);
      return watcher;
    }
    queueMicrotask(() => {
      watcher.emit("ready");
      // 每次先发一个有效事件再报错：watcher 还没稳定，事件不能清零失败记录。
      if (behavior === "event-then-error")
        watcher.emit("raw", "change", CONFIG_NAME, { watchedPath: anchor });
    });
    if (behavior !== "ok") setImmediate(fail);
    return watcher;
  },
}));

const CONFIG_NAME = "config.json";
const STOP_MESSAGE = "MCP configuration watcher stopped after repeated failures";
const TIMEOUT_MESSAGE = "MCP configuration watcher bind timed out";
/** 注入的短截止时间，让用例快；默认值另有一个用例按生产配置验证。 */
const SHORT_BIND_TIMEOUT_MS = 200;
/** 测试判定用的有限等待：修复前条目创建或 flush 不会结束。 */
const SETTLE_LIMIT_MS = 2_000;

type Loaded = WatchedLoad & { value: string };

let root: string;
let config: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "watched-source-failures-"));
  config = join(root, CONFIG_NAME);
  await writeFile(config, "v1");
  state.behavior = "ok";
  state.watchers = [];
  state.hungStats.clear();
  state.slowStats.clear();
  state.pendingStats = [];
  state.statCalls = [];
});
afterEach(async () => {
  state.behavior = "ok";
  state.hungStats.clear();
  releaseStats();
  await rm(root, { recursive: true, force: true });
});

function releaseStats(): void {
  for (const release of state.pendingStats.splice(0)) release();
}

function watchFailure(): Error {
  return Object.assign(new Error("UNKNOWN: unknown error, watch"), { code: "UNKNOWN" });
}

function loggerOf() {
  const warn = vi.fn();
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
    child: () => logger,
  };
  return { logger, warn };
}

function load(): Promise<Loaded> {
  return readFile(config, "utf8").then((value) => ({
    value,
    files: new Set([config]),
    commit: () => {},
  }));
}

function anchored(anchor: string) {
  return state.watchers.filter((watcher) => watcher.anchor === anchor);
}

async function settlesWithin<T>(promise: Promise<T>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), SETTLE_LIMIT_MS);
  });
  try {
    return await Promise.race([promise.then(() => true), limit]);
  } finally {
    clearTimeout(timer);
  }
}

it.each(["error-after-ready", "event-then-error"] as const)(
  "stops rebinding after two failures (%s) so entry creation and flush return",
  async (behavior) => {
    state.behavior = behavior;
    const { logger, warn } = loggerOf();
    const pending = (async () => {
      const entry = await createWatchedEntry({
        load,
        bounds: [root],
        label: "MCP configuration",
        logger,
      });
      await entry.flush();
      return entry;
    })();
    try {
      expect(await settlesWithin(pending)).toBe(true);
      const entry = await pending;
      const watchers = state.watchers.length;
      // 第一次就绪后报错重绑一次，第二次停止：恰好 2 个，失败一次就停的退化也会被拦下。
      expect(watchers).toBe(2);
      // 停止监听后 flush 仍全量重读：新会话读到最新配置，且不再新建 watcher。
      await writeFile(config, "v2");
      await entry.flush();
      expect(entry.current().value).toBe("v2");
      expect(state.watchers).toHaveLength(watchers);
      expect(warn).toHaveBeenCalledWith(STOP_MESSAGE, expect.objectContaining({ path: root }));
    } finally {
      // 修复前的循环要等后续 watcher 成功才收敛；放开后再关闭条目，不把循环留给后面的用例。
      state.behavior = "ok";
      (await pending).close();
    }
  },
);

it("stops after two failures before ready and later flushes create no watcher", async () => {
  state.behavior = "error-before-ready";
  const { logger, warn } = loggerOf();
  const entry = await createWatchedEntry({
    load,
    bounds: [root],
    label: "MCP configuration",
    logger,
  });
  try {
    expect(anchored(root)).toHaveLength(2);
    expect(warn).toHaveBeenCalledWith(STOP_MESSAGE, expect.objectContaining({ path: root }));
    // 修复前就绪前报错虽不调度，但每次读盘都重建一个必然失败的 watcher。
    await entry.flush();
    await entry.flush();
    expect(anchored(root)).toHaveLength(2);
  } finally {
    entry.close();
  }
});

it("recovers from a single failure once the stable watcher saw a file event", async () => {
  const { logger, warn } = loggerOf();
  const entry = await createWatchedEntry({
    load,
    bounds: [root],
    label: "MCP configuration",
    logger,
  });
  try {
    const first = state.watchers.at(-1)!;
    first.emit("error", watchFailure());
    await entry.flush();
    const second = state.watchers.at(-1)!;
    expect(second).not.toBe(first);
    expect(second.closed).toBe(false);

    // 经历过一次读盘提交后收到有效事件，说明监听已恢复，失败记录清零。
    second.emit("raw", "change", CONFIG_NAME, { watchedPath: root });
    second.emit("error", watchFailure());
    await entry.flush();
    const third = state.watchers.at(-1)!;
    expect(third).not.toBe(second);
    expect(third.closed).toBe(false);
    expect(warn).not.toHaveBeenCalledWith(STOP_MESSAGE, expect.anything());

    // 没有事件就再次报错，算同一身份的第二次失败。
    third.emit("error", watchFailure());
    await entry.flush();
    expect(state.watchers.at(-1)).toBe(third);
    expect(warn).toHaveBeenCalledWith(STOP_MESSAGE, expect.objectContaining({ path: root }));
  } finally {
    entry.close();
  }
});

it("watches a recreated directory again after its old identity stopped", async () => {
  state.behavior = "error-before-ready";
  const skills = join(root, "skills");
  await mkdir(skills);
  const entry = await createWatchedEntry({
    load: async () => ({ files: new Set<string>(), directories: new Set([skills]), commit() {} }),
    bounds: [root],
    childName: () => true,
    label: "Skill catalog",
  });
  try {
    expect(anchored(skills)).toHaveLength(2);
    // 先建新目录再替换，保证 inode 不同；删除后立即重建可能复用同一个 inode。
    const replacement = join(root, "skills.next");
    await mkdir(replacement);
    await rm(skills, { recursive: true });
    await rename(replacement, skills);
    state.behavior = "ok";
    await entry.flush();
    expect(anchored(skills)).toHaveLength(3);
    expect(anchored(skills).at(-1)!.closed).toBe(false);
  } finally {
    entry.close();
  }
});

it("retries watching after every view is released and the entry is created again", async () => {
  state.behavior = "error-before-ready";
  const { logger } = loggerOf();
  const registry = createRefcountedRegistry<
    { root: string },
    WatchedEntry<Loaded>,
    { entry: WatchedEntry<Loaded>; release: () => void }
  >({
    label: "MCP configuration",
    key: (options) => options.root,
    create: () => createWatchedEntry({ load, bounds: [root], label: "MCP configuration", logger }),
    view: (entry, _options, release) => ({ entry, release }),
  });
  try {
    const first = await registry.acquire({ root });
    expect(anchored(root)).toHaveLength(2);

    // 复用条目时 flush 仍全量重读：停止监听的目录，新会话也读到最新配置。
    await writeFile(config, "v2");
    const second = await registry.acquire({ root });
    expect(second.entry).toBe(first.entry);
    expect(second.entry.current().value).toBe("v2");
    expect(anchored(root)).toHaveLength(2);

    // 失败记录跟随条目；最后一个 view 释放后条目关闭，重建时重新尝试监听。
    first.release();
    second.release();
    state.behavior = "ok";
    const third = await registry.acquire({ root });
    expect(third.entry).not.toBe(first.entry);
    expect(anchored(root)).toHaveLength(3);
    expect(anchored(root).at(-1)!.closed).toBe(false);
    third.release();
  } finally {
    registry.close();
  }
});

/** 计时等条目创建；修复前不会返回，有限等待判定失败，不把挂住的条目留给后面的用例。 */
async function timedCreate(options: Parameters<typeof createWatchedEntry<Loaded>>[0]) {
  const started = performance.now();
  const pending = createWatchedEntry(options).then((entry) => ({
    entry,
    elapsed: performance.now() - started,
  }));
  expect(await settlesWithin(pending)).toBe(true);
  return pending;
}

it("trips the breaker when a watcher never becomes ready within the default deadline", async () => {
  state.behavior = "never";
  const { logger, warn } = loggerOf();
  const { entry, elapsed } = await timedCreate({
    load,
    bounds: [root],
    label: "MCP configuration",
    logger,
  });
  try {
    // 生产不注入：一次绑定最多多等约 1 秒。
    expect(elapsed).toBeGreaterThanOrEqual(WATCH_BIND_TIMEOUT_MS - 50);
    expect(elapsed).toBeLessThan(WATCH_BIND_TIMEOUT_MS * 2);
    expect(warn).toHaveBeenCalledWith(TIMEOUT_MESSAGE, expect.objectContaining({ path: root }));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(anchored(root)).toHaveLength(1);
    expect(anchored(root)[0]!.closed).toBe(true);

    // 断路后 flush 不再建 watcher，仍全量重读：新会话读到最新配置。
    await writeFile(config, "v2");
    await entry.flush();
    expect(entry.current().value).toBe("v2");
    expect(anchored(root)).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
  } finally {
    entry.close();
  }
});

it("trips the breaker when stat of an anchor hangs and never stats it again", async () => {
  state.hungStats.set(root, 0);
  const { logger, warn } = loggerOf();
  const { entry, elapsed } = await timedCreate({
    load,
    bounds: [root],
    label: "MCP configuration",
    logger,
    bindTimeoutMs: SHORT_BIND_TIMEOUT_MS,
  });
  try {
    expect(elapsed).toBeLessThan(SHORT_BIND_TIMEOUT_MS * 2);
    expect(warn).toHaveBeenCalledWith(TIMEOUT_MESSAGE, expect.objectContaining({ path: root }));
    expect(state.statCalls.filter((path) => path === root)).toHaveLength(1);
    expect(state.watchers).toHaveLength(0);

    // 迟到的 stat 结果被丢弃；之后的绑定跳过超时标记的锚点，不再 stat、不建 watcher。
    releaseStats();
    await writeFile(config, "v2");
    await entry.flush();
    expect(entry.current().value).toBe("v2");
    expect(state.statCalls.filter((path) => path === root)).toHaveLength(1);
    expect(state.watchers).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
  } finally {
    entry.close();
  }
});

it("bounds the total wait by one deadline when several anchors hang", async () => {
  state.behavior = "never";
  const names = ["a", "b", "c", "d", "e"];
  const skills = names.map((name) => join(root, name));
  for (const directory of skills) await mkdir(directory);
  const { logger, warn } = loggerOf();
  const { entry, elapsed } = await timedCreate({
    load: async () => ({
      value: "",
      files: new Set<string>(),
      directories: new Set(skills),
      commit() {},
    }),
    bounds: [root],
    childName: () => true,
    label: "MCP configuration",
    logger,
    bindTimeoutMs: SHORT_BIND_TIMEOUT_MS,
  });
  try {
    // 所有锚点共用一个截止时间：总等待不随锚点数累加（5 个锚点逐个等满会是 5 倍）。
    expect(elapsed).toBeLessThan(SHORT_BIND_TIMEOUT_MS * 2);
    for (const directory of skills)
      expect(warn).toHaveBeenCalledWith(
        TIMEOUT_MESSAGE,
        expect.objectContaining({ path: directory }),
      );
    expect(warn).toHaveBeenCalledTimes(skills.length);
    expect(state.watchers.every((watcher) => watcher.closed)).toBe(true);

    const created = state.watchers.length;
    await entry.flush();
    expect(state.watchers).toHaveLength(created);
  } finally {
    entry.close();
  }
});

it("keeps live updates for directories that bind before the deadline", async () => {
  const { logger, warn } = loggerOf();
  const { entry } = await timedCreate({
    load,
    bounds: [root],
    label: "MCP configuration",
    logger,
    bindTimeoutMs: SHORT_BIND_TIMEOUT_MS,
  });
  try {
    const watcher = anchored(root).at(-1)!;
    expect(watcher.closed).toBe(false);
    const refreshed = new Promise<void>((resolve) => entry.listen(resolve));
    await writeFile(config, "v2");
    watcher.emit("raw", "change", CONFIG_NAME, { watchedPath: root });
    expect(await settlesWithin(refreshed)).toBe(true);
    expect(entry.current().value).toBe("v2");
    expect(anchored(root)).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  } finally {
    entry.close();
  }
});

it("keeps healthy watchers that the deadline skipped when another anchor's stat hangs", async () => {
  const slow = join(root, "a");
  const healthy = join(root, "b");
  for (const directory of [slow, healthy]) await mkdir(directory);
  const { logger, warn } = loggerOf();
  const { entry } = await timedCreate({
    load: async () => ({
      value: "",
      files: new Set<string>(),
      directories: new Set([slow, healthy]),
      commit() {},
    }),
    bounds: [root],
    childName: () => true,
    label: "MCP configuration",
    logger,
    bindTimeoutMs: SHORT_BIND_TIMEOUT_MS,
  });
  try {
    expect(anchored(slow)).toHaveLength(1);
    expect(anchored(healthy)).toHaveLength(1);
    // 两个目录都已稳定监听后，a 的 stat 开始挂住；a 排在 b 前面，b 本轮来不及 stat。
    state.hungStats.set(slow, state.statCalls.filter((path) => path === slow).length);
    await entry.flush();
    // 修复前截止时间一过，b 也被断路、正常的 watcher 被关掉，之后不再监听。
    expect(anchored(slow)[0]!.closed).toBe(true);
    expect(anchored(healthy)).toHaveLength(1);
    expect(anchored(healthy)[0]!.closed).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(TIMEOUT_MESSAGE, expect.objectContaining({ path: slow }));

    // 下一轮：卡住的 a 不再 stat，b 照常 stat 并继续监听。
    await entry.flush();
    expect(anchored(healthy)).toHaveLength(1);
    expect(anchored(healthy)[0]!.closed).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  } finally {
    entry.close();
  }
});

/** 登记同一目录下的多个配置文件：它们都锚在 root 上（项目级配置文件通常都锚在 workspace 上）。 */
function loadSharingAnchor(): Promise<Loaded> {
  return load().then((loaded) => ({
    ...loaded,
    files: new Set([config, join(root, "b.json"), join(root, "c.json"), join(root, "d.json")]),
  }));
}

function rootStats(): number {
  return state.statCalls.filter((path) => path === root).length;
}

it("stats a shared anchor once per bind so a slow but healthy directory keeps watching", async () => {
  // 单次 stat 小于截止时间，4 个目标逐个 stat 的累计等待超过截止时间。
  state.slowStats.set(root, SHORT_BIND_TIMEOUT_MS * 0.3);
  const { logger, warn } = loggerOf();
  const { entry } = await timedCreate({
    load: loadSharingAnchor,
    bounds: [root],
    label: "MCP configuration",
    logger,
    bindTimeoutMs: SHORT_BIND_TIMEOUT_MS,
  });
  try {
    // 修复前同一锚点逐目标 stat，第 4 次超时，健康的目录被断路。
    expect(warn).not.toHaveBeenCalled();
    expect(anchored(root)).toHaveLength(1);
    expect(anchored(root)[0]!.closed).toBe(false);
    const before = rootStats();
    await entry.flush();
    expect(rootStats()).toBe(before + 1);
    expect(anchored(root)).toHaveLength(1);
    expect(anchored(root)[0]!.closed).toBe(false);
  } finally {
    entry.close();
  }
});

it("trips a shared anchor once when its stat hangs after succeeding and never stats it again", async () => {
  // 第一次 stat 成功，之后挂住。
  state.hungStats.set(root, 1);
  const { logger, warn } = loggerOf();
  const { entry, elapsed } = await timedCreate({
    load: loadSharingAnchor,
    bounds: [root],
    label: "MCP configuration",
    logger,
    bindTimeoutMs: SHORT_BIND_TIMEOUT_MS,
  });
  try {
    // 修复前同一轮里先拿到身份、后又超时，超时标记被身份覆盖：同一锚点记 2 条 warn，
    // 下一次绑定再 stat、再等满截止时间，条目创建等 2 个截止时间。
    expect(elapsed).toBeLessThan(SHORT_BIND_TIMEOUT_MS * 2);
    expect(warn).toHaveBeenCalledWith(TIMEOUT_MESSAGE, expect.objectContaining({ path: root }));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(state.watchers.every((watcher) => watcher.closed)).toBe(true);

    // 断路后 flush 不再 stat 这个锚点，也不再等截止时间；仍全量重读。
    const stats = rootStats();
    const watchers = state.watchers.length;
    releaseStats();
    await writeFile(config, "v2");
    const started = performance.now();
    await entry.flush();
    expect(performance.now() - started).toBeLessThan(SHORT_BIND_TIMEOUT_MS);
    expect(entry.current().value).toBe("v2");
    expect(rootStats()).toBe(stats);
    expect(state.watchers).toHaveLength(watchers);
    expect(warn).toHaveBeenCalledTimes(1);
  } finally {
    entry.close();
  }
});
