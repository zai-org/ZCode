import { useEffect, useRef, useState } from "react";
import type { WebRemoteControlStatus } from "@zcode/shared";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { logger } from "@/logger.js";

function isSameWebRemoteControlStatus(
  left: WebRemoteControlStatus,
  right: WebRemoteControlStatus,
): boolean {
  return (
    left.status === right.status &&
    left.sessionId === right.sessionId &&
    left.windowControlSessionId === right.windowControlSessionId &&
    left.mobileConnected === right.mobileConnected &&
    left.mobileViewState?.activeWorkspaceKey === right.mobileViewState?.activeWorkspaceKey &&
    left.mobileViewState?.activeTaskId === right.mobileViewState?.activeTaskId &&
    left.mobileViewState?.updatedAt === right.mobileViewState?.updatedAt &&
    left.mobileTaskView?.taskId === right.mobileTaskView?.taskId &&
    left.mobileTaskView?.workspacePath === right.mobileTaskView?.workspacePath &&
    left.mobileTaskView?.workspaceIdentity === right.mobileTaskView?.workspaceIdentity &&
    left.mobileTaskView?.remoteSessionId === right.mobileTaskView?.remoteSessionId &&
    left.mobileDeviceInfo?.updatedAt === right.mobileDeviceInfo?.updatedAt &&
    left.mobileDeviceInfo?.userAgent === right.mobileDeviceInfo?.userAgent &&
    left.mobileDeviceInfo?.viewport?.width === right.mobileDeviceInfo?.viewport?.width &&
    left.mobileDeviceInfo?.viewport?.height === right.mobileDeviceInfo?.viewport?.height &&
    left.error === right.error &&
    left.failure?.reason === right.failure?.reason &&
    left.failure?.message === right.failure?.message
  );
}

export function useWebRemoteControlStatus({
  enabled = true,
  intervalMs = 1000,
}: {
  enabled?: boolean;
  intervalMs?: number;
} = {}): WebRemoteControlStatus {
  const platform = useOptionalPlatform();
  const [status, setStatus] = useState<WebRemoteControlStatus>({
    status: "idle",
  });
  const publishedStatusRef = useRef(status);

  useEffect(() => {
    let disposed = false;

    const applyStatus = (nextStatus: WebRemoteControlStatus) => {
      if (disposed || isSameWebRemoteControlStatus(publishedStatusRef.current, nextStatus)) {
        return;
      }
      // 相同值的 updater 虽不触发 render，仍会留在 React pending 队列；空闲轮询会持续累积。
      // 入队前比较最后发布值，并立即推进它，保证同一批事件 A→B→A 不被旧 render 值误过滤。
      publishedStatusRef.current = nextStatus;
      setStatus(nextStatus);
    };

    if (!enabled || !platform) {
      applyStatus({ status: "idle" });
      return;
    }

    const syncStatus = async () => {
      try {
        const nextStatus = await platform.getWebRemoteControlStatus();
        applyStatus(nextStatus);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Bugfix: 远控连接状态来自 main/relay，桌面 UI 必须轮询才能感知手机打开的 task。
        // 轮询失败属于高频诊断信息，只走 debug，避免生产日志随刷新频率增长。
        logger.debug("[useWebRemoteControlStatus] 同步 Web 远程控制状态失败", {
          error: message,
        });
      }
    };

    void syncStatus();
    const disposeStatusChanged = platform.onWebRemoteControlStatusChanged?.((nextStatus) => {
      // Bugfix: start/refresh 后如果只等 1s 轮询，手机立刻扫码时 main 还没拿到 renderer 同步的 task 快照。
      // main 已经是远控 session/transport 状态事实源，这里优先消费事件推送，轮询只保留为旧平台兜底。
      applyStatus(nextStatus);
    });
    const intervalId = window.setInterval(() => {
      void syncStatus();
    }, intervalMs);

    return () => {
      disposed = true;
      disposeStatusChanged?.();
      window.clearInterval(intervalId);
    };
  }, [enabled, intervalMs, platform]);

  return status;
}
