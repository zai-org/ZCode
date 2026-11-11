import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import type { DataSyncDialogRequest } from "@/data-sync/contract.js";
import {
  DataSyncDialogContainer,
  isDataSyncDeviceOnline,
  recordDataSyncResult,
  toDataSyncDeviceSummary,
} from "@/data-sync/ui/DataSyncDialogContainer.js";
import { useRemoteDevicePresentationInput } from "@/hooks/useSourceServerStatuses.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";

const OpenContext = createContext<((request: DataSyncDialogRequest) => void) | null>(null);
const ResultVersionContext = createContext(0);

/** 窗口级挂载：页面切换不能卸载推送 owner；最小化只改变显示状态。 */
export function DataSyncDialogProvider({ children }: { children: ReactNode }) {
  const [resultVersion, setResultVersion] = useState(0);
  const [current, setCurrent] = useState<{
    request: DataSyncDialogRequest;
    minimized: boolean;
  } | null>(null);
  const open = useCallback((request: DataSyncDialogRequest) => {
    // 已有实例时只恢复；替换请求会丢失在途推送及其设备身份。
    setCurrent((previous) =>
      previous ? { ...previous, minimized: false } : { request, minimized: false },
    );
  }, []);
  return (
    <OpenContext value={open}>
      <ResultVersionContext value={resultVersion}>
        {children}
        {current ? (
          <DataSyncSession
            request={current.request}
            minimized={current.minimized}
            onMinimizedChange={(minimized) =>
              setCurrent((previous) => (previous ? { ...previous, minimized } : null))
            }
            onClose={() => setCurrent(null)}
            onResultRecorded={() => setResultVersion((version) => version + 1)}
          />
        ) : null}
      </ResultVersionContext>
    </OpenContext>
  );
}

export function useOpenDataSyncDialog() {
  return useContext(OpenContext);
}

/**
 * 推送结束后页面刷新的唯一信号：设备结果落盘后递增。数据同步页与设置页入口按它重新读取，
 * 设备结果仍从 deviceSyncStateService 读取。
 */
export function useDataSyncResultVersion() {
  return useContext(ResultVersionContext);
}

function DataSyncSession({
  request,
  onResultRecorded,
  ...presentation
}: {
  request: DataSyncDialogRequest;
  onResultRecorded(): void;
  minimized: boolean;
  onMinimizedChange(minimized: boolean): void;
  onClose(): void;
}) {
  const base = useBaseWorkspaceServices();
  const platform = useOptionalPlatform();
  const input = useRemoteDevicePresentationInput(request.sourceServerId);
  return (
    <DataSyncDialogContainer
      {...presentation}
      device={toDataSyncDeviceSummary(request.sourceServerId, input ?? {})}
      online={input ? isDataSyncDeviceOnline(input) : false}
      sourceServices={base}
      requestSourceSettingsAttachment={platform?.requestSourceSettingsAttachment}
      initialCategory={request.category}
      workspace={request.workspace}
      workspaceHistory={request.workspaceHistory}
      onPushFinished={async (result) => {
        await recordDataSyncResult(base.deviceSyncStateService, request.sourceServerId, result);
        onResultRecorded();
      }}
    />
  );
}
