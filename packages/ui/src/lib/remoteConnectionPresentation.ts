import {
  classifyRemoteConnectionError,
  type RemoteConnectionErrorPresentation,
} from "@/lib/remoteConnectionPresentationErrors.js";
import type { RemoteConnectionAction } from "@/lib/remoteConnectionPresentationTypes.js";
export {
  classifyRemoteConnectionError,
  formatRemoteConnectionError,
  shouldShowStandaloneRemoteErrorToast,
} from "@/lib/remoteConnectionPresentationErrors.js";
export type { RemoteConnectionErrorPresentation } from "@/lib/remoteConnectionPresentationErrors.js";
export type { RemoteConnectionAction } from "@/lib/remoteConnectionPresentationTypes.js";
import { SOURCE_SERVER_UPDATE_IN_PROGRESS_ERROR_CODE } from "@zcode/shared";
import type {
  ConnectionProfile,
  RemoteTarget,
  SourceServerConnectionState,
  SourceServerConnectionStateSnapshot,
  SourceServerManagementSnapshot,
  SourceServerRecord,
} from "@zcode/shared";

export type RemoteConnectionStatus = "online" | "connecting" | "offline" | "pending" | "failed";
export type AggregatedSourceStatus = RemoteConnectionStatus;
export type RemoteConnectionTone = "success" | "progress" | "neutral" | "warning" | "danger";
export type RemoteConnectionIcon = "cloud" | "spinner" | "cloud-off" | "cloud-alert" | "cloud-x";

export interface RemoteConnectionPresentationInput {
  profileId?: string;
  state?: SourceServerConnectionState | RemoteConnectionStatus;
  attached?: boolean;
  reconnecting?: boolean;
  installState?: SourceServerRecord["installState"];
  disconnectOrigin?: "user" | "unexpected" | "startup";
  credentialsMissing?: boolean;
  updateAvailability?: SourceServerConnectionStateSnapshot["updateAvailability"];
  upgradeTarget?: SourceServerConnectionStateSnapshot["upgradeTarget"];
  recoveryAttempt?: number;
  recoveryLimit?: number;
  recoveryBudgetExhausted?: boolean;
  errorCode?: string;
  error?: string;
  /** 项目错误可能已本地化，不能覆盖设备权威错误用于分类的原文。 */
  projectError?: string;
  target?: RemoteTarget;
  displayName?: string;
  wizard?: boolean;
}

const TONES = {
  success: {
    foreground: "text-success-surface-foreground",
    surface: "bg-success-surface",
    border: "border-success",
    dot: "bg-success",
  },
  progress: {
    foreground: "text-progress-surface-foreground",
    surface: "bg-progress-surface",
    border: "border-progress-surface-foreground",
    dot: "bg-progress-surface-foreground animate-pulse",
  },
  neutral: {
    foreground: "text-remote-foreground-muted",
    surface: "bg-surface",
    border: "border-border",
    dot: "border border-foreground-subtlest",
  },
  warning: {
    foreground: "text-warning-surface-foreground",
    surface: "bg-warning-surface",
    border: "border-warning",
    dot: "bg-warning",
  },
  danger: {
    foreground: "text-destructive-surface-foreground",
    surface: "bg-destructive-surface",
    border: "border-destructive",
    dot: "bg-destructive",
  },
} as const;

export interface RemoteConnectionPresentation {
  profileId?: string;
  status: RemoteConnectionStatus;
  messageId: string;
  shortMessageId: string;
  tone: RemoteConnectionTone;
  icon: RemoteConnectionIcon;
  primaryAction: RemoteConnectionAction;
  actionMessageId: string;
  foreground: string;
  surface: string;
  border: string;
  dot: string;
  recovery?: {
    messageId: string;
    shortMessageId: string;
    values: { attempt: number; limit: number };
  };
  updateNotice: { foreground: string; surface: string };
  description: string;
  displayName?: string;
  reason?: RemoteConnectionErrorPresentation;
  /** 项目 owner 已分类的文案（例如目录错误），设备级错误码仍优先。 */
  reasonText?: string;
}

