import { useCallback, useEffect, useMemo } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { useShallow } from "zustand/react/shallow";
import type { IExtensionsService, IExtensionViewsService } from "@zcode/services";
import { useOptionalBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";
import {
  getExtensionSlotsStore,
  type ExtensionSlotsState,
} from "@/extension-slots/app/extensionSlotsStore.js";
import {
  composerCommandScope,
  selectComposerStatusEntries,
  selectExtensionProblems,
  selectLauncherViewItems,
} from "@/extension-slots/domain/slotSelectors.js";
import {
  useOpenExtensionLogs,
  useOpenExtensionView,
} from "@/extension-slots/adapters/extensionViewsContext.js";
import type {
  ComposerStatusSlotModel,
  ComposerStatusSlotProps,
  ExtensionLauncherModel,
  ExtensionLauncherSectionProps,
} from "@/extension-slots/contract.js";

/** 没有扩展门面（Web、手机远控）时用的空 store：hooks 照常调用，结果为空。 */
const EMPTY_STORE = createStore<ExtensionSlotsState>(() => ({
  table: null,
  snapshot: null,
  status: null,
}));

/**
 * 扩展门面只在桌面本机 Host 注册；Web 与手机远控没有它，插槽一律不显示。
 * 扩展进程是全 App 的，所以取 base services，不随当前工作区（可能是远端）切换。
 */
export function useExtensionsService(): IExtensionsService | null {
  return useOptionalBaseWorkspaceServices()?.extensionsService ?? null;
}

/** 扩展视图门面（§8）：与扩展门面同一个本机 Host、同一开关，Web 与手机远控没有它。 */
export function useExtensionViewsService(): IExtensionViewsService | null {
  return useOptionalBaseWorkspaceServices()?.extensionViewsService ?? null;
}

/** 订阅静态表、贡献表与扩展进程状态，按 selector 取值（浅比较，只在所选部分变化时重渲染）。 */
export function useExtensionSlotsState<T>(
  service: IExtensionsService | null,
  selector: (state: ExtensionSlotsState) => T,
): T {
  const entry = service ? getExtensionSlotsStore(service) : null;
  useEffect(() => entry?.retain(), [entry]);
  return useStore(entry?.store ?? EMPTY_STORE, useShallow(selector));
}

/** 重新加载扩展：Renderer → IExtensionsService.reload() → Window Host → Main。 */
export function useReloadExtensions(): (() => void) | null {
  const service = useExtensionsService();
  const reload = useCallback(() => {
    if (!service) return;
    void service.reload().catch((error: unknown) => {
      logger.lifecycle.warn("[extension-slots] reload failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }, [service]);
  return service ? reload : null;
}

/** composer.status 的渲染模型：没有扩展门面时为 null。 */
export function useComposerStatusSlot({
  workspacePath,
  workspaceIdentity,
  sessionId,
}: ComposerStatusSlotProps): ComposerStatusSlotModel | null {
  const service = useExtensionsService();
  const { table, snapshot, status } = useExtensionSlotsState(service, (state) => ({
    table: state.table,
    snapshot: state.snapshot,
    status: state.status,
  }));
  const workspace = useMemo(
    () =>
      workspacePath ? { workspacePath, ...(workspaceIdentity ? { workspaceIdentity } : {}) } : null,
    [workspacePath, workspaceIdentity],
  );
  const items = useMemo(
    () =>
      selectComposerStatusEntries(
        { table, snapshot, status },
        { workspace, sessionId: sessionId ?? null },
      ),
    [table, snapshot, status, workspace, sessionId],
  );
  // 命令作用域：当前会话（草稿为预热会话）；没有会话时为工作区。
  const scope = useMemo(
    () => composerCommandScope(workspace, sessionId ?? null),
    [workspace, sessionId],
  );
  const runCommand = useCallback(
    (commandId: string) => {
      if (!service) return;
      void service.executeCommand({ commandId, scope }).catch((error: unknown) => {
        logger.lifecycle.warn("[extension-slots] command failed", {
          commandId,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    },
    [scope, service],
  );
  return useMemo(() => (service ? { items, runCommand } : null), [items, runCommand, service]);
}

/** 启动页「扩展」分区的渲染模型：没有扩展门面时为 null。 */
export function useExtensionLauncher({
  workspacePath,
  workspaceIdentity,
}: ExtensionLauncherSectionProps = {}): ExtensionLauncherModel | null {
  const service = useExtensionsService();
  const { table, snapshot, status } = useExtensionSlotsState(service, (state) => ({
    table: state.table,
    snapshot: state.snapshot,
    status: state.status,
  }));
  const reload = useReloadExtensions();
  const openView = useOpenExtensionView();
  const openLogsEntry = useOpenExtensionLogs();
  const problems = useMemo(
    () => selectExtensionProblems({ table, snapshot, status }),
    [table, snapshot, status],
  );
  // 启动页是工作区级：动态值按 App → 工作区合并，不看会话。
  const views = useMemo(
    () =>
      selectLauncherViewItems(
        { table, snapshot, status },
        {
          workspace: workspacePath
            ? { workspacePath, ...(workspaceIdentity ? { workspaceIdentity } : {}) }
            : null,
          sessionId: null,
        },
      ),
    [table, snapshot, status, workspaceIdentity, workspacePath],
  );
  const stopped = status?.state === "stopped";
  // 没有扩展时缓冲里只有监管器的行，不给「扩展日志」一行（命令中心照常可打开，§16.8）。
  const hasExtensions = useMemo(
    () => Boolean(table?.plugins.some((plugin) => plugin.extension !== null)),
    [table],
  );
  const openLogs = hasExtensions || stopped ? openLogsEntry : null;
  // 等待激活确认的插件（§17.7）：来自 Window Host 的静态表，它是这项状态的唯一 owner。
  const pendingActivations = useMemo(
    () =>
      (table?.plugins ?? [])
        .filter((plugin) => plugin.activation === "pending")
        .map((plugin) => ({ pluginId: plugin.pluginId, name: plugin.name })),
    [table],
  );
  return useMemo(
    () =>
      service ? { views, openView, problems, stopped, reload, openLogs, pendingActivations } : null,
    [openLogs, openView, pendingActivations, problems, reload, service, stopped, views],
  );
}
