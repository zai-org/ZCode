import { useCallback, useMemo } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { useOpenExtensionView } from "@/extension-slots/adapters/extensionViewsContext.js";
import {
  useExtensionSlotsState,
  useExtensionsService,
  useReloadExtensions,
} from "@/extension-slots/adapters/useExtensionSlots.js";
import { useOpenSlotSurface } from "@/extension-slots/adapters/useOpenSlotSurface.js";
import {
  selectNavPrimaryItems,
  sortNavPrimaryItems,
} from "@/extension-slots/domain/slotSelectors.js";
import type {
  NavPrimaryItem,
  NavPrimarySlotModel,
  NavPrimarySlotProps,
} from "@/extension-slots/contract.js";

/**
 * nav.primary 的渲染模型（docs/plugins/extension-host.md §16.4）：没有扩展门面（Web、手机远控）时为 null。
 * 点击都在右侧面板打开：view 打开扩展视图标签（与启动页条目同一入口），surface 打开 MCP App 页面。
 * 右侧面板只在对话主视图显示，所以先回到对话；这不是新的主视图，条目也没有选中态。
 * 扩展进程已停止时 view 条目点击改为重新加载；surface 条目不经扩展进程，照常打开。
 */
export function useNavPrimarySlot(props: NavPrimarySlotProps): NavPrimarySlotModel | null {
  const service = useExtensionsService();
  const { locale } = useZCodeIntl();
  const { table, snapshot, status } = useExtensionSlotsState(service, (state) => ({
    table: state.table,
    snapshot: state.snapshot,
    status: state.status,
  }));
  const openView = useOpenExtensionView();
  const reload = useReloadExtensions();
  const openSurface = useOpenSlotSurface(props);
  const { onShowChat } = props;
  const items = useMemo(
    () => sortNavPrimaryItems(selectNavPrimaryItems({ table, snapshot, status }), locale),
    [locale, snapshot, status, table],
  );
  const open = useCallback(
    (item: NavPrimaryItem) => {
      // 点击是用户操作，频率低。
      logger.lifecycle.info("[extension-slots] nav.primary open", {
        itemId: item.itemId,
        target: item.target.kind,
        hostStopped: item.hostStopped,
      });
      if (item.hostStopped) {
        reload?.();
        return;
      }
      onShowChat?.();
      if (item.target.kind === "view") {
        if (!openView?.(item.target.id)) {
          logger.lifecycle.warn("[extension-slots] nav.primary view unavailable", {
            itemId: item.itemId,
            viewId: item.target.id,
          });
        }
        return;
      }
      openSurface({ itemId: item.itemId, pluginId: item.pluginId, surfaceId: item.target.id });
    },
    [onShowChat, openSurface, openView, reload],
  );
  return useMemo(() => (service ? { items, open } : null), [items, open, service]);
}