/** 设备、项目、恢复均只读已有 owner 的事实；主动断开不能被残留错误染成失败。 */
export function resolveRemoteConnectionPresentation(
  input: RemoteConnectionPresentationInput,
): RemoteConnectionPresentation {
  let status: RemoteConnectionStatus = "offline";
  let short = "offline";
  let tone: RemoteConnectionTone = "neutral";
  let icon: RemoteConnectionIcon = "cloud-off";
  let action: RemoteConnectionAction = "connect";
  const reason =
    input.errorCode || input.error || input.projectError
      ? classifyRemoteConnectionError({ ...input, error: input.error ?? input.projectError })
      : undefined;
  const canceled = reason?.category === "canceled";
  const active =
    input.reconnecting ||
    ["bootstrapping", "retrying", "connecting", "updating"].includes(input.state ?? "");
  if (input.disconnectOrigin === "user" || (!active && canceled)) {
    // 主动断开与用户取消是中性终态，保留在日志里的上次失败不再参与展示。
  } else if (active) {
    status = "connecting";
    short = input.state === "updating" ? "updating" : "connecting";
    tone = "progress";
    icon = "spinner";
    action = input.wizard ? "cancel" : "none";
  } else if (input.errorCode === SOURCE_SERVER_UPDATE_IN_PROGRESS_ERROR_CODE) {
    // 更新期间被拒绝的连接是等待点：设备正在更新，不计为连接失败，只提供重试（R3 §6.3）。
    status = "pending";
    short = "updating";
    tone = "progress";
    icon = "spinner";
    action = "retry";
  } else if (
    input.state === "identity-change-pending" ||
    input.errorCode === "source-server-identity-change-pending"
  ) {
    status = "pending";
    short = "needsIdentity";
    tone = "warning";
    icon = "cloud-alert";
    action = "confirm-identity";
  } else if (
    input.state === "needs-upgrade" ||
    input.updateAvailability === "required" ||
    input.errorCode === "source-server-upgrade-required"
  ) {
    status = "pending";
    short = "needsUpdate";
    tone = "warning";
    icon = "cloud-alert";
    action = input.upgradeTarget === "controller" ? "update-desktop" : "update-server";
  } else if (
    input.state === "needs-install" ||
    input.installState === "uninstalled" ||
    input.errorCode === "source-server-install-required"
  ) {
    status = "pending";
    short = "needsInstall";
    tone = "warning";
    icon = "cloud-alert";
    action = "install";
  } else if (input.credentialsMissing || reason?.category === "credentials") {
    status = "pending";
    short = "needsCredentials";
    tone = "warning";
    icon = "cloud-alert";
    action = "credentials";
  } else if (input.state === "pending") {
    status = "pending";
    short = "pending";
    tone = "warning";
    icon = "cloud-alert";
  } else if (
    input.state === "failed" ||
    input.recoveryBudgetExhausted ||
    ((input.error?.trim() || input.projectError?.trim()) &&
      input.state !== "offline" &&
      input.state !== "absent")
  ) {
    status = "failed";
    short = "failed";
    tone = "danger";
    icon = "cloud-x";
    action = reason?.primaryAction ?? "retry";
  } else if (input.state === "online" || (input.attached && !input.state)) {
    status = input.attached === false ? "connecting" : "online";
    short = status;
    tone = status === "online" ? "success" : "progress";
    icon = status === "online" ? "cloud" : "spinner";
    action = status === "online" ? "disconnect" : input.wizard ? "cancel" : "none";
  }
  return {
    profileId: input.profileId,
    status,
    messageId: `remote.status.${status}`,
    shortMessageId: `remote.status.${short}`,
    tone,
    icon,
    primaryAction: action,
    actionMessageId: `remote.action.${action}`,
    ...TONES[tone],
    ...(status === "connecting" && input.recoveryAttempt
      ? {
          recovery: {
            messageId: "workspaceSidebar.recoveringAutomaticAttempt",
            shortMessageId: "workspaceSidebar.recoveringAutomaticShort",
            values: { attempt: input.recoveryAttempt, limit: input.recoveryLimit ?? 3 },
          },
        }
      : {}),
    updateNotice: input.updateAvailability === "available" ? TONES.neutral : TONES[tone],
    description: formatRemoteConnectionDescription(input.target),
    displayName: input.displayName,
    ...(status === "failed" || status === "pending"
      ? {
          reason,
          ...(!input.errorCode && !input.error && input.projectError
            ? { reasonText: input.projectError }
            : {}),
        }
      : {}),
  };
}

