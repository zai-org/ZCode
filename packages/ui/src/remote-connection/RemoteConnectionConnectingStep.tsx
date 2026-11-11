import { redactFeedbackText } from "@zcode/shared";
import { usePlatform } from "@/hooks/usePlatform.js";
import { RemotePasswordInput } from "@/remote-connection/RemotePasswordInput.js";
import {
  classifyRemoteConnectionError,
  resolveRemoteConnectionPresentation,
} from "@/lib/remoteConnectionPresentation.js";
import {
  RemoteConnectionStatusTag,
  RemoteConnectionKindTag,
} from "@/remote-connection/RemoteConnectionTags.js";
import {
  DesktopCommandIds,
  type SourceServerInstallPreview,
  type SourceServerOperationLog,
  type SourceServerRunningTask,
} from "@zcode/shared";
/* eslint-disable max-lines -- 连接阶段清单、日志和错误恢复共享同一视图状态，保持原子交互。 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  AlertTriangleIcon,
  CheckIcon,
  ChevronRightIcon,
  LoaderCircle,
  MinusIcon,
  XIcon,
} from "lucide-react";
import { type RemoteTarget } from "@zcode/shared";
import { TID_SSH_ERROR } from "@zcode/shared/test-ids";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import type { RemoteConnectionLogEntry } from "@/hooks/useRemoteConnectionLogs.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useFeedbackStore } from "@/feedback/feedbackStore.js";
import {
  formatRemoteLinkRailTarget,
  formatRemoteLinkRailDevice,
} from "@/remote-connection/RemoteLinkRail.js";
import {
  isRemoteConnectionLogScrolledToLatest,
  scrollRemoteConnectionLogsToLatestIfFollowing,
} from "@/remote-connection/remoteConnectionLogScroll.js";

/** 连接向导与侧栏详情共用的用户阶段；原始 phase 的归并规则只在这里维护一份。 */
const REMOTE_CONNECTION_PHASES = [
  ["channel", "remote.phase.channel"],
  ["identify", "remote.phase.identify"],
  ["deploy", "remote.phase.deploy"],
  ["handshake", "remote.phase.handshake"],
  // 修复原因（R8）：带项目目录的连接在握手后还要让远端读取并登记该目录。这一步过去被算进
  // “启动并检查兼容性”，远端读目录卡住时用户看到的是兼容性检查一直转圈。设备级连接没有这一步。
  ["workspace", "remote.phase.workspace"],
] as const;

function remoteConnectionPhases(includeWorkspace: boolean) {
  return includeWorkspace
    ? REMOTE_CONNECTION_PHASES
    : REMOTE_CONNECTION_PHASES.filter(([key]) => key !== "workspace");
}

export type RemoteConnectionPhaseStatus = "pending" | "active" | "complete" | "failed";

function normalizeRemoteConnectionPhase(rawPhase: string): string | null {
  if (rawPhase === "probe") return "channel";
  if (rawPhase === "directory-record") return "identify";
  if (rawPhase === "publish-online") return "handshake";
  if (rawPhase === "daemon" || rawPhase === "protocol-handshake" || rawPhase === "restart")
    return "handshake";
  if (
    rawPhase === "download" ||
    rawPhase === "preflight" ||
    rawPhase === "upload" ||
    rawPhase === "extract" ||
    rawPhase === "verify-archive" ||
    rawPhase === "verify" ||
    rawPhase === "install"
  ) {
    return "deploy";
  }
  if (rawPhase === "channel") return "channel";
  return REMOTE_CONNECTION_PHASES.some(([key]) => key === rawPhase) ? rawPhase : null;
}

export function resolveRemoteConnectionPhases(
  logs: ReadonlyArray<Pick<RemoteConnectionLogEntry, "message" | "level">>,
  options: { connectionReady?: boolean; includeWorkspace?: boolean } = {},
) {
  const includeWorkspace = options.includeWorkspace === true;
  const phaseList = remoteConnectionPhases(includeWorkspace);
  let activeIndex = -1;
  let failedIndex = -1;
  for (const log of logs) {
    const match = /^\[source-server:([^\]]+)\]/u.exec(log.message);
    if (!match) continue;
    const normalized = normalizeRemoteConnectionPhase(match[1]!);
    // 设备级连接（目录为 /）也会读取目录，但不显示“打开项目目录”；它的结果归到最后一步。
    const phaseIndex = phaseList.findIndex(
      ([key]) =>
        key === (normalized === "workspace" && !includeWorkspace ? "handshake" : normalized),
    );
    if (phaseIndex < 0) continue;
    activeIndex = Math.max(activeIndex, phaseIndex);
    if (log.level === "error") failedIndex = phaseIndex;
  }
  // 修复原因：成功连接后 publish-online 不是 Renderer 日志流的可靠终结事件，
  // 仅按日志推断会出现顶部已连接但阶段轨永久停在握手中的状态。连接 session ready
  // 是同一条连接流程的权威终态；没有错误阶段时用它完成最终阶段，不改变连接中的日志进度。
  // 带项目目录时，Source 上线（publish-online）之后还有“打开项目目录”，只有窗口连接 ready 才算完成。
  const connectionReady =
    (options.connectionReady === true ||
      (!includeWorkspace &&
        logs.some((log) => log.message.startsWith("[source-server:publish-online]")))) &&
    failedIndex < 0;
  return phaseList.map(([key, titleId], index) => ({
    key,
    titleId,
    status: (failedIndex === index
      ? "failed"
      : connectionReady
        ? "complete"
        : index < activeIndex
          ? "complete"
          : index === activeIndex
            ? "active"
            : "pending") as RemoteConnectionPhaseStatus,
  }));
}

