import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";
import { watch } from "chokidar";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type {
  RefcountedRegistry,
  WatchedEntry,
  WatchedEntryOptions,
  WatchedLoad,
} from "./contract.js";

export type { RefcountedRegistry, WatchedEntry, WatchedEntryOptions, WatchedLoad };

/** 一次保存常产生多个 raw / all 事件；尾部去抖把它们合成一次读盘。 */
export const WATCHED_SOURCE_DEBOUNCE_MS = 300;

/**
 * 一次 bind 建立监听的总截止时间（负责人选定 1 秒）。
 * 修复前网盘响应慢时，bind 对锚点的 stat 和等 watcher ready/error 都没有上限；
 * stat 挂住或 watcher 既不就绪也不报错，条目创建与 flush 一直等，新会话创建被拖住。
 * 这是负责人决定的断路器：只决定是否继续监听，不决定配置内容（内容仍由全量读盘决定）。
 */
export const WATCH_BIND_TIMEOUT_MS = 1000;

/** stat 超时、拿不到身份的锚点在 abandoned 中的标记；bind 遇到它直接跳过，不再 stat。 */
const BIND_TIMED_OUT = "bind-timed-out";

/**
 * 在截止时间前等 start 的结果；已过截止时间就不启动。
 * 超时只是不再等：已发出的 stat 无法取消，迟到的结果被丢弃；watcher 由调用方 abort 关闭。
 */
