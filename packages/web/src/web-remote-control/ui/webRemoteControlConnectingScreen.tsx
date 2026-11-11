import { LoaderCircle } from "lucide-react";
import { DevicePlatformIcon } from "@zcode/ui/device-platform-icon";
import { WebRemoteControlBrand } from "#src/web-remote-control/ui/webRemoteControlBrand.js";
import type { WebRemoteControlScreenLocale } from "#src/web-remote-control/domain/webRemoteControlScreenCopy.js";
import type { WebRemoteControlTerminalTransportState } from "#src/web-remote-control/contract.js";

/** 连接过程页展示的目标电脑；名字来自连接参数，平台来自本机记住的设备记录。 */
export interface WebRemoteControlConnectingDevice {
  name?: string;
  platform?: string;
}

const copyByLocale = {
  "zh-CN": {
    connectingTo: (name: string) => `正在连接 ${name}`,
    connectingFallback: "正在连接电脑",
    steps: ["连接中转服务", "设备鉴权", "等待桌面端配对", "同步工作区"],
    stages: {
      connecting: "正在连接中转服务…",
      authenticating: "正在认证设备…",
      waiting: "等待桌面端确认配对…",
      paired: "已配对，正在加载工作区…",
      reconnecting: "连接中断，正在重连…",
      suspended: "页面在后台，等待恢复…",
      other: "正在准备远程控制…",
    },
    reconnectingDescription: "网络或休眠恢复后会自动重连，请稍候。",
    suspendedDescription: "回到前台后会自动恢复连接。",
  },
  "en-US": {
    connectingTo: (name: string) => `Connecting to ${name}`,
    connectingFallback: "Connecting to your computer",
    steps: [
      "Connect to relay service",
      "Authenticate device",
      "Wait for desktop pairing",
      "Sync workspace",
    ],
    stages: {
      connecting: "Connecting relay service…",
      authenticating: "Authenticating device…",
      waiting: "Waiting for desktop pairing…",
      paired: "Paired. Loading workspace…",
      reconnecting: "Connection interrupted, reconnecting…",
      suspended: "Page is in background, waiting to recover…",
      other: "Preparing remote control…",
    },
    reconnectingDescription: "Auto-reconnecting after network or wake-up changes.",
    suspendedDescription: "Connection will recover automatically when back in foreground.",
  },
};

// 线性阶段映射到 4 段进度；重连、后台等非线性状态不高亮任何一段。
const STEP_INDEX: Partial<Record<WebRemoteControlTerminalTransportState, number>> = {
  idle: 0,
  connecting: 0,
  authenticating: 1,
  waiting: 2,
  paired: 3,
};

function resolveStage(
  state: WebRemoteControlTerminalTransportState,
  copy: (typeof copyByLocale)["zh-CN"],
): { label: string; description?: string } {
  switch (state) {
    case "connecting":
    case "authenticating":
    case "waiting":
    case "paired":
      return { label: copy.stages[state] };
    case "reconnecting":
      return { label: copy.stages.reconnecting, description: copy.reconnectingDescription };
    case "suspended":
      return { label: copy.stages.suspended, description: copy.suspendedDescription };
    default:
      return { label: copy.stages.other };
  }
}

/** 选中设备到任务首页之间的全屏连接过程页；只呈现 transport 状态，不改变阶段逻辑。 */
export function WebRemoteControlLoadingScreen({
  state,
  locale,
  device,
}: {
  state: WebRemoteControlTerminalTransportState;
  locale: WebRemoteControlScreenLocale;
  device?: WebRemoteControlConnectingDevice;
}) {
  const copy = copyByLocale[locale];
  const stage = resolveStage(state, copy);
  const stepIndex = STEP_INDEX[state];
  const name = device?.name?.trim();
  return (
    <div className="flex h-dvh min-h-dvh w-screen flex-col bg-background px-4 pt-[calc(env(safe-area-inset-top)+12px)] text-foreground">
      <div className="flex h-10 items-center">
        <WebRemoteControlBrand />
      </div>
      <div
        role="status"
        aria-live="polite"
        aria-busy="true"
        className="flex flex-1 flex-col items-center justify-center pb-24 text-center"
      >
        <span className="flex size-16 items-center justify-center rounded-xl border border-card-border bg-card">
          <DevicePlatformIcon platform={device?.platform} className="size-7" />
        </span>
        <h1 className="mt-5 max-w-full truncate text-ui-lg font-semibold">
          {name ? copy.connectingTo(name) : copy.connectingFallback}
        </h1>
        <p className="mt-2 flex items-center gap-2 text-ui-sm text-foreground-subtle">
          <LoaderCircle aria-hidden="true" className="size-3.5 shrink-0 animate-spin" />
          {stage.label}
        </p>
        {stage.description ? (
          <p className="mt-1.5 max-w-xs text-ui-sm text-foreground-subtlest">{stage.description}</p>
        ) : null}
        <ol className="mt-5 flex gap-1.5" aria-label={copy.steps.join(" → ")}>
          {copy.steps.map((step, index) => (
            <li
              key={step}
              aria-current={index === stepIndex ? "step" : undefined}
              data-step-state={
                stepIndex === undefined
                  ? "idle"
                  : index < stepIndex
                    ? "done"
                    : index === stepIndex
                      ? "active"
                      : "pending"
              }
              className={[
                "h-1 w-8 rounded-full",
                stepIndex === undefined || index > stepIndex
                  ? "bg-foreground-subtlest/50"
                  : index === stepIndex
                    ? "animate-pulse bg-foreground/60"
                    : "bg-foreground",
              ].join(" ")}
            >
              <span className="sr-only">{step}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
