import { useEffect, useMemo } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { useShallow } from "zustand/react/shallow";
import {
  getExtensionLogsStore,
  type ExtensionLogsState,
} from "@/extension-slots/app/extensionLogsStore.js";
import { useExtensionsService } from "@/extension-slots/adapters/useExtensionSlots.js";
import type { ExtensionLogsModel } from "@/extension-slots/contract.js";

/** 没有扩展门面（Web、手机远控）时用的空 store：hook 照常调用，结果为空。 */
const EMPTY_STORE = createStore<ExtensionLogsState>(() => ({ entries: [], loaded: false }));

/**
 * 扩展日志标签的渲染模型（docs/plugins/extension-host.md §16.8）：挂载时订阅 Renderer 日志 store，
 * 卸载时释放。没有扩展门面时为 null。
 */
export function useExtensionLogs(): ExtensionLogsModel | null {
  const service = useExtensionsService();
  const entry = service ? getExtensionLogsStore(service) : null;
  useEffect(() => entry?.retain(), [entry]);
  const { entries, loaded } = useStore(
    entry?.store ?? EMPTY_STORE,
    useShallow((state) => ({ entries: state.entries, loaded: state.loaded })),
  );
  return useMemo(
    () => (entry ? { entries, loaded, clear: entry.clear } : null),
    [entries, entry, loaded],
  );
}