async function beforeDeadline<T>(
  deadline: number,
  start: () => Promise<T>,
): Promise<T | typeof BIND_TIMED_OUT> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return BIND_TIMED_OUT;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<typeof BIND_TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(BIND_TIMED_OUT), remaining);
    // 定时器不拖住进程退出或测试结束。
    timer.unref?.();
  });
  try {
    return await Promise.race([start(), expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 进程级共享条目的 registry：slot、引用计数、复用时 flush、释放与强制关闭。
 * key 与 create 取自同一份 options，调用方负责去掉会话私有的闭包，避免条目持有会话作用域。
 */
export function createRefcountedRegistry<
  O,
  E extends { flush(): Promise<void>; close(): void },
  V,
>(spec: {
  label: string;
  key(options: O): string;
  create(options: O): Promise<E>;
  view(entry: E, options: O, release: () => void): V;
}): RefcountedRegistry<O, V> {
  interface Slot {
    refs: number;
    ready: Promise<E>;
    entry?: E;
  }
  const slots = new Map<string, Slot>();
  let closed = false;
  const closedError = () => new Error(`${spec.label} registry is closed`);

  function closeSlot(slot: Slot): void {
    // 已就绪的条目同步关闭，释放后不残留 watcher 句柄与定时器。
    if (slot.entry) slot.entry.close();
    else
      void slot.ready.then(
        (entry) => entry.close(),
        () => undefined,
      );
  }

  return {
    async acquire(options) {
      if (closed) throw closedError();
      const key = spec.key(options);
      const existing = slots.get(key);
      let slot = existing;
      if (!slot) {
        const created: Slot = { refs: 0, ready: spec.create(options) };
        created.ready.then(
          (entry) => {
            created.entry = entry;
          },
          // 首次加载失败只删除这个条目；等待者收到同一个错误，下一次 acquire 重新加载。
          () => {
            if (slots.get(key) === created) slots.delete(key);
          },
        );
        slots.set(key, created);
        slot = created;
      }
      const shared = slot;
      // 引用计数在任何 await 之前登记：并发释放不会提前关闭共享条目。
      shared.refs += 1;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        shared.refs -= 1;
        if (shared.refs > 0 || slots.get(key) !== shared) return;
        slots.delete(key);
        closeSlot(shared);
      };
      try {
        const entry = await shared.ready;
        // 复用的条目可能挂着去抖定时器：跳过等待立即读盘，新会话的首个快照就是磁盘最新内容。
        if (existing) await entry.flush();
        if (closed) throw closedError();
        // 读快照、建 view、订阅在同一个同步块里完成，不会漏掉之间的发布。
        return spec.view(entry, options, release);
      } catch (error) {
        release();
        throw error;
      }
    },
    close() {
      closed = true;
      for (const slot of slots.values()) closeSlot(slot);
      slots.clear();
    },
  };
}

/** 首载和后续文件事件只调用同一加载器；监听器不解析或合并内容。 */
export async function createWatchedEntry<L extends WatchedLoad>(
  options: WatchedEntryOptions<L>,
): Promise<WatchedEntry<L>> {
  const initial = await options.load();
  initial.commit();
  let current = initial;
  let files = initial.files;
  let directories = initial.directories ?? new Set<string>();
  const bounds = options.bounds.map((bound) => resolve(bound));
  const bindTimeoutMs = options.bindTimeoutMs ?? WATCH_BIND_TIMEOUT_MS;
  let closed = false;
  let dirty = false;
  let draining: Promise<void> | undefined;
  let quietTimer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  /** stable：这个 watcher 存在期间完成过一次 drain 提交，之后收到的文件事件才说明监听已恢复。 */
  const watchers = new Map<
    string,
    { controller: AbortController; identity: string; stable: boolean }
  >();
  /**
   * 锚点 → 身份：failures 记失败过一次，abandoned 记已停止监听。
   * 修复前就绪后报错立即重绑、新 watcher 又报错时没有上限（部分 Windows 网络共享路径
   * 反复报 `UNKNOWN: unknown error, watch`），drain 不结束，flush 和新会话创建被拖住。
   * 同一锚点、同一身份失败两次即停止监听；身份变化或条目重建后重新尝试。状态跟条目走。
   * bind 超时断路也记进 abandoned：stat 超时的身份记为 BIND_TIMED_OUT。
   */
  const failures = new Map<string, string>();
  const abandoned = new Map<string, string>();

  function contains(parent: string, file: string): boolean {
    const child = relative(resolve(parent), file);
    return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
  }

  function isDirectChild(directory: string, path: string): boolean {
    const child = relative(directory, path);
    return contains(directory, path) && child !== "" && !child.includes(sep);
  }

  /**
   * 文件是登记的文件或其祖先；目录条目另接受它的直接子目录。
   * 修复前只认登记的文件及其祖先，skill 根目录下新建的目录事件被丢掉。
   * 有文件类型时（chokidar 过滤）直接子文件不登记就不相关：chokidar 会给每个通过过滤的文件
   * 单独开系统句柄，不过滤时 `.DS_Store` 这类文件也会各占一个。原生事件没有文件类型，
   * 只按名字过滤：`README.md` 这类普通文件的事件会触发一次重读，结果不变。
   */
  function relevant(path: string, stats?: Stats): boolean {
    if ([...files].some((file) => contains(path, file))) return true;
    for (const directory of directories) {
      if (contains(path, directory)) return true;
      if (!isDirectChild(directory, path)) continue;
      if (stats?.isFile()) return false;
      return options.childName?.(basename(path)) ?? true;
    }
    return false;
  }

  /**
   * 目标所在的已存在目录（目录条目从自身开始）；不存在时只在包含它的最外层边界之内向上找。
   * 修复前一路向上找到已存在的目录并再监听其父目录，会监听用户目录与其上级。
   * inline 插件根目录的父目录因事务记录文件进入 files，原子 rename 仍能被发现；缓存插件只监听安装记录。
   */
  async function anchorOf(
    target: string,
    self: boolean,
    statAnchor: (anchor: string) => Promise<Stats | undefined | typeof BIND_TIMED_OUT>,
  ) {
    const bound = bounds
      .filter((candidate) => contains(candidate, target))
      .sort((left, right) => left.length - right.length)[0];
    for (let anchor = self ? target : dirname(target); ; anchor = dirname(anchor)) {
      // stat 超时断路的锚点不再 stat：网盘仍挂住时，每次读盘都会再等满一个截止时间。
      if (abandoned.get(anchor) === BIND_TIMED_OUT) return undefined;
      const info = await statAnchor(anchor);
      if (info === BIND_TIMED_OUT) return undefined;
      if (info?.isDirectory()) return { anchor, info };
      if (!bound || anchor === bound || !contains(bound, anchor) || dirname(anchor) === anchor)
        return undefined;
    }
  }

  /** 超时断路：停止监听这个锚点，不调度重绑、不算 changed；状态跟条目走，条目重建后重新尝试。 */
  function tripTimedOut(anchor: string, identity: string, started: number): void {
    // 条目已关闭时 bind 可能还在等：不再记状态和日志。
    if (closed) return;
    abandoned.set(anchor, identity);
    options.logger?.warn(`${options.label} watcher bind timed out`, {
      path: anchor,
      elapsedMs: Date.now() - started,
    });
  }

  async function bind(): Promise<boolean> {
    // 所有锚点共用一个截止时间：逐个锚点各给一份超时会随锚点数累加，一次 bind 最多只多等约 1 秒。
    const started = Date.now();
    const deadline = started + bindTimeoutMs;
    /**
     * 同一锚点每轮只 stat 一次，共用它的目标复用同一结果（项目级配置文件通常都锚在 workspace 上）。
     * 修复前逐目标 stat：慢盘上同一锚点先拿到身份、后面又超时，超时标记被下面按身份断路覆盖，
     * 之后每次 bind 都再 stat、再等满截止时间，同一锚点每轮记 2 条 warn。
     */
    const statted = new Map<string, Promise<Stats | undefined | typeof BIND_TIMED_OUT>>();
    /**
     * 截止时间已过、本轮来不及 stat 但已在监听的锚点：保留原 watcher，不断路，下一轮照常 stat。
     * 修复前一个锚点的 stat 挂住时，排在它后面、正常工作的 watcher 也被断路关闭，条目存活期间不再监听。
     */
    const kept = new Set<string>();
    const statAnchor = (anchor: string) => {
      let pending = statted.get(anchor);
      if (!pending && Date.now() >= deadline && watchers.has(anchor)) {
        kept.add(anchor);
        pending = Promise.resolve(BIND_TIMED_OUT);
        statted.set(anchor, pending);
      }
      if (!pending) {
        pending = beforeDeadline(deadline, () => stat(anchor).catch(() => undefined)).then(
          (info) => {
            if (info === BIND_TIMED_OUT) tripTimedOut(anchor, BIND_TIMED_OUT, started);
            return info;
          },
        );
        statted.set(anchor, pending);
      }
      return pending;
    };
    const wanted = new Map<string, string>();
    const targets = [
      ...[...files].map((file) => [file, false] as const),
      ...[...directories].map((directory) => [directory, true] as const),
    ];
    for (const [target, self] of targets) {
      const found = await anchorOf(target, self, statAnchor);
      if (found) wanted.set(found.anchor, `${found.info.dev}:${found.info.ino}`);
    }
    // 同一 inode 下新增声明文件也要重新订阅；更新 ignored 闭包不会让 watcher 扫描先前忽略的文件。
    for (const [anchor, identity] of wanted) {
      const covered = [...files].filter((file) => contains(anchor, file)).sort();
      const watchedDirectories = [...directories]
        .filter((directory) => contains(anchor, directory))
        .sort();
      wanted.set(
        anchor,
        `${identity}:${JSON.stringify(covered)}${
          watchedDirectories.length > 0 ? `:${JSON.stringify(watchedDirectories)}` : ""
        }`,
      );
    }
    let changed = false;
    for (const [path, watcher] of watchers) {
      if (kept.has(path)) continue;
      if (wanted.get(path) !== watcher.identity) {
        watcher.controller.abort();
        watchers.delete(path);
      }
    }
    for (const [anchor, identity] of wanted) {
      if (closed) return changed;
      // 已停止监听的身份不再建 watcher；flush 仍全量重读，新会话读到最新配置。
      if (watchers.has(anchor) || abandoned.get(anchor) === identity) continue;
      // 截止时间已过：本轮还没处理的锚点不再建 watcher，直接断路。
      if (Date.now() >= deadline) {
        tripTimedOut(anchor, identity, started);
        continue;
      }
      options.logger?.debug(`${options.label} watcher bound`, { anchor, identity });
      const controller = new AbortController();
      const record = { controller, identity, stable: false };
      watchers.set(anchor, record);
      // 原生目录 watcher 创建完成不代表文件监听已就绪。复用既有监听库的 ready 边界，
      // 再由 drain 重读，避免紧随初始化的原子替换丢失；不靠延时或轮询同步。
      const watcher = watch(anchor, {
        depth: 0,
        ignoreInitial: true,
        usePolling: false,
        followSymlinks: true,
        ignored: (path, stats) => !relevant(path, stats),
      });
      watcher.on("all", (_event, path) => invalidate(path));
      // change 会被库节流；原始事件只使来源失效，最终内容仍由同一 drain 完整读取。
      // 目录事件和文件事件的 watchedPath 不同，统一还原真实目标后再过滤。
      watcher.on("raw", (_event, path, details) => {
        const watchedPath = (details as { watchedPath?: unknown } | undefined)?.watchedPath;
        const watched = typeof watchedPath === "string" ? watchedPath : anchor;
        // 原生事件可省略 filename（例如目录溢出）；此时重读监听范围，不能把空值传给路径 API。
        invalidate(
          typeof path !== "string"
            ? watched
            : files.has(watched)
              ? watched
              : resolve(watched, path),
        );
      });
      function invalidate(path: string): void {
        if (controller.signal.aborted || !relevant(path)) return;
        // 只认稳定后的事件：每次先发一个事件再报错的目录，若在此清零会重新形成循环。
        if (record.stable) failures.delete(anchor);
        scheduleAfterQuiet();
      }
      let failed = false;
      let bound = false;
      const settled = new Promise<void>((ready) => {
        watcher.once("ready", () => {
          bound = true;
          ready();
        });
        watcher.on("error", (error) => {
          const active = !controller.signal.aborted;
          failed = true;
          if (watchers.get(anchor)?.controller === controller) watchers.delete(anchor);
          controller.abort();
          ready();
          // 已中止的 watcher 再报错不计数：同一个 watcher 连报多次只算一次失败。
          if (!active) return;
          // 就绪前、就绪后报错都计数，同一身份第二次失败即停止监听，不再调度。
          if (failures.get(anchor) === identity) {
            abandoned.set(anchor, identity);
            options.logger?.warn(`${options.label} watcher stopped after repeated failures`, {
              path: anchor,
              error: String(error),
            });
            return;
          }
          failures.set(anchor, identity);
          options.logger?.warn(`${options.label} watcher failed`, {
            path: anchor,
            error: String(error),
          });
          // 就绪后报错由下一次 drain 重新绑定；修复前只删除 watcher，之后的变化不再被发现。
          // 就绪前报错不主动调度，等下一次读盘时 bind 再试。
          if (bound) schedule();
        });
        controller.signal.addEventListener(
          "abort",
          () => {
            void watcher.close();
            ready();
          },
          { once: true },
        );
      });
      // 只等剩余时间：截止前既没就绪也没报错就关闭 watcher 并断路。
      if ((await beforeDeadline(deadline, () => settled)) === BIND_TIMED_OUT) {
        if (watchers.get(anchor) === record) watchers.delete(anchor);
        controller.abort();
        tripTimedOut(anchor, identity, started);
        continue;
      }
      changed ||= !failed;
    }
    return changed;
  }

  /**
   * 文件事件走尾部去抖：修复前每个事件都把 drain 标脏，一次保存读 2 次以上，
   * 多个会话再各读一遍。去抖只决定什么时候读，不决定状态；绑定变化与 watcher 重绑仍立即读。
   */
  function scheduleAfterQuiet(): void {
    if (closed) return;
    if (quietTimer) clearTimeout(quietTimer);
    quietTimer = setTimeout(() => {
      quietTimer = undefined;
      schedule();
    }, WATCHED_SOURCE_DEBOUNCE_MS);
    quietTimer.unref?.();
  }

  function schedule(): void {
    if (closed) return;
    dirty = true;
    draining ??= (async () => {
      while (dirty && !closed) {
        dirty = false;
        try {
          const loaded = await options.load();
          files = loaded.files;
          directories = loaded.directories ?? new Set<string>();
          // 关闭可能发生在读取期间；迟到结果既不能发布，也不能重新创建监听资源。
          if (closed) continue;
          if (await bind()) dirty = true;
          if (closed || dirty) continue;
          loaded.commit();
          current = loaded;
          for (const watcher of watchers.values()) watcher.stable = true;
          // 每个 view 各自整形并按内容去重；一个 view 出错不影响其他 view。
          // 遍历副本：回调里关闭 view 不能跳过其余 view。
          for (const listener of Array.from(listeners)) {
            try {
              listener();
            } catch (error) {
              options.logger?.warn(`${options.label} view refresh failed`, {
                error: String(error),
              });
            }
          }
        } catch (error) {
          options.logger?.warn(`${options.label} refresh failed`, { error: String(error) });
        }
      }
    })().finally(() => {
      draining = undefined;
      if (dirty && !closed) schedule();
    });
  }

  async function flush(): Promise<void> {
    if (closed) return;
    if (quietTimer) clearTimeout(quietTimer);
    quietTimer = undefined;
    schedule();
    // finally 可能已启动下一轮 drain；修复前只等一次，会在新一轮采纳前返回旧快照。
    while (draining) await draining;
  }

  await bind();
  await flush();
  return {
    current: () => current,
    listen(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    flush,
    close() {
      closed = true;
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = undefined;
      for (const watcher of watchers.values()) watcher.controller.abort();
      watchers.clear();
      listeners.clear();
    },
  };
}
