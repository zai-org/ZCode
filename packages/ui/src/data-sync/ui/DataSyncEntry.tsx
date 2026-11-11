import { useCallback, useEffect, useRef, type MouseEvent, type ReactNode } from "react";
import { BlocksIcon, CableIcon, ChevronDown, UploadCloud, WandIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useRemoteDevicePresentationInput } from "@/hooks/useSourceServerStatuses.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { DataSyncCategoryId, DataSyncDialogRequest } from "@/data-sync/contract.js";
import { isDataSyncDeviceOnline } from "@/data-sync/ui/DataSyncDialogContainer.js";
import {
  useDataSyncResultVersion,
  useOpenDataSyncDialog,
} from "@/data-sync/ui/DataSyncDialogProvider.js";

/** 旧入口能定位的分类：技能、MCP、插件。 */
export type DataSyncEntryCategory = Extract<DataSyncCategoryId, "skills" | "mcp" | "plugins">;

export type DataSyncEntryRequest = DataSyncDialogRequest;

/** 设备在线判断与数据同步页一致：取自管理快照的同一份展示输入；不会为此建立连接。 */
export function useDataSyncDeviceOnline(sourceServerId: string | null | undefined): boolean {
  const input = useRemoteDevicePresentationInput(sourceServerId ?? undefined);
  return input ? isDataSyncDeviceOnline(input) : false;
}

/**
 * 旧同步入口统一打开数据同步弹窗。
 * available：平台能申请设备的 source-settings attachment（只有桌面端）；Web 与手机远控不显示入口。
 * onPushFinished：任一推送的设备结果写入后，已挂载的本页刷新一次，与弹窗由哪个入口打开无关。
 */
export function useDataSyncEntry(options: { onPushFinished?(): void | Promise<void> } = {}): {
  available: boolean;
  open(request: DataSyncEntryRequest): void;
  dialog: ReactNode;
} {
  const request = useOptionalPlatform()?.requestSourceSettingsAttachment;
  const openDialog = useOpenDataSyncDialog();
  const resultVersion = useDataSyncResultVersion();
  const available = Boolean(request && openDialog);
  const onPushFinishedRef = useRef(options.onPushFinished);
  const seenResultVersionRef = useRef(resultVersion);
  useEffect(() => {
    onPushFinishedRef.current = options.onPushFinished;
  }, [options.onPushFinished]);
  // 修复原因：刷新回调原来绑在打开弹窗的入口实例上。最小化后该页卸载再挂载，或从数据同步页、
  // 状态条恢复弹窗时，推送结束只调用已失效的旧回调，设置页列表停在推送前。改为订阅窗口级结果版本：
  // 设备结果写入后，当时已挂载的入口页各刷新一次；页面新挂载时自行加载，不重复刷新。
  useEffect(() => {
    if (seenResultVersionRef.current === resultVersion) return;
    seenResultVersionRef.current = resultVersion;
    void onPushFinishedRef.current?.();
  }, [resultVersion]);
  const open = useCallback(
    (next: DataSyncEntryRequest) => {
      if (available && openDialog) openDialog(next);
    },
    [available, openDialog],
  );
  return { available, open, dialog: null };
}

const ENTRY_ITEMS: ReadonlyArray<{
  category: DataSyncEntryCategory;
  messageId: string;
  icon: typeof WandIcon;
}> = [
  { category: "skills", messageId: "remote.syncSkills", icon: WandIcon },
  { category: "mcp", messageId: "remote.syncMcp", icon: CableIcon },
  { category: "plugins", messageId: "remote.syncPlugins", icon: BlocksIcon },
];

/** Header 更多菜单与连接向导下拉共用的三个同步项；设备离线时禁用。 */
export function DataSyncEntryMenuItems(props: {
  disabled?: boolean;
  stopMouseDownPropagation?: boolean;
  onSelect(category: DataSyncEntryCategory): void;
}) {
  const { intl } = useZCodeIntl();
  const handleMouseDown = props.stopMouseDownPropagation
    ? (event: MouseEvent) => event.stopPropagation()
    : undefined;
  return (
    <>
      {ENTRY_ITEMS.map(({ category, messageId, icon: Icon }) => (
        <DropdownMenuItem
          key={category}
          data-testid={`data-sync-entry-${category}`}
          disabled={props.disabled}
          onMouseDown={handleMouseDown}
          onSelect={() => props.onSelect(category)}
        >
          <Icon className="size-3.5" />
          {intl.formatMessage({ id: messageId })}
        </DropdownMenuItem>
      ))}
    </>
  );
}

/** 连接向导「一键同步」下拉。 */
export function DataSyncEntryDropdownButton(props: {
  disabled?: boolean;
  onSelect(category: DataSyncEntryCategory): void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="gap-1"
          data-testid="data-sync-entry-trigger"
        >
          <UploadCloud className="size-3.5" aria-hidden="true" />
          {intl.formatMessage({ id: "remote.syncAll" })}
          <ChevronDown className="size-3.5 text-foreground-subtle" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        <DataSyncEntryMenuItems disabled={props.disabled} onSelect={props.onSelect} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
