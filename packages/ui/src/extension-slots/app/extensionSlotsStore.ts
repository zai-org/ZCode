import { createStore, type StoreApi } from "zustand/vanilla";
import {
  applyContributionMessage,
  type ContributionSnapshot,
  type ExtensionStaticTable,
} from "@zcode/shared/extension-host";
import type { ExtensionsContributionsMessage, IExtensionsService } from "@zcode/services";
import { logger } from "@/logger.js";
import type { ExtensionSlotsSources } from "@/extension-slots/contract.js";

// Renderer 侧只持三份数据的最近一份（docs/plugins/extension-host.md §3.4、§16.1）：
// - 静态表（owner：Window Host）：按 rev 整份替换。
// - 贡献表快照（owner：扩展进程）：按 gen/rev 整份替换，增量只用来更新这份快照，旧代际与过期 rev 丢弃。
// - 扩展进程状态（owner：Main）：整份替换。
// 每个 IExtensionsService 一份 store；第一个使用者订阅服务事件，最后一个释放时退订。

export type ExtensionSlotsState = ExtensionSlotsSources;

const EMPTY_STATE: ExtensionSlotsState = { table: null, snapshot: null, status: null };

export interface ExtensionSlotsStore {
  readonly store: StoreApi<ExtensionSlotsState>;
  /** 返回释放函数；引用计数归零时退订。 */
  retain(): () => void;
}

const stores = new WeakMap<IExtensionsService, ExtensionSlotsStore>();

export function reduceContributionsMessage(
  current: ContributionSnapshot | null,
  message: Exclude<ExtensionsContributionsMessage, { kind: "static" }>,
): ContributionSnapshot | null | undefined {
  if (message.kind === "detached") return null;
  // undefined 表示丢弃（保持原状态）。
  return applyContributionMessage(current, message) ?? undefined;
}

/**
 * 静态表的合入规则：每次订阅的第一份整份替换（它是 Window Host 的当前值）；之后只接受 rev 更大的。
 * undefined 表示丢弃。
 */
export function reduceStaticTable(
  current: ExtensionStaticTable | null,
  next: ExtensionStaticTable,
  firstOfSubscription: boolean,
): ExtensionStaticTable | undefined {
  if (firstOfSubscription || !current || next.rev > current.rev) return next;
  return undefined;
}

export function getExtensionSlotsStore(service: IExtensionsService): ExtensionSlotsStore {
  const existing = stores.get(service);
  if (existing) return existing;
  const store = createStore<ExtensionSlotsState>(() => EMPTY_STATE);
  let refs = 0;
  let subscriptions: Array<{ dispose(): void }> = [];
  const entry: ExtensionSlotsStore = {
    store,
    retain() {
      refs += 1;
      if (refs === 1) {
        let firstTable = true;
        subscriptions = [
          service.onDynamicContributions(undefined)((message) => {
            if (message.kind === "static") {
              const table = reduceStaticTable(store.getState().table, message.table, firstTable);
              firstTable = false;
              if (!table) return;
              // 静态表只在插件清单变化与重新加载时重读，频率低。
              logger.lifecycle.info("[extension-slots] static table", {
                rev: table.rev,
                plugins: table.plugins.length,
                items: table.plugins.reduce((count, plugin) => count + plugin.slotItems.length, 0),
              });
              store.setState({ table });
              return;
            }
            const next = reduceContributionsMessage(store.getState().snapshot, message);
            if (next === undefined) return;
            if (message.kind !== "delta") {
              // 快照与断开只在状态变化时出现，频率低；增量（流式期间每秒最多 2 次）不记日志。
              logger.lifecycle.info(
                "[extension-slots] contributions",
                next
                  ? { gen: next.gen, rev: next.rev, extensions: next.extensions.length }
                  : "detached",
              );
            }
            store.setState({ snapshot: next });
          }),
          service.onDynamicHostStatus(undefined)((status) => {
            logger.lifecycle.info("[extension-slots] host status", status);
            store.setState({ status });
          }),
        ];
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        refs -= 1;
        if (refs > 0) return;
        for (const subscription of subscriptions) subscription.dispose();
        subscriptions = [];
        store.setState(EMPTY_STATE);
      };
    },
  };
  stores.set(service, entry);
  return entry;
}
