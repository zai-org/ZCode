import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRightLeft, Info, LoaderCircle, Plug, RotateCcw, Server, Upload } from "lucide-react";
import type { DeviceSyncState, SourceServerManagementSnapshot } from "@zcode/shared";
import type {
  DeviceAdditionReturnTarget,
  RemoteConnectionOpenPreference,
} from "@/app-shell/types.js";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  getRemoteDevicePresentationInput,
  resolveRemoteConnectionPresentation,
} from "@/lib/remoteConnectionPresentation.js";
import { logger } from "@/logger.js";
import type { DataSyncDeviceSummary, IDeviceSyncStateService } from "@/data-sync/contract.js";
import { toDataSyncDeviceSummary } from "@/data-sync/ui/DataSyncDialogContainer.js";
import { useDataSyncEntry } from "@/data-sync/ui/DataSyncEntry.js";
import { useDataSyncResultVersion } from "@/data-sync/ui/DataSyncDialogProvider.js";

export interface DataSyncSectionProps {
  snapshot: SourceServerManagementSnapshot | null;
  deviceSyncStateService?: IDeviceSyncStateService;
  /** 打开已有的全局连接向导（Root 注入）；返回 false 表示向导正忙、未接受本次意图。 */
  onOpenRemoteConnection?: (preference: RemoteConnectionOpenPreference) => boolean | void;
  /** 打开迁移向导（直接进入第一步「会话」），从其他 AI 工具导入本机。 */
  onOpenMigration?: () => void;
  now?: () => number;
}

/** 设备行的连接维度：离线、连接失败与各种待处理（安装/升级/身份/凭据）都归入 disconnected。 */
type DataSyncDeviceConnection = "online" | "connecting" | "disconnected";

interface DataSyncDeviceRow extends DataSyncDeviceSummary {
  connection: DataSyncDeviceConnection;
  /** 「连接」交给连接向导的 Profile，与传输方式、地址取自同一条 Profile。 */
  profileId?: string;
}

/** 设备行最终显示态，同时写在行的 data-device-state 上供 E2E 断言。 */
type DataSyncDeviceDisplayState = "synced" | "sync-failed" | "connecting" | "disconnected";

const CONNECTION_STATUS_CLASS: Record<DataSyncDeviceConnection, string> = {
  online: "text-success-surface-foreground",
  connecting: "text-progress-surface-foreground",
  disconnected: "text-remote-foreground-muted",
};

function toDeviceConnection(
  status: ReturnType<typeof resolveRemoteConnectionPresentation>["status"],
): DataSyncDeviceConnection {
  if (status === "online") return "online";
  if (status === "connecting") return "connecting";
  return "disconnected";
}

/**
 * 设备来自本机 Source Server 管理快照：已安装、且至少有一条未退役 Connection Profile 的设备。
 * dev-only 的 Server 直连不是 Connection Profile，天然不在快照中。
 * 传输方式、地址和「连接」用的 Profile 沿用 getRemoteDevicePresentationInput 的选择规则；
 * 连接状态只取自管理快照，页面不另存。
 */
function buildDataSyncDevices(
  snapshot: SourceServerManagementSnapshot | null,
): DataSyncDeviceRow[] {
  if (!snapshot) return [];
  return snapshot.servers
    .filter(
      (server) =>
        server.installState === "installed" &&
        snapshot.profiles.some(
          (profile) =>
            profile.sourceServerId === server.sourceServerId &&
            profile.lifecycleState !== "retired",
        ),
    )
    .map((server) => {
      const input = getRemoteDevicePresentationInput(snapshot, server.sourceServerId);
      return {
        ...toDataSyncDeviceSummary(server.sourceServerId, input, server.displayName),
        connection: toDeviceConnection(resolveRemoteConnectionPresentation(input).status),
        profileId: input.profileId,
      };
    });
}