export interface RemoteOperationProgress {
  index: number;
  total: number;
  titleId: string;
  /** 仅最新一条是上传/下载进度时存在，0-100 整数。 */
  percent?: number;
  /** 本次操作首条日志时间；Host 每次新操作都会替换旧日志。 */
  startedAt?: number;
}

/** 侧栏详情只投影阶段与进度，不展示原始日志文本。 */
export function resolveRemoteOperationProgress(
  allLogs: ReadonlyArray<
    Pick<SourceServerOperationLog, "phase" | "progress" | "timestamp" | "level">
  >,
): RemoteOperationProgress {
  // 修复原因：Host 保留的是“最近一次操作”而非“进行中的操作”；断线后首次重试前、两次重试之间
  // 读到的是已结束的上一次操作，曾显示“第 4/4 步 · 已用 120 分”。终态（ready / error）
  // 说明该操作已结束，按尚无日志展示，等下一次尝试由 Host 替换日志。
  const tail = allLogs.at(-1);
  const logs = tail && (tail.phase === "ready" || tail.level === "error") ? [] : allLogs;
  // Source 的操作日志在上线（ready）时结束，不含“打开项目目录”；设备进度固定为四步。
  const phaseList = remoteConnectionPhases(false);
  let index = 0;
  for (const log of logs) {
    const key = normalizeRemoteConnectionPhase(log.phase);
    const found = phaseList.findIndex(([phase]) => phase === key);
    if (found > index) index = found;
  }
  const latest = logs.at(-1);
  const transfer =
    latest?.progress !== undefined && (latest.phase === "upload" || latest.phase === "download");
  return {
    index,
    total: phaseList.length,
    titleId: phaseList[index]![1],
    ...(transfer ? { percent: Math.floor(latest.progress! * 100) } : {}),
    ...(logs[0] ? { startedAt: logs[0].timestamp } : {}),
  };
}

/**
 * 阶段子说明（原型 s-sub）：只映射有结构化数据源的场景，映射不到时留空。
 * 原始英文日志不再直接透传，避免与原型中文说明混排。
 */
export function resolveRemoteConnectionPhaseSub(
  phase: { key: string; status: RemoteConnectionPhaseStatus },
  context: {
    kind?: RemoteTarget["kind"];
    recognizedDeviceName?: string;
    installConfirmationPending?: boolean;
    deployErrorReason?: string;
    rawPhase?: string;
    workspacePath?: string;
  },
): { id: string; values?: Record<string, string> } | null {
  switch (phase.key) {
    case "channel":
      return phase.status === "complete"
        ? {
            id:
              context.kind && context.kind !== "server"
                ? `remote.phaseSub.channelEstablished.${context.kind}`
                : "remote.phaseSub.channelEstablished",
          }
        : null;
    case "identify":
      if (context.recognizedDeviceName) {
        return {
          id: "remote.phaseSub.identifyExisting",
          values: { device: context.recognizedDeviceName },
        };
      }
      if (context.installConfirmationPending) {
        return { id: "remote.phaseSub.identifyNew" };
      }
      return null;
    case "deploy":
      if (phase.status === "failed" && context.deployErrorReason) {
        return {
          id: "remote.phaseSub.uploadFailed",
          values: { reason: context.deployErrorReason },
        };
      }
      if (context.installConfirmationPending) {
        return { id: "remote.phaseSub.deployWaitingConfirm" };
      }
      if (phase.status === "active") {
        const descriptions: Record<string, string> = {
          extract: "remote.phaseSub.extracting",
          "verify-archive": "remote.phaseSub.verifyingArchive",
          verify: "remote.phaseSub.verifyingFiles",
          install: "remote.phaseSub.installed",
        };
        const id = context.rawPhase && descriptions[context.rawPhase];
        if (id) return { id };
      }
      return null;
    case "handshake":
      return phase.status === "active" && context.rawPhase === "restart"
        ? { id: "remote.phaseSub.restarting" }
        : null;
    case "workspace":
      return phase.status === "active" && context.workspacePath
        ? { id: "remote.phaseSub.workspaceReading", values: { path: context.workspacePath } }
        : null;
    case "ready":
      return phase.status === "complete" || phase.status === "active"
        ? { id: "remote.phaseSub.readyOnline" }
        : null;
    default:
      return null;
  }
}

