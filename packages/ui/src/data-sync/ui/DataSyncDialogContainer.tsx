import { useEffect, useMemo } from "react";
import type { DeviceSyncResult, SourceServerWorkspaceHistoryEntry } from "@zcode/shared";
import {
  formatRemoteConnectionDescription,
  formatRemoteDeviceName,
  resolveRemoteConnectionPresentation,
  type RemoteConnectionPresentationInput,
} from "@/lib/remoteConnectionPresentation.js";
import { logger } from "@/logger.js";
import {
  ensureSourceSettingsServices,
  useSourceSettingsServices,
} from "@/store/sourceSettingsServiceStore.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import type {
  DataSyncCategoryId,
  DataSyncDeviceSummary,
  DataSyncWorkspaceMapping,
  IDeviceSyncStateService,
  IServiceAccessor,
} from "@/data-sync/contract.js";
import { DataSyncDialog } from "@/data-sync/ui/DataSyncDialog.js";

/** 设备行与入口共用：名称与「传输方式 · 地址」取自管理快照的同一份展示输入。 */
export function toDataSyncDeviceSummary(
  sourceServerId: string,
  input: RemoteConnectionPresentationInput,
  fallbackName?: string,
): DataSyncDeviceSummary {
  return {
    sourceServerId,
    name: formatRemoteDeviceName(input.target, input.displayName) ?? fallbackName ?? sourceServerId,
    description: formatRemoteConnectionDescription(input.target),
    ...(input.target ? { remoteKind: input.target.kind } : {}),
  };
}

/** 设备是否在线：与设备行的「已连接」判断一致，只取自管理快照。 */
export function isDataSyncDeviceOnline(input: RemoteConnectionPresentationInput): boolean {
  return resolveRemoteConnectionPresentation(input).status === "online";
}

/** 每次推送结束写入设备同步状态；它是设备行「上次同步」的唯一数据源。 */
export async function recordDataSyncResult(
  service: IDeviceSyncStateService | undefined,
  sourceServerId: string,
  result: DeviceSyncResult,
): Promise<void> {
  if (!service) return;
  try {
    await service.recordDeviceSyncResult({ sourceServerId, result });
  } catch (error) {
    logger.warn("[DataSync] 写入设备同步状态失败", {
      sourceServerId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * 远端一侧只用该设备的 source-settings attachment：不打开 workspace tab，也不新建 Host、连接或 Agent。
 * attachment 在设备离线时被 Host detach；设备重新在线后这里重新申请，弹窗按新 generation 重新加载。
 */
export function DataSyncDialogContainer(props: {
  device: DataSyncDeviceSummary;
  online: boolean;
  workspaceHistory?: readonly SourceServerWorkspaceHistoryEntry[];
  sourceServices: IServiceAccessor;
  requestSourceSettingsAttachment?: (sourceServerId: string) => Promise<{ attachmentId: string }>;
  initialCategory?: DataSyncCategoryId;
  workspace?: DataSyncWorkspaceMapping;
  minimized: boolean;
  onMinimizedChange(minimized: boolean): void;
  onClose(): void;
  onPushFinished(result: DeviceSyncResult): Promise<void>;
}) {
  const { sourceServerId } = props.device;
  const targetServices = useSourceSettingsServices(sourceServerId);
  const tabs = useTabStore((state) => state.tabs);
  const workspaceTabs = useMemo(() => tabs.filter(isWorkspaceTab), [tabs]);
  const { online } = props;
  const request = props.requestSourceSettingsAttachment;

  useEffect(() => {
    if (!online || targetServices || !request) return;
    ensureSourceSettingsServices(sourceServerId, request).catch((error: unknown) =>
      logger.warn("[DataSync] 申请设备配置连接失败", {
        sourceServerId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }, [online, request, sourceServerId, targetServices]);

  return (
    <DataSyncDialog
      open
      minimized={props.minimized}
      onMinimizedChange={props.onMinimizedChange}
      device={props.device}
      online={online}
      sourceServices={props.sourceServices}
      targetServices={targetServices}
      workspaceHistory={props.workspaceHistory}
      workspaceTabs={workspaceTabs}
      initialCategory={props.initialCategory}
      workspace={props.workspace}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      onPushFinished={props.onPushFinished}
    />
  );
}
