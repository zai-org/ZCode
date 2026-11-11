import { useCallback, useEffect, useMemo } from "react";
import { getPathLeaf } from "@/lib/path.js";
import { logger } from "@/logger.js";
import { getExtensionSlotsStore } from "@/extension-slots/app/extensionSlotsStore.js";
import { useExtensionsService } from "@/extension-slots/adapters/useExtensionSlots.js";
import { selectFileViewer } from "@/extension-slots/domain/slotSelectors.js";
import type { FileViewerRouter } from "@/extension-slots/contract.js";

/** 冲突日志的去重键：每份静态表（rev）对同一组插件只记一次。 */
const loggedConflicts = new Set<string>();

/**
 * file.viewer 的查找入口（docs/plugins/extension-host.md §16.5），给打开文件的路由调用。
 * 不订阅渲染：调用方是 App 级的面板 hook，贡献表增量（流式期间每秒最多 2 次）不能让它重渲染。
 * 所以在调用时读 store 的最近一份；挂载期间保持订阅（retain），store 才有数据。
 * 没有扩展门面（Web、手机远控）时总是返回 null。
 */
export function useFileViewerRouter({
  workspacePath,
  workspaceIdentity,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
}): FileViewerRouter {
  const service = useExtensionsService();
  const entry = useMemo(() => (service ? getExtensionSlotsStore(service) : null), [service]);
  useEffect(() => entry?.retain(), [entry]);
  return useCallback(
    (path: string) => {
      if (!entry) return null;
      const sources = entry.store.getState();
      const workspace = {
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      };
      const match = selectFileViewer(sources, getPathLeaf(path), workspace);
      if (!match) return null;
      if (match.others.length > 0) {
        const key = `${sources.table?.rev ?? 0}:${[match.route.pluginId, ...match.others].join(",")}`;
        if (!loggedConflicts.has(key)) {
          loggedConflicts.add(key);
          logger.lifecycle.warn("[extension-slots] file viewer conflict", {
            path,
            winner: match.route.pluginId,
            others: match.others,
          });
        }
      }
      return match.route;
    },
    [entry, workspaceIdentity, workspacePath],
  );
}