function isSameDay(left: number, right: number): boolean {
  const a = new Date(left);
  const b = new Date(right);
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function DataSyncSection(props: DataSyncSectionProps) {
  const resultVersion = useDataSyncResultVersion();
  const { intl, locale } = useZCodeIntl();
  const now = props.now ?? Date.now;
  const devices = useMemo(() => buildDataSyncDevices(props.snapshot), [props.snapshot]);
  const [syncStates, setSyncStates] = useState<Record<string, DeviceSyncState>>({});
  const deviceSyncStateService = props.deviceSyncStateService;
  const onOpenRemoteConnection = props.onOpenRemoteConnection;
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /**
   * 连接复用全局连接向导（设备管理模式），returnTarget 为 data-sync：完成后 Root 回到发起时的设置 tab，
   * 不跳「远程设备」页。设备行只读管理快照，所以 finish 不改页面；页面卸载后 isCurrent 为 false，
   * Root 丢弃迟到或取消的结果。
   */
  const openConnectionWizard = useCallback(
    (preferredProfileId?: string) => {
      if (!onOpenRemoteConnection) return;
      const returnTarget: DeviceAdditionReturnTarget = {
        kind: "data-sync",
        isCurrent: () => mounted.current,
        finish: () => {},
      };
      const accepted = onOpenRemoteConnection({
        completion: "device-management",
        ...(preferredProfileId ? { preferredProfileId } : {}),
        returnTarget,
      });
      if (accepted === false) {
        logger.info("[DataSync] 连接向导正忙，未接受本次连接", { preferredProfileId });
      }
    },
    [onOpenRemoteConnection],
  );

  // 设备行的「上次同步」只读设备同步状态，这是它的唯一数据源。
  const reloadSyncStates = useCallback(async () => {
    if (!deviceSyncStateService) return;
    try {
      setSyncStates(await deviceSyncStateService.getDeviceSyncStates());
    } catch (error) {
      logger.warn("[DataSync] 读取设备同步状态失败", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [deviceSyncStateService]);

  useEffect(() => {
    void reloadSyncStates();
  }, [reloadSyncStates, resultVersion]);

  const formatSyncStatus = (state: DeviceSyncState | undefined): string => {
    if (!state) return intl.formatMessage({ id: "remoteSync.device.neverSynced" });
    if (state.lastResult !== "success") {
      return intl.formatMessage({ id: "remoteSync.device.status.failed" });
    }
    if (isSameDay(state.lastSyncAt, now())) {
      return intl.formatMessage(
        { id: "remoteSync.device.lastSynced.today" },
        {
          time: new Date(state.lastSyncAt).toLocaleTimeString(locale, {
            hour: "2-digit",
            minute: "2-digit",
          }),
        },
      );
    }
    return intl.formatMessage(
      { id: "remoteSync.device.lastSynced" },
      {
        time: new Date(state.lastSyncAt).toLocaleString(locale, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        }),
      },
    );
  };

  const syncEntry = useDataSyncEntry();

  return (
    <div className="space-y-6" data-testid="remote-sync-section">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-ui-settings-title font-semibold tracking-tight text-foreground lg:text-ui-settings-title-lg">
            {intl.formatMessage({ id: "remoteSync.title" })}
          </h2>
          {props.onOpenMigration ? (
            <div data-testid="remote-sync-list-actions">
              <Button
                type="button"
                variant="ghost"
                className="rounded-lg text-remote-foreground-muted"
                data-testid="remote-sync-migrate"
                onClick={props.onOpenMigration}
              >
                <ArrowRightLeft className="size-3.5" aria-hidden="true" />
                {intl.formatMessage({ id: "remoteSync.action.migrate" })}
              </Button>
            </div>
          ) : null}
        </div>
        <div className="flex items-center gap-1 text-remote-foreground-muted">
          <p className="text-ui-base" data-testid="remote-sync-description">
            {intl.formatMessage({ id: "remoteSync.description" })}
          </p>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-md"
                data-testid="remote-sync-rules-trigger"
                aria-label={intl.formatMessage({ id: "remoteSync.rules.title" })}
              >
                <Info className="size-3.5" aria-hidden="true" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="gap-2 p-3" data-testid="remote-sync-rules">
              <div className="font-medium">
                {intl.formatMessage({ id: "remoteSync.rules.title" })}
              </div>
              <p className="text-remote-foreground-muted">
                {intl.formatMessage({ id: "remoteSync.rules.description" })}
              </p>
            </PopoverContent>
          </Popover>
        </div>
      </div>
      {devices.length === 0 ? (
        <div
          data-testid="remote-sync-empty"
          className="rounded-xl border border-dashed border-border px-6 py-12 text-center"
        >
          <Server className="mx-auto size-8 text-foreground-subtlest" aria-hidden="true" />
          <div className="mt-3 text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "remoteSync.empty.title" })}
          </div>
          <p className="mx-auto mt-1 max-w-md text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "remoteSync.empty.description" })}
          </p>
          {onOpenRemoteConnection ? (
            <Button
              type="button"
              size="sm"
              className="mt-4"
              data-testid="remote-sync-empty-connect"
              onClick={() => openConnectionWizard()}
            >
              {intl.formatMessage({ id: "remoteSync.empty.connect" })}
            </Button>
          ) : null}
        </div>
      ) : (
        <div
          data-testid="remote-sync-device-list"
          className="overflow-hidden rounded-xl bg-surface"
        >
          {devices.map((device, index) => {
            const state = syncStates[device.sourceServerId];
            // 「上次同步失败」只取自设备同步状态：partial 与 failed 都算失败，且只在在线时显示。
            const displayState: DataSyncDeviceDisplayState =
              device.connection !== "online"
                ? device.connection
                : state !== undefined && state.lastResult !== "success"
                  ? "sync-failed"
                  : "synced";
            const statusText =
              displayState === "connecting"
                ? intl.formatMessage({ id: "remoteSync.device.status.connecting" })
                : displayState === "disconnected"
                  ? intl.formatMessage({ id: "remoteSync.device.status.offline" })
                  : formatSyncStatus(state);
            const actionMessageId =
              displayState === "connecting"
                ? "remoteSync.action.connecting"
                : displayState === "disconnected"
                  ? "remoteSync.action.connect"
                  : displayState === "sync-failed"
                    ? "remoteSync.action.retry"
                    : "remoteSync.action.open";
            const ActionIcon =
              displayState === "connecting"
                ? LoaderCircle
                : displayState === "disconnected"
                  ? Plug
                  : displayState === "sync-failed"
                    ? RotateCcw
                    : Upload;
            return (
              <div
                key={device.sourceServerId}
                data-testid={`remote-sync-device-${device.sourceServerId}`}
                data-source-server-id={device.sourceServerId}
                data-device-state={displayState}
                className={cn(
                  "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:gap-4",
                  index > 0 && "border-t border-border/50",
                )}
              >
                <div className="col-span-2 min-w-0 sm:col-span-1">
                  <div className="text-ui-base font-medium text-foreground">{device.name}</div>
                  <div className="mt-0.5 break-words text-ui-sm text-remote-foreground-muted">
                    {device.description}
                  </div>
                </div>
                <div className="min-w-0 sm:min-w-32">
                  {/* 连接状态与同步结果来自不同事实源；在线不代表配置已同步，失败也不代表设备离线。 */}
                  <div
                    data-testid="remote-sync-device-connection"
                    className={cn(
                      "flex items-center gap-1.5 text-ui-sm",
                      CONNECTION_STATUS_CLASS[device.connection],
                    )}
                  >
                    <span
                      className="size-1.5 shrink-0 rounded-full bg-current"
                      aria-hidden="true"
                    />
                    {device.connection === "online" ? (
                      intl.formatMessage({ id: "remoteSync.device.status.online" })
                    ) : (
                      <span data-testid="remote-sync-device-status">{statusText}</span>
                    )}
                  </div>
                  {device.connection === "online" ? (
                    <div
                      data-testid="remote-sync-device-status"
                      className={cn(
                        "mt-0.5 text-ui-sm",
                        displayState === "sync-failed"
                          ? "text-destructive"
                          : "text-remote-foreground-muted",
                      )}
                    >
                      {statusText}
                    </div>
                  ) : null}
                </div>
                <Button
                  type="button"
                  data-testid="remote-sync-device-action"
                  variant={displayState === "synced" ? "default" : "outline"}
                  className="min-w-24 justify-self-end rounded-lg"
                  disabled={
                    displayState === "connecting" ||
                    (displayState === "disconnected" && !onOpenRemoteConnection)
                  }
                  onClick={() => {
                    if (displayState === "disconnected") openConnectionWizard(device.profileId);
                    else
                      syncEntry.open({
                        sourceServerId: device.sourceServerId,
                        workspaceHistory: props.snapshot?.workspaceHistory,
                      });
                  }}
                >
                  <ActionIcon
                    className={cn("size-3.5", displayState === "connecting" && "animate-spin")}
                    aria-hidden="true"
                  />
                  {intl.formatMessage({ id: actionMessageId })}
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
