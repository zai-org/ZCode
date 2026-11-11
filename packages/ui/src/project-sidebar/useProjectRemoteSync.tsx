import { useCallback } from "react";
import { RefreshCw } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import {
  buildRemoteHostWorkspaceIdentity,
  type ProjectRowAction,
  type RemoteProjectDirectory,
  type VirtualProject,
} from "@/project-sidebar/contract.js";
import {
  resolveDataSyncEntrySourceServerId,
  useDataSyncEntry,
  type DataSyncEntryCategory,
} from "@/data-sync/index.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";

const LABEL_ID: Record<DataSyncEntryCategory, string> = {
  skills: "remote.syncSkills",
  mcp: "remote.syncMcp",
  plugins: "remote.syncPlugins",
};

/**
 * 侧栏远端项目菜单的同步项：打开数据同步弹窗，定位到该项目所在设备与所选分类，MCP 按该项目做 workspace 映射。
 * 只在设备在线时提供；弹窗经设备的 source-settings attachment 读写，不因展示菜单创建 tab、连接或 Agent。
 */
export function useProjectRemoteSync(directory: RemoteProjectDirectory) {
  const entry = useDataSyncEntry();
  // 首次新建会补全本地 tab 分类；同步菜单只消费远端目录映射，不能因此重绘全部项目。
  const localWorkspacePaths = useOptionalTabStore(
    useShallow(
      (state) =>
        new Map(
          state.tabs
            .filter(isWorkspaceTab)
            .flatMap((tab) =>
              tab.workspaceIdentity && tab.localWorkspacePath
                ? [[tab.workspaceIdentity, tab.localWorkspacePath] as const]
                : [],
            ),
        ),
    ),
  );
  const { intl } = useZCodeIntl();
  // ProjectSidebarNode 按属性浅比较做 memo；actions 换引用会让任务活动重绘所有项目节点。
  const { available, open } = entry;
  const actions = useCallback(
    (project: VirtualProject): ProjectRowAction[] => {
      const host = directory.hosts.find(
        (item) => item.id === project.hostId && item.connectionStatus === "online",
      );
      if (!host || !available) return [];
      return project.roots.flatMap((root, index) => {
        const identity = buildRemoteHostWorkspaceIdentity(host.id, root.rootPath);
        const sourceServerId = resolveDataSyncEntrySourceServerId({
          workspacePath: root.rootPath,
          workspaceIdentity: identity,
          remoteTarget: host.target,
        });
        if (!sourceServerId) return [];
        const localWorkspacePath = localWorkspacePaths.get(identity);
        return (["skills", "mcp", "plugins"] as const).map((category) => ({
          id: `sync-${category}-${index}`,
          icon: RefreshCw,
          label: `${intl.formatMessage({ id: LABEL_ID[category] })}${project.roots.length > 1 ? ` · ${root.rootPath}` : ""}`,
          run: () =>
            open({
              sourceServerId,
              category,
              ...(localWorkspacePath
                ? {
                    workspace: {
                      sourceWorkspacePath: localWorkspacePath,
                      targetWorkspacePath: root.rootPath,
                    },
                  }
                : {}),
            }),
        }));
      });
    },
    [directory.hosts, available, open, localWorkspacePaths, intl],
  );
  return { actions, dialog: entry.dialog };
}
