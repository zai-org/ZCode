import { createStore, type StoreApi } from "zustand/vanilla";
import type { ExtensionGrantsSnapshot } from "@zcode/shared/extension-host";
import type { IExtensionGrantsService } from "@zcode/services";
import { logger } from "@/logger.js";

// Renderer 侧只持授权状态的最近一份（docs/plugins/extension-host.md §17.7）。owner 是 Window Host 的
// extensions-service（grants.json）：每次订阅的第一份整份替换，之后只接受 rev 更大的。
// 每个 IExtensionGrantsService 一份 store；第一个使用者订阅，最后一个释放时退订。

export interface ExtensionGrantsState {
  snapshot: ExtensionGrantsSnapshot | null;
}

const EMPTY_STATE: ExtensionGrantsState = { snapshot: null };

export interface ExtensionGrantsStore {
  readonly store: StoreApi<ExtensionGrantsState>;
  /** 返回释放函数；引用计数归零时退订。 */
  retain(): () => void;
}

const stores = new WeakMap<IExtensionGrantsService, ExtensionGrantsStore>();

export function getExtensionGrantsStore(service: IExtensionGrantsService): ExtensionGrantsStore {
  const existing = stores.get(service);
  if (existing) return existing;
  const store = createStore<ExtensionGrantsState>(() => EMPTY_STATE);
  let refs = 0;
  let subscription: { dispose(): void } | null = null;
  const entry: ExtensionGrantsStore = {
    store,
    retain() {
      refs += 1;
      if (refs === 1) {
        let first = true;
        subscription = service.onDynamicGrants(undefined)((snapshot) => {
          const current = store.getState().snapshot;
          if (!first && current && snapshot.rev <= current.rev) return;
          first = false;
          // 授权状态只在授权、撤销、插件清单变化时更新，频率低。只记数量，不记插件名。
          logger.lifecycle.info("[extension-slots] grants", {
            rev: snapshot.rev,
            plugins: snapshot.plugins.length,
            needsConsent: snapshot.plugins.filter((plugin) => plugin.status === "needs-consent")
              .length,
          });
          store.setState({ snapshot });
        });
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        refs -= 1;
        if (refs > 0) return;
        subscription?.dispose();
        subscription = null;
        store.setState(EMPTY_STATE);
      };
    },
  };
  stores.set(service, entry);
  return entry;
}