export function formatRemoteProjectConnectionAddress(target?: RemoteTarget): string | undefined {
  if (!target) return undefined;
  switch (target.kind) {
    case "ssh":
      return `${target.username}@${target.host}:${target.port ?? 22}`;
    case "wsl":
      return [target.distro, target.user].filter(Boolean).join(" · ") || "WSL";
    case "docker":
      return target.container;
    case "server":
      try {
        return new URL(target.url).host;
      } catch {
        return undefined;
      }
  }
}

/** 所有项目入口共用设备名回退；Server URL 只取地址，不能泄露 token。 */
export function formatRemoteDeviceName(
  target?: RemoteTarget,
  displayName?: string,
): string | undefined {
  if (displayName?.trim()) return displayName.trim();
  if (!target) return undefined;
  switch (target.kind) {
    case "ssh":
      return target.sshConfigAlias?.trim() || target.host;
    case "wsl":
      return target.distro?.trim() || "WSL";
    case "docker":
      return target.container;
    case "server":
      return target.name?.trim() || formatRemoteProjectConnectionAddress(target);
  }
}

export function formatRemoteConnectionDescription(target?: RemoteTarget): string {
  return target
    ? `${{ ssh: "SSH", wsl: "WSL", docker: "Docker", server: "HTTP" }[target.kind]} · ${formatRemoteProjectConnectionAddress(target) ?? ""}`
    : "";
}

export function formatConnectionProfileTarget(profile: ConnectionProfile): string {
  return formatRemoteProjectConnectionAddress(profile.target) ?? "";
}

const STATUS_PRIORITY: Record<RemoteConnectionStatus, number> = {
  offline: 0,
  failed: 1,
  pending: 2,
  connecting: 3,
  online: 4,
};

export function aggregateSourceStatus(
  states: ReadonlyArray<Pick<SourceServerConnectionStateSnapshot, "state">>,
): AggregatedSourceStatus {
  return states.reduce<AggregatedSourceStatus>((current, candidate) => {
    const next = resolveRemoteConnectionPresentation(candidate).status;
    return STATUS_PRIORITY[next] > STATUS_PRIORITY[current] ? next : current;
  }, "offline");
}

/** 活动连接优先于其他连接的旧失败；同态取最新快照，避免输入顺序决定用户状态。 */
export function getRemoteDevicePresentationInput(
  snapshot:
    | Pick<SourceServerManagementSnapshot, "servers" | "profiles" | "states">
    | null
    | undefined,
  sourceServerId: string,
): RemoteConnectionPresentationInput {
  const server = snapshot?.servers.find((candidate) => candidate.sourceServerId === sourceServerId);
  const profiles =
    snapshot?.profiles.filter(
      (profile) =>
        profile.sourceServerId === sourceServerId && profile.lifecycleState !== "retired",
    ) ?? [];
  const ids = new Set(profiles.map((profile) => profile.profileId));
  const states = snapshot?.states.filter((state) => ids.has(state.profileId)) ?? [];
  const selected = [...states].sort(
    (a, b) =>
      STATUS_PRIORITY[resolveRemoteConnectionPresentation(b).status] -
        STATUS_PRIORITY[resolveRemoteConnectionPresentation(a).status] || b.updatedAt - a.updatedAt,
  )[0];
  const profile =
    profiles.find((item) => item.profileId === selected?.profileId) ??
    profiles.find((item) => item.profileId === server?.preferredProfileId) ??
    profiles[0];
  return {
    ...selected,
    profileId: profile?.profileId,
    installState: server?.installState,
    target: profile?.target,
    displayName: server?.displayName ?? profile?.displayName,
  };
}

export function buildAggregatedSourceStatusMap(
  snapshot:
    | Pick<SourceServerManagementSnapshot, "servers" | "profiles" | "states">
    | null
    | undefined,
): ReadonlyMap<string, AggregatedSourceStatus> {
  return new Map(
    snapshot?.servers.map((server) => [
      server.sourceServerId,
      resolveRemoteConnectionPresentation(
        getRemoteDevicePresentationInput(snapshot, server.sourceServerId),
      ).status,
    ]) ?? [],
  );
}