export function RemoteConnectionConnectingStep({
  kind,
  logs,
  errorMessage,
  errorCode,
  rawError,
  upgradeTarget,
  loading,
  installConfirmation,
  target,
  recognizedDeviceName,
  profileName,
  onUseRemoteDownload,
  onBack,
  onRetry,
  upgradeRequired = false,
  upgradeLoading = false,
  updateCancelable = false,
  onUpgrade,
  downgradedFrom,
  downgradeVersion,
  onDowngrade,
  onReinstall,
  connectionReady = false,
  cancelled = false,
  onCancelConnection,
  credentials,
  forceUpdate,
  onMinimize,
  onClose,
  onBackToDevices,
  backToDevicesLabel,
  workspacePath,
}: {
  /** 本次连接要打开的远端项目目录；有值时显示“打开项目目录”这一步。 */
  workspacePath?: string;
  forceUpdate?: { tasks?: SourceServerRunningTask[]; onConfirm: () => void; onCancel: () => void };
  credentials?: {
    passphrase: boolean;
    value: string;
    onChange: (value: string) => void;
    onSubmit: () => void;
  };
  onMinimize?: () => void;
  onClose?: () => void;
  onBackToDevices?: () => void;
  backToDevicesLabel?: string;
  kind: RemoteTarget["kind"];
  logs: RemoteConnectionLogEntry[];
  errorMessage: string;
  errorCode?: string;
  rawError?: string;
  upgradeTarget?: "controller" | "server";
  loading: boolean;
  installConfirmation?: {
    target: RemoteTarget;
    preview?: SourceServerInstallPreview;
    onConfirm: () => void;
    onCancel: () => void;
  };
  target?: RemoteTarget | null;
  recognizedDeviceName?: string;
  profileName?: string;
  recognizedDeviceMeta?: string;
  localVersion?: string;
  onUseRemoteDownload?: () => void;
  onBack: () => void;
  onRetry: () => void;
  upgradeRequired?: boolean;
  upgradeLoading?: boolean;
  /** 向导持有的更新处于本机阶段，「取消连接」可用（R3 §6.3）；只在 upgradeLoading 时生效。 */
  updateCancelable?: boolean;
  onUpgrade?: () => void;
  /** 远端被旧版 Desktop 显式切回时被替换的版本；向导据此等待用户确认更新。 */
  downgradedFrom?: string;
  /** Desktop 较旧时可把远端切换到的本机版本。 */
  downgradeVersion?: string;
  onDowngrade?: () => void;
  /** 「重新安装远端服务」（RDRI-01）；只在连接失败时显示，可用规则由向导按同一 helper 决定。 */
  onReinstall?: () => void;
  connectionReady?: boolean;
  cancelled?: boolean;
  onCancelConnection?: () => void;
  onContinueToDirectory?: () => void;
}) {
  const { intl } = useZCodeIntl();
  const credentialInputId = useId();
  const platform = usePlatform();
  const openFeedbackSubmit = useFeedbackStore((state) => state.openSubmit);
  const logContainerRef = useRef<HTMLDivElement | null>(null);
  const shouldFollowLatestLogRef = useRef(true);
  const latestLogId = logs.at(-1)?.id;
  const latestLogTimestamp = logs.at(-1)?.timestamp;
  const [now, setNow] = useState(Date.now);
  const [mountedAt] = useState(Date.now);
  useEffect(() => {
    if (!loading) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [loading]);
  const waitingPhase = credentials
    ? "channel"
    : installConfirmation || forceUpdate
      ? "deploy"
      : undefined;
  const phases = resolveRemoteConnectionPhases(logs, {
    connectionReady,
    includeWorkspace: Boolean(workspacePath),
  }).map((phase, index, all) => {
    const waitingIndex = all.findIndex((item) => item.key === waitingPhase);
    if (waitingIndex >= 0)
      return {
        ...phase,
        status: (index < waitingIndex
          ? "complete"
          : index === waitingIndex
            ? "active"
            : "pending") as RemoteConnectionPhaseStatus,
      };
    if (loading && !logs.length && index === 0) return { ...phase, status: "active" as const };
    return phase;
  });
  const logTime = (timestamp: string) => {
    const parts = String(timestamp).match(/(\d{1,2}):(\d{2}):(\d{2})/u);
    if (!parts) return mountedAt;
    const wallNow = Date.now();
    const date = new Date(wallNow);
    date.setHours(Number(parts[1]), Number(parts[2]), Number(parts[3]), 0);
    // 展示时钟可能落后新日志不到一秒；只有明显跨日才回退，不能把新日志误判为昨天。
    if (date.getTime() - wallNow > 12 * 60 * 60 * 1000) date.setDate(date.getDate() - 1);
    return date.getTime();
  };
  const deploymentFailedLog = [...logs]
    .reverse()
    .find(
      (entry) =>
        entry.level === "error" &&
        /^\[source-server:(?:download|preflight|upload|install)\]/u.test(entry.message),
    );
  const errorPresentation = classifyRemoteConnectionError({
    errorCode: credentials && !errorCode ? "credentials-required" : errorCode,
    error: rawError ?? errorMessage,
    target: target ?? undefined,
    upgradeTarget,
  });
  const presentation = resolveRemoteConnectionPresentation({
    state: forceUpdate
      ? "needs-upgrade"
      : upgradeLoading
        ? "updating"
        : installConfirmation
          ? "needs-install"
          : loading
            ? "bootstrapping"
            : upgradeRequired
              ? "needs-upgrade"
              : errorMessage
                ? "failed"
                : connectionReady
                  ? "online"
                  : "absent",
    errorCode: credentials && !errorCode ? "credentials-required" : errorCode,
    error: rawError ?? errorMessage,
    upgradeTarget,
    target: target ?? undefined,
    wizard: true,
  });
  const failed = presentation.status === "failed" && !loading && !cancelled;
  const errorDetailsRef = useRef<HTMLDetailsElement>(null);
  const [logsExpanded, setLogsExpanded] = useState(Boolean(errorMessage));

  useEffect(() => {
    if (errorMessage) setLogsExpanded(true);
  }, [errorMessage]);

  const handleLogContainerScroll = useCallback(() => {
    const container = logContainerRef.current;
    if (!container) {
      return;
    }

    shouldFollowLatestLogRef.current = isRemoteConnectionLogScrolledToLatest(container);
  }, []);

  useEffect(() => {
    const container = logContainerRef.current;
    if (!container) {
      return;
    }

    // 日志持续追加会推高 scrollHeight，无条件写 scrollTop 会把向上查看历史日志的用户拉回底部。
    // 这里只在用户原本贴底时继续跟随最新日志。
    if (
      scrollRemoteConnectionLogsToLatestIfFollowing(container, shouldFollowLatestLogRef.current)
    ) {
      shouldFollowLatestLogRef.current = true;
    }
  }, [logs.length, latestLogId, latestLogTimestamp]);

  const handleOpenFeedback = async () => {
    // 入口草稿曾显式关闭日志，覆盖表单默认值，导致连接反馈只有正文而没有诊断附件。
    // 新反馈统一默认开启，用户仍可在表单中取消勾选；正文保留脱敏连接日志。
    openFeedbackSubmit({
      title:
        errorMessage.slice(0, 80) ||
        intl.formatMessage({ id: "feedback.submit.template.section.remoteConnectFailed" }),
      type: "bug",
      module: kind === "ssh" ? "SSH连接失败" : kind === "wsl" ? "WSL连接失败" : "Agent任务执行失败",
      severity: "P2-中",
      includeLogs: true,
      description: buildRemoteConnectionFeedbackDescription(errorMessage, logs, (id, values) =>
        intl.formatMessage({ id }, values),
      ),
      screenshots: [],
    });
  };

  const installPanel = installConfirmation ? (
    // 安装确认是阶段内的中性信息面板，圆角比所属阶段行低一级。
    <div className="mt-2 flex items-start gap-3 rounded-sm border border-border bg-background px-3.5 py-3 text-ui-sm text-foreground">
      <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1 space-y-2">
        <p className="font-medium">
          {intl.formatMessage({ id: "remote.sourceServerInstallTitle" })}
        </p>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-ui-xs">
          <dt className="text-remote-foreground-muted">
            {intl.formatMessage({ id: "remote.installTarget" })}
          </dt>
          <dd className="font-mono">{formatInstallTarget(installConfirmation.target)}</dd>
          <dt className="text-remote-foreground-muted">
            {intl.formatMessage({ id: "remote.installVersion" })}
          </dt>
          <dd className="font-mono" data-testid="remote-install-version">
            {installConfirmation.preview?.version ??
              intl.formatMessage({ id: "remote.infoUnavailable" })}
          </dd>
          <dt className="text-remote-foreground-muted">
            {intl.formatMessage({ id: "remote.installLocation" })}
          </dt>
          <dd className="break-all font-mono" data-testid="remote-install-path">
            {installConfirmation.preview?.installPath ??
              intl.formatMessage({ id: "remote.infoUnavailable" })}
          </dd>
          <dt className="text-remote-foreground-muted">
            {intl.formatMessage({ id: "remote.installSize" })}
          </dt>
          <dd className="font-mono">
            {installConfirmation.preview
              ? `${(installConfirmation.preview.sizeBytes / 1048576).toFixed(1)} MB`
              : intl.formatMessage({ id: "remote.infoUnavailable" })}
          </dd>
        </dl>
        <div className="flex flex-wrap gap-2 pt-1">
          <Button type="button" size="sm" onClick={installConfirmation.onConfirm}>
            {intl.formatMessage({
              id: "remote.sourceServerInstallConfirm",
            })}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={installConfirmation.onCancel}
          >
            {intl.formatMessage({ id: "common.cancel" })}
          </Button>
        </div>
      </div>
    </div>
  ) : null;
  const errorPanel =
    errorMessage || credentials ? (
      // 错误和凭据等待嵌入所属阶段；详细日志只在失败后展开。
      <div
        data-testid={TID_SSH_ERROR}
        className={cn(
          "space-y-2 rounded-sm border px-3.5 py-3",
          presentation.border,
          presentation.surface,
        )}
      >
        <p
          className={cn("flex items-center gap-2 text-ui-sm font-medium", presentation.foreground)}
        >
          {upgradeLoading ? (
            <LoaderCircle className="size-4 shrink-0 animate-spin" />
          ) : (
            <AlertTriangleIcon className="size-4 shrink-0" />
          )}
          {intl.formatMessage({
            id: upgradeLoading
              ? presentation.shortMessageId
              : credentials && !errorMessage
                ? "remote.error.credentialsRequired"
                : errorPresentation.titleId,
          })}
        </p>
        {!upgradeLoading && errorMessage ? (
          <>
            <p className="text-ui-xs text-remote-foreground-muted">
              {intl.formatMessage({ id: errorPresentation.reasonId })}
            </p>
            {upgradeRequired && downgradedFrom ? (
              <p className="text-ui-xs text-remote-foreground-muted">
                {intl.formatMessage(
                  { id: "remote.downgradedHint" },
                  { from: downgradedFrom.replace(/^v/iu, "") },
                )}
              </p>
            ) : null}
            <details ref={errorDetailsRef} className="text-ui-xs text-remote-foreground-muted">
              <summary className="cursor-pointer">
                {intl.formatMessage({ id: "remote.error.details" })}
              </summary>
              <pre className="whitespace-pre-wrap break-words">{rawError ?? errorMessage}</pre>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  void navigator.clipboard.writeText(rawError ?? errorMessage);
                }}
              >
                {intl.formatMessage({ id: "chat.toolCall.copyError" })}
              </Button>
            </details>
          </>
        ) : null}
        {credentials ? (
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              credentials.onSubmit();
            }}
          >
            <label htmlFor={credentialInputId} className="block text-ui-sm">
              {intl.formatMessage({
                id: credentials.passphrase ? "ssh.privateKeyPassphrase" : "ssh.password",
              })}
            </label>
            <RemotePasswordInput
              id={credentialInputId}
              autoFocus
              required
              className="mt-1"
              data-testid={
                credentials.passphrase ? "ssh-private-key-passphrase-input" : "ssh-password-input"
              }
              value={credentials.value}
              onChange={(event) => credentials.onChange(event.target.value)}
            />
            <Button type="submit" size="sm" disabled={loading || !credentials.value}>
              {intl.formatMessage({ id: "remote.startConnection" })}
            </Button>
          </form>
        ) : null}
        <div className="flex flex-wrap gap-2 pt-1">
          {!credentials ? (
            <Button
              type="button"
              size="sm"
              onClick={() => {
                if (presentation.primaryAction === "cancel") onCancelConnection?.();
                else if (presentation.primaryAction === "update-desktop")
                  void platform.executeDesktopCommand(DesktopCommandIds.CheckForUpdates);
                else if (presentation.primaryAction === "update-server" && onUpgrade) onUpgrade();
                // Bug 原因：等待安装确认时，这个按钮显示“安装并连接”，旧逻辑却落到不带确认的
                // onRetry，再次得到“需要确认安装”。有安装确认时执行与安装面板相同的确认动作。
                else if (presentation.primaryAction === "install" && installConfirmation)
                  installConfirmation.onConfirm();
                else if (
                  ["credentials", "edit-auth", "edit-host"].includes(presentation.primaryAction)
                )
                  onBack();
                else if (["security", "details"].includes(presentation.primaryAction)) {
                  if (errorDetailsRef.current) errorDetailsRef.current.open = true;
                } else onRetry();
              }}
              // Bug 原因（ZCT-2117527614209818624）：更新期间这里一直禁用，本机下载卡住时用户无法退出。
              // 本机阶段由 Host 报告可取消；进入远端阶段后仍禁用。
              disabled={upgradeLoading ? !updateCancelable : loading}
            >
              {upgradeLoading ? (
                <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
              ) : null}
              {intl.formatMessage({
                id: presentation.actionMessageId,
              })}
            </Button>
          ) : null}
          {failed && !credentials && onReinstall ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              data-source-server-reinstall
              onClick={onReinstall}
              disabled={loading || upgradeLoading}
            >
              {intl.formatMessage({ id: "settings.source.reinstallRemoteService" })}
            </Button>
          ) : null}
          {presentation.primaryAction === "update-desktop" && onDowngrade && downgradeVersion ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={onDowngrade}
              disabled={loading || upgradeLoading}
            >
              {intl.formatMessage(
                { id: "remote.action.downgrade-server" },
                { version: downgradeVersion.replace(/^v/iu, "") },
              )}
            </Button>
          ) : null}
          {onUseRemoteDownload && errorPresentation.allowRemoteDownload ? (
            <Button type="button" variant="secondary" size="sm" onClick={onUseRemoteDownload}>
              {intl.formatMessage({ id: "remote.useRemoteDownload" })}
            </Button>
          ) : null}
          {/* Bug 原因（ZCT-2116085848489570304）：更新进行中返回配置再连接，会在上传期间对同一设备
              再发起一次连接，打断更新的展示与原意图。更新期间始终禁用；本机阶段要退出时用「取消连接」。 */}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onBack}
            disabled={loading || upgradeLoading}
          >
            {intl.formatMessage({ id: "remote.backToConnection" })}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              void handleOpenFeedback();
            }}
          >
            {intl.formatMessage({ id: "remoteConnection.feedback" })}
          </Button>
        </div>
      </div>
    ) : null;
  const errorPhase = credentials
    ? "channel"
    : errorCode === "source-server-identity-change-pending"
      ? "identify"
      : (phases.find((phase) => phase.status === "failed")?.key ??
        phases.find((phase) => phase.status === "active")?.key ??
        "channel");
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 ">
      <div className="flex flex-col flex-1 min-h-0 space-y-4 overflow-y-auto">
        <div className="shrink-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-ui-base font-semibold">
              {recognizedDeviceName ??
                profileName ??
                (target
                  ? formatRemoteLinkRailDevice(target)
                  : intl.formatMessage({ id: "remote.phase.channel" }))}
            </h3>
            {kind === "server" ? (
              <span className="text-ui-xs">Server</span>
            ) : (
              <RemoteConnectionKindTag kind={kind} />
            )}
            {cancelled ? null : <RemoteConnectionStatusTag presentation={presentation} />}
          </div>
          {target ? (
            <p className="break-all font-mono text-ui-sm text-remote-foreground-muted">
              {formatRemoteLinkRailTarget(target)}
            </p>
          ) : null}
        </div>
        <ol data-testid="remote-connection-stages" className="shrink-0 space-y-0.5 py-1">
          {phases.map((phase, phaseIndex) => {
            const phaseStart = logs.find((entry) => {
              const raw = /^\[source-server:([^\]]+)\]/u.exec(entry.message)?.[1];
              return raw && normalizeRemoteConnectionPhase(raw) === phase.key;
            });
            const nextStart = logs.find((entry) => {
              const raw = /^\[source-server:([^\]]+)\]/u.exec(entry.message)?.[1];
              return (
                raw &&
                phases.findIndex((item) => item.key === normalizeRemoteConnectionPhase(raw)) >
                  phaseIndex
              );
            });
            const phaseLog = [...logs].reverse().find((entry) => {
              const match = /^\[source-server:([^\]]+)\]/u.exec(entry.message);
              return match && normalizeRemoteConnectionPhase(match[1]!) === phase.key;
            });
            const rawPhase = /^\[source-server:([^\]]+)\]/u.exec(phaseLog?.message ?? "")?.[1];
            const progressMatch =
              phase.status === "active" && (rawPhase === "upload" || rawPhase === "download")
                ? phaseLog?.message.match(/(\d+(?:\.\d+)?)%/u)
                : null;
            const transfer = phaseLog?.message.match(
              /(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?) MB, (\d+(?:\.\d+)?) MB\/s/u,
            );
            const remainingSeconds =
              transfer && Number(transfer[3]) > 0
                ? Math.max(
                    0,
                    Math.ceil((Number(transfer[2]) - Number(transfer[1])) / Number(transfer[3])),
                  )
                : undefined;
            const phaseSub = resolveRemoteConnectionPhaseSub(phase, {
              kind,
              rawPhase,
              recognizedDeviceName,
              installConfirmationPending: Boolean(installConfirmation),
              workspacePath,
              deployErrorReason: deploymentFailedLog?.message.replace(
                /^\[source-server:[^\]]+\]\s*/u,
                "",
              ),
            });
            return (
              <li
                key={phase.key}
                className={cn(
                  "relative flex shrink-0 min-w-0 items-start gap-3 rounded-md px-2.5 py-2 text-ui-sm",
                  // 原型 .stages li.cur：当前阶段行有 surface 底色高亮。
                  phase.status === "active" && "bg-surface",
                )}
              >
                {phaseIndex < phases.length - 1 ? (
                  <span
                    aria-hidden="true"
                    className="absolute left-5 top-8 bottom-0 border-l border-border"
                  />
                ) : null}
                <span
                  className={cn(
                    "relative z-10 mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border",
                    phase.status === "complete"
                      ? "border-success bg-success-surface text-success-surface-foreground"
                      : phase.status === "active"
                        ? phase.key === waitingPhase
                          ? "border-warning text-warning"
                          : "border-progress-surface-foreground text-progress-surface-foreground"
                        : phase.status === "failed"
                          ? "border-destructive text-destructive"
                          : "border-border text-remote-foreground-muted",
                  )}
                >
                  {phase.status === "complete" ? (
                    <CheckIcon className="size-3" />
                  ) : phase.key === waitingPhase ? (
                    <AlertTriangleIcon className="size-3 text-warning" />
                  ) : phase.status === "active" ? (
                    <LoaderCircle className="size-3 animate-spin" />
                  ) : phase.status === "failed" ? (
                    <XIcon className="size-3" />
                  ) : (
                    <span className="size-1.5 rounded-full bg-current" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={
                        phase.status === "pending"
                          ? "text-remote-foreground-muted"
                          : phase.status === "active"
                            ? "text-foreground font-semibold"
                            : "text-foreground"
                      }
                    >
                      {intl.formatMessage({
                        id:
                          phase.key === "channel" && kind !== "server"
                            ? `remote.phase.channel.${kind}`
                            : phase.titleId,
                      })}
                    </span>
                    {phaseStart || phase.status === "active" ? (
                      <span className="text-ui-xs tabular-nums text-remote-foreground-muted">
                        {Math.max(
                          0,
                          Math.floor(
                            ((phase.status === "complete" && nextStart
                              ? logTime(nextStart.timestamp)
                              : loading
                                ? now
                                : phaseLog
                                  ? logTime(phaseLog.timestamp)
                                  : now) -
                              (phaseStart ? logTime(phaseStart.timestamp) : mountedAt)) /
                              1000,
                          ),
                        )}{" "}
                        s
                      </span>
                    ) : null}
                  </div>
                  {phaseSub ? (
                    <p className="break-words text-ui-xs text-remote-foreground-muted">
                      {intl.formatMessage({ id: phaseSub.id }, phaseSub.values)}
                    </p>
                  ) : null}
                  {phase.key === "deploy" &&
                  !phaseSub &&
                  rawPhase &&
                  phase.status === "active" &&
                  ["download", "upload", "extract", "verify-archive", "verify", "install"].includes(
                    rawPhase,
                  ) ? (
                    <p className="mt-1 text-ui-xs text-remote-foreground-muted">
                      {intl.formatMessage({
                        id:
                          rawPhase === "download"
                            ? "remote.phaseSub.downloading"
                            : rawPhase === "upload"
                              ? "remote.phaseSub.uploading"
                              : rawPhase === "extract"
                                ? "remote.phaseSub.extracting"
                                : "remote.phaseSub.verifyingFiles",
                      })}
                    </p>
                  ) : null}
                  {phase.key === "deploy" ? installPanel : null}
                  {phase.key === "deploy" && forceUpdate ? (
                    <div className="mt-2 space-y-2 rounded-sm bg-warning-surface p-3 text-warning-surface-foreground">
                      <p className="font-medium">
                        {intl.formatMessage({ id: "settings.source.forceUpdateTitle" })}
                      </p>
                      <p>
                        {intl.formatMessage({
                          id: "settings.source.forceUpdateDescription",
                        })}
                      </p>
                      {forceUpdate.tasks?.length ? (
                        <ul className="space-y-1">
                          {forceUpdate.tasks.map((task) => (
                            <li
                              key={`${task.workspaceIdentity ?? task.workspacePath}:${task.sessionId}`}
                              className="break-all text-ui-sm"
                            >
                              <span>{task.sessionId}</span>
                              <span className="ml-2 font-mono">{task.workspacePath}</span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p>
                          {intl.formatMessage({
                            id: "remote.runningTasksUnavailable",
                          })}
                        </p>
                      )}
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          onClick={forceUpdate.onConfirm}
                        >
                          {intl.formatMessage({ id: "settings.source.forceUpdate" })}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          onClick={forceUpdate.onCancel}
                        >
                          {intl.formatMessage({ id: "remote.cancelConnection" })}
                        </Button>
                      </div>
                    </div>
                  ) : null}
                  {phase.key === errorPhase && !forceUpdate ? errorPanel : null}
                  {progressMatch ? (
                    <p className="mt-1 text-ui-xs tabular-nums text-remote-foreground-muted">
                      {phaseLog?.message.match(/\([^)]+MB[^)]*\)/u)?.[0]}
                      {" · "}
                      {intl.formatMessage(
                        {
                          id:
                            remainingSeconds === undefined
                              ? "remote.transferTimeUnknown"
                              : "remote.transferTimeRemaining",
                        },
                        { seconds: remainingSeconds ?? 0 },
                      )}
                    </p>
                  ) : null}
                  {progressMatch ? (
                    <div
                      role="progressbar"
                      aria-label={intl.formatMessage({
                        id:
                          rawPhase === "download"
                            ? "remote.phaseSub.downloading"
                            : "remote.phaseSub.uploading",
                      })}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Number(progressMatch[1])}
                      className="mt-1.5 h-1 max-w-sm overflow-hidden rounded-full bg-surface"
                    >
                      <div
                        className="h-full rounded-full bg-progress-surface-foreground"
                        style={{ width: `${progressMatch[1]}%` }}
                      />
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
        {/* 日志区使用 max-h-48 语义档位，避免把原型 180px 固化为组件专属高度。 */}
        <div className="flex flex-col">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="self-start px-0"
            onClick={() => setLogsExpanded((expanded) => !expanded)}
          >
            <ChevronRightIcon
              className={cn("size-3.5 transition-transform", logsExpanded && "rotate-90")}
            />
            {intl.formatMessage({ id: "remote.connectionLog" })}
            <span className="text-remote-foreground-muted">
              {intl.formatMessage(
                { id: "remote.connectionLogLines" },
                { count: String(logs.length) },
              )}
            </span>
          </Button>
          {logsExpanded ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="self-end"
              onClick={() => {
                void navigator.clipboard.writeText(
                  logs
                    .map((entry) => `${entry.timestamp} [${entry.level}] ${entry.message}`)
                    .join("\n"),
                );
              }}
            >
              {intl.formatMessage({ id: "remote.copyLog" })}
            </Button>
          ) : null}
          {logsExpanded ? (
            <div
              data-testid="remote-connection-log"
              ref={logContainerRef}
              onScroll={handleLogContainerScroll}
              className="mt-1 max-h-48 space-y-1 overflow-y-auto rounded-lg border border-border bg-background px-3 py-2 font-mono text-ui-xs leading-6"
            >
              {logs.length > 0 ? (
                logs.map((entry) => (
                  <div key={entry.id} className="w-full flex min-w-0 text-foreground">
                    <span className="text-remote-foreground-muted">{entry.timestamp}</span>
                    <span
                      className={cn(
                        "mx-2",
                        entry.level === "success"
                          ? "text-success"
                          : entry.level === "warn"
                            ? "text-warning"
                            : entry.level === "error"
                              ? "text-destructive"
                              : "text-remote-foreground-muted",
                      )}
                    >
                      [{entry.level.toUpperCase()}]
                    </span>
                    <span>{entry.message}</span>
                  </div>
                ))
              ) : (
                <div className="flex items-center justify-center py-2 text-remote-foreground-muted">
                  <span>[INFO] {intl.formatMessage({ id: "remote.connectionLogEmpty" })}</span>
                </div>
              )}
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border pt-3">
        {failed || onMinimize ? (
          <Button type="button" variant="ghost" onClick={failed ? onBackToDevices : onMinimize}>
            {failed ? null : <MinusIcon className="size-4" />}
            {failed && backToDevicesLabel
              ? backToDevicesLabel
              : intl.formatMessage({
                  id: failed ? "remote.selection.back" : "remote.continueInBackground",
                })}
          </Button>
        ) : (
          <span />
        )}
        <Button
          type="button"
          variant="secondary"
          disabled={upgradeLoading && !updateCancelable}
          onClick={failed ? onClose : cancelled ? onRetry : onCancelConnection}
        >
          {intl.formatMessage({
            id: failed ? "common.close" : cancelled ? "common.retry" : "remote.cancelConnection",
          })}
        </Button>
      </div>
    </div>
  );
}

// 原型安装确认表格「目标账号」列直接展示 user@host:port，不再包整句文案。
function formatInstallTarget(target: RemoteTarget): string {
  if (target.kind === "ssh") {
    return `${target.username}@${target.host}:${target.port ?? 22}`;
  }
  if (target.kind === "wsl")
    return ["WSL", target.distro ?? "default", target.user].filter(Boolean).join(" · ");
  if (target.kind === "docker") return `Docker · ${target.container}`;
  return target.url;
}

function buildRemoteConnectionFeedbackDescription(
  errorMessage: string,
  logs: RemoteConnectionLogEntry[],
  formatMessage: (id: string, values?: Record<string, string>) => string,
) {
  const logText = logs
    .slice(-30)
    .map((entry) => `${entry.timestamp} [${entry.level.toUpperCase()}] ${entry.message}`)
    .join("\n");
  return redactFeedbackText(
    [
      formatMessage("feedback.submit.template.section.remoteHeading"),
      "",
      formatMessage("feedback.submit.template.section.errorSummary"),
      errorMessage || formatMessage("feedback.submit.template.section.notProvided"),
      "",
      formatMessage("feedback.submit.template.section.remoteLog"),
      logText || formatMessage("feedback.submit.template.section.remoteLogEmpty"),
      "",
      formatMessage("feedback.submit.template.section.remoteEnvironment"),
      formatMessage("feedback.submit.template.section.supplement"),
    ].join("\n"),
  );
}
