import { createStore, type StoreApi } from "zustand/vanilla";
import type { ExtensionLogEntry, ExtensionLogsSnapshot } from "@zcode/shared/extension-host";
import type { IExtensionsService } from "@zcode/services";
import { logger } from "@/logger.js";
import { appendExtensionLogs } from "@/extension-slots/domain/logSelectors.js";

// Renderer 的扩展日志 store（docs/plugins/extension-host.md §16.8）。缓冲的唯一 owner 是 Main 的监管器，
// 这里只持它的最近投影：
// 1. 先订阅 onDynamicLogs，再 getLogs({}) 取整份快照；取快照期间到达的批次排队，回包后按 seq 去重合入。
// 2. 批次的首条正好是 lastSeq + 1 就追加；更大说明中间缺了（例如 Window Host 重连），
//    丢弃这一批并 getLogs({ sinceSeq: lastSeq }) 补齐（回包里含这一批）。回包为准：被缓冲挤掉的条目不再补。
// 3. 取快照失败时丢弃排队的批次，下一批到达时再取。不用定时重试。
// 每个 IExtensionsService 一份 store：第一个日志标签挂载时订阅，最后一个卸载时退订。

export interface ExtensionLogsState {
  /** 按 seq 升序，最多 EXTENSION_LOG_BUFFER_LIMIT 条，不含已清空的部分。 */
  entries: ExtensionLogEntry[];
  /** 首次快照已到。 */
  loaded: boolean;
}

export interface ExtensionLogsStore {
  readonly store: StoreApi<ExtensionLogsState>;
  /** 返回释放函数；引用计数归零时退订并丢弃条目。 */
  retain(): () => void;
  /** 只清视图：记下当前最后的 seq，之后只保留更新的条目。跨 retain 保留，直到 Renderer 重载。 */
  clear(): void;
}

const EMPTY_STATE: ExtensionLogsState = { entries: [], loaded: false };

const stores = new WeakMap<IExtensionsService, ExtensionLogsStore>();

export function getExtensionLogsStore(service: IExtensionsService): ExtensionLogsStore {
  const existing = stores.get(service);
  if (existing) return existing;
  const store = createStore<ExtensionLogsState>(() => EMPTY_STATE);
  let refs = 0;
  let subscription: { dispose(): void } | null = null;
  /** 已合入的最后 seq；null 表示还没有快照。 */
  let lastSeq: number | null = null;
  /** 「清空」时的 seq。seq 在 Main 的生命周期内单调递增，所以跨 retain 仍然有效。 */
  let clearedThroughSeq = 0;
  let fillInFlight = false;
  let queued: ExtensionLogEntry[][] = [];
  /** 每次订阅一代：释放后到达的回包丢弃。 */
  let epoch = 0;

  const keepVisible = (entries: readonly ExtensionLogEntry[]) =>
    entries.filter((entry) => entry.seq > clearedThroughSeq);

  const receive = (batch: ExtensionLogEntry[]) => {
    if (fillInFlight || lastSeq === null) {
      queued.push(batch);
      if (!fillInFlight) fill();
      return;
    }
    const since = lastSeq;
    const fresh = batch.filter((entry) => entry.seq > since);
    if (fresh.length === 0) return;
    if (fresh[0]!.seq !== since + 1) {
      // 不连续：中间的条目没收到（Window Host 重连期间 Main 不推）。补齐回包里含这一批。
      logger.lifecycle.info("[extension-slots] logs gap; filling", {
        lastSeq: since,
        nextSeq: fresh[0]!.seq,
      });
      fill();
      return;
    }
    lastSeq = fresh[fresh.length - 1]!.seq;
    const visible = keepVisible(fresh);
    if (visible.length > 0) {
      store.setState((state) => ({ entries: appendExtensionLogs(state.entries, visible) }));
    }
  };

  const applySnapshot = (since: number | null, snapshot: ExtensionLogsSnapshot) => {
    if (since === null) {
      store.setState({
        entries: appendExtensionLogs([], keepVisible(snapshot.entries)),
        loaded: true,
      });
      // 快照只在打开标签与补齐时取，频率低。
      logger.lifecycle.info("[extension-slots] logs snapshot", {
        entries: snapshot.entries.length,
        lastSeq: snapshot.lastSeq,
      });
    } else {
      const visible = keepVisible(snapshot.entries.filter((entry) => entry.seq > since));
      if (visible.length > 0) {
        store.setState((state) => ({ entries: appendExtensionLogs(state.entries, visible) }));
      }
      logger.lifecycle.info("[extension-slots] logs filled", {
        sinceSeq: since,
        entries: snapshot.entries.length,
        lastSeq: snapshot.lastSeq,
      });
    }
    lastSeq = Math.max(since ?? 0, snapshot.lastSeq);
  };

  function fill() {
    if (fillInFlight) return;
    fillInFlight = true;
    const since = lastSeq;
    const myEpoch = epoch;
    service.getLogs(since === null ? {} : { sinceSeq: since }).then(
      (snapshot) => {
        if (myEpoch !== epoch) return;
        fillInFlight = false;
        applySnapshot(since, snapshot);
        const pending = queued;
        queued = [];
        for (const batch of pending) receive(batch);
      },
      (error: unknown) => {
        if (myEpoch !== epoch) return;
        fillInFlight = false;
        // 回包会带全部条目，排队的批次没有用了；下一批到达时再取。
        queued = [];
        logger.lifecycle.warn("[extension-slots] logs snapshot failed", {
          sinceSeq: since,
          message: error instanceof Error ? error.message : String(error),
        });
      },
    );
  }

  const entry: ExtensionLogsStore = {
    store,
    retain() {
      refs += 1;
      if (refs === 1) {
        epoch += 1;
        // 先订阅再取快照：取快照期间的批次排队，不会漏。
        subscription = service.onDynamicLogs(undefined)(receive);
        fill();
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        refs -= 1;
        if (refs > 0) return;
        subscription?.dispose();
        subscription = null;
        epoch += 1;
        lastSeq = null;
        fillInFlight = false;
        queued = [];
        store.setState(EMPTY_STATE);
      };
    },
    clear() {
      const entries = store.getState().entries;
      clearedThroughSeq = Math.max(
        clearedThroughSeq,
        lastSeq ?? 0,
        entries[entries.length - 1]?.seq ?? 0,
      );
      store.setState({ entries: [] });
    },
  };
  stores.set(service, entry);
  return entry;
}
