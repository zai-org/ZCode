/* eslint-disable max-lines -- 远程连接向导的多个步骤暂集中在同一文件，避免拆分时扩大 SSH/Docker/WSL 回归面。 */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AppSettings,
  DockerContainerInfo,
  RemoteAssetInstallMode,
  RemoteTarget,
  RemoteWorkspaceSessionEntry,
  SourceServerWorkspaceHistoryEntry,
  SSHConfigAliasOption,
  WSLDistro,
} from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import { TID_SSH_CONFIG_IMPORT } from "@zcode/shared/test-ids";
import {
  AlertTriangleIcon,
  ArrowLeftIcon,
  CheckIcon,
  ChevronDownIcon,
  FileCodeIcon,
  FolderIcon,
  LoaderCircle,
} from "lucide-react";
import { DirectoryBrowser } from "@/DirectoryBrowser.js";
import {
  RemoteConnectionFields,
  RemoteSegmentedControl,
  SshConfigAliasPicker,
} from "@/RemoteConnectionFields.js";
import type { SSHAuthMethod } from "@/hooks/useRemoteConnectionForm.js";
import type { RemoteFormFieldError } from "@/lib/remoteConnectionWizard.js";
import { REMOTE_KIND_PRESENTATION } from "@/remote-connection/RemoteConnectionTags.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useOptionalBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { ensureSourceServerBoundaryAcknowledged } from "@/lib/sourceServerBoundaryOnboarding.js";
import { logger } from "@/logger.js";
import { type AppSettingsConversationWorkspaceMap } from "@/remote/remoteWorkspaceProjection.js";
import {
  DataSyncEntryDropdownButton,
  isDataSyncEntryRemoteTarget,
  useDataSyncDeviceOnline,
  useDataSyncEntry,
} from "@/data-sync/index.js";
export { RemoteConnectionConnectingStep } from "@/remote-connection/RemoteConnectionConnectingStep.js";

/** 旧字段包含展示即已读，且扩到 3 会破坏回滚；只在有效确认后写新介绍标记。 */
export function useRemoteBoundaryAcknowledgement() {
  const settingService = useOptionalBaseWorkspaceServices()?.settingService;
  const syncAppSettings = useOptionalPlatform()?.syncAppSettings;
  const confirm = useConfirmDialog();
  const { intl } = useZCodeIntl();
  return useCallback(
    async (isCurrent: () => boolean, onBlocked?: () => void): Promise<boolean> => {
      if (!settingService) return isCurrent();
      try {
        const settings = await settingService.get();
        if (!isCurrent()) return false;
        if (settings.remoteBoundaryIntroAcknowledgedVersion === 1) return true;
        // 全局确认框拒绝并发请求；完成动作由调用方保留，不能把占用误当用户取消。
        if (useConfirmDialogStore.getState().pendingRequest) {
          onBlocked?.();
          return false;
        }
        return await ensureSourceServerBoundaryAcknowledged({
          currentVersion: settings.remoteBoundaryIntroAcknowledgedVersion,
          targetVersion: 1,
          isCurrent,
          requestAcknowledgement: () =>
            confirm({
              intent: "source-server-boundary",
              presentation: "source-server-boundary",
              title: intl.formatMessage({ id: "remote.sourceServerBoundaryTitle" }),
              description: intl.formatMessage({ id: "remote.sourceServerBoundaryDescription" }),
              confirmLabel: intl.formatMessage({ id: "common.gotIt" }),
              requiredAcknowledgement: true,
              showKeyboardHints: false,
            }),
          persistVersion: async (version) => {
            const patch = {
              remoteBoundaryIntroAcknowledgedVersion: version,
            } satisfies Partial<AppSettings>;
            await settingService.update(patch);
            syncAppSettings?.(patch);
          },
        });
      } catch (cause) {
        // 说明的读取/保存失败不能伪装成远程连接失败；保持未读，下一次主动使用重试。
        logger.warn("[RemoteBoundaryAcknowledgement] 读取或保存远程介绍状态失败", cause);
        return isCurrent();
      }
    },
    [settingService, syncAppSettings, confirm, intl],
  );
}

function getPathBasename(workspacePath: string): string {
  return workspacePath.split(/[\\/]/u).filter(Boolean).at(-1) ?? workspacePath;
}

export function getRecentRemoteWorkspaceHistory(
  history: readonly SourceServerWorkspaceHistoryEntry[],
  remoteConversationWorkspaceBySourceServerId?: AppSettingsConversationWorkspaceMap,
): SourceServerWorkspaceHistoryEntry[] {
  // Bug 原因：Directory 记录按追加顺序保存，直接 slice(0, 3) 会把最旧目录当成最近目录；
  // 且未过滤隐藏目录，`.zcode` 之类内部路径会挤占「最近目录」位（原型 L996-999 只展示常规工作区）。
  return [...history]
    .filter(
      (entry) =>
        !getPathBasename(entry.workspacePath).startsWith(".") &&
        remoteConversationWorkspaceBySourceServerId?.[entry.sourceServerId ?? ""]?.workspacePath !==
          entry.workspacePath,
    )
    .sort((left, right) => right.lastOpenedAt - left.lastOpenedAt);
}

/** 设备摘要只显示用户可读信息，设备标识留在设置详情中。 */
export function formatDeviceCardMeta(server: {
  sourceServerId: string;
  osUser?: string;
  lastSeenVersion?: string;
}): string {
  return [server.osUser, server.lastSeenVersion ? `v${server.lastSeenVersion}` : null]
    .filter(Boolean)
    .join(" · ");
}

export function RemoteConnectionSettingsStep({
  focusCredentials,
  kind,
  availableKinds,
  onKindChange,
  host,
  port,
  username,
  sshAuthMethod,
  assetInstallMode,
  password,
  privateKeyPath,
  privateKeyPassphrase,
  wslDistro,
  wslUser = "",
  wslDistros,
  dockerContainer,
  manualDockerContainer,
  serverUrl,
  serverName,
  serverToken,
  serverWorkspacePath,
  dockerContainers,
  dockerAvailable,
  sshConfigAliases,
  sshConfigAliasesLoading,
  sshConfigAliasesError,
  selectedSshConfigAlias,
  currentRuntimeOptionsLoading,
  currentRuntimeOptionsError,
  remoteWorkspaceSessions = [],
  fieldErrors = [],
  validationAttempt = 0,
  connectLabel,
  loading,
  onBack,
  onHostChange,
  onPortChange,
  onUsernameChange,
  onSshAuthMethodChange,
  onAssetInstallModeChange,
  onPasswordChange,
  onPrivateKeyPathChange,
  onPrivateKeyPassphraseChange,
  onWslDistroChange,
  onWslUserChange,
  onDockerContainerChange,
  onManualDockerContainerChange,
  onServerUrlChange,
  onServerNameChange,
  onServerTokenChange,
  onServerWorkspacePathChange,
  onDockerContainersRefresh,
  onApplySshConfigAlias,
  onClearSelectedSshConfigAlias,
  onConnect,
}: {
  focusCredentials?: boolean;
  kind: RemoteTarget["kind"];
  availableKinds?: RemoteTarget["kind"][];
  onKindChange?: (kind: RemoteTarget["kind"]) => void;
  host: string;
  port: string;
  username: string;
  sshAuthMethod: SSHAuthMethod;
  assetInstallMode: RemoteAssetInstallMode;
  password: string;
  privateKeyPath: string;
  privateKeyPassphrase: string;
  wslDistro: string;
  wslUser?: string;
  wslDistros: WSLDistro[];
  dockerContainer: string;
  manualDockerContainer: string;
  serverUrl: string;
  serverName: string;
  serverToken: string;
  serverWorkspacePath: string;
  dockerContainers: DockerContainerInfo[];
  dockerAvailable: boolean | null;
  sshConfigAliases: SSHConfigAliasOption[];
  sshConfigAliasesLoading: boolean;
  sshConfigAliasesError: string;
  selectedSshConfigAlias: string | null;
  currentRuntimeOptionsLoading: boolean;
  currentRuntimeOptionsError: string;
  remoteWorkspaceSessions?: RemoteWorkspaceSessionEntry[];
  /** 提交失败后的字段错误；为空表示尚未提交或已全部修正。 */
  fieldErrors?: RemoteFormFieldError[];
  /** 每次提交校验失败递增，用于把焦点移到第一个出错字段。 */
  validationAttempt?: number;
  connectLabel?: string;
  loading: boolean;
  onBack: () => void;
  onHostChange: (value: string) => void;
  onPortChange: (value: string) => void;
  onUsernameChange: (value: string) => void;
  onSshAuthMethodChange: (value: SSHAuthMethod) => void;
  onAssetInstallModeChange: (value: RemoteAssetInstallMode) => void;
  onPasswordChange: (value: string) => void;
  onPrivateKeyPathChange: (value: string) => void;
  onPrivateKeyPassphraseChange: (value: string) => void;
  onWslDistroChange: (value: string) => void;
  onWslUserChange?: (value: string) => void;
  onDockerContainerChange: (value: string) => void;
  onManualDockerContainerChange: (value: string) => void;
  onServerUrlChange: (value: string) => void;
  onServerNameChange: (value: string) => void;
  onServerTokenChange: (value: string) => void;
  onServerWorkspacePathChange: (value: string) => void;
  onDockerContainersRefresh?: () => void;
  onApplySshConfigAlias: (value: SSHConfigAliasOption) => void;
  onClearSelectedSshConfigAlias: () => void;
  onConnect: () => void;
}) {
  const { intl } = useZCodeIntl();
  const formRef = useRef<HTMLFormElement | null>(null);
  // 设置入口提供类型切换与「从 SSH config 导入」；项目/聊天入口由上一屏选好类型（RDUX-27）。
  const addingDevice = Boolean(availableKinds && onKindChange);
  const [aliasFocusToken, setAliasFocusToken] = useState(0);

  // 校验失败后焦点移到第一个出错字段；DOM 顺序即页面顺序。
  useEffect(() => {
    if (validationAttempt === 0) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [validationAttempt]);

  return (
    <form
      ref={formRef}
      className="flex min-h-0 flex-1 flex-col"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        onConnect();
      }}
    >
      <div
        data-testid="remote-connection-settings-scroll"
        // SSH 配置项增多时，表单内容以前没有自己的滚动边界，会继续绘制到下方按钮区域。
        // 这里把中间内容区限定为可滚动区域，让 footer 始终占据独立空间，不遮挡最后几项配置。
        className="flex-1 min-h-0 space-y-4 overflow-y-auto pr-1"
      >
        {addingDevice && availableKinds && onKindChange ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <RemoteSegmentedControl
              label={intl.formatMessage({ id: "remote.connectionType" })}
              value={kind}
              onChange={onKindChange}
              disabled={loading}
              options={availableKinds.map((connectionKind) => {
                const presentation =
                  connectionKind === "server"
                    ? undefined
                    : REMOTE_KIND_PRESENTATION[connectionKind];
                return {
                  value: connectionKind,
                  label: intl.formatMessage({ id: `remote.kind.${connectionKind}` }),
                  // 类型切换的每一项就是连接类型标签，允许使用类型色（DESIGN.md / RDUX-27）。
                  icon: presentation?.Icon,
                  selectedClassName: presentation?.selectedClassName,
                  testId: `remote-kind-${connectionKind}`,
                };
              })}
            />
            {kind === "ssh" ? (
              <SshConfigAliasPicker
                aliases={sshConfigAliases}
                selectedAlias={selectedSshConfigAlias}
                align="end"
                onApply={(option) => {
                  onApplySshConfigAlias(option);
                  setAliasFocusToken((token) => token + 1);
                }}
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="lg"
                  disabled={loading || sshConfigAliasesLoading || sshConfigAliases.length === 0}
                  data-testid={TID_SSH_CONFIG_IMPORT}
                  className="text-remote-foreground-muted hover:text-foreground"
                >
                  <FileCodeIcon />
                  {intl.formatMessage({
                    id: sshConfigAliasesLoading
                      ? "common.loading"
                      : sshConfigAliases.length === 0
                        ? "ssh.importEmpty"
                        : "ssh.importFromConfig",
                  })}
                  <ChevronDownIcon className="size-3.5" />
                </Button>
              </SshConfigAliasPicker>
            ) : null}
          </div>
        ) : null}
        {addingDevice && kind === "ssh" && sshConfigAliasesError ? (
          <div className="flex items-start gap-2 rounded-lg bg-warning-surface px-3 py-2 text-ui-sm text-warning-surface-foreground">
            <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
            <span>{intl.formatMessage({ id: "ssh.configAliasLoadFailed" })}</span>
          </div>
        ) : null}
        {currentRuntimeOptionsError ? (
          <div className="flex items-start gap-3 rounded-md bg-warning-surface px-3 py-3 text-ui-base text-warning-surface-foreground">
            <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
            <span>{intl.formatMessage({ id: "remote.optionsLoadFailed" })}</span>
          </div>
        ) : null}

        <RemoteConnectionFields
          focusCredentials={focusCredentials}
          autoFocusHost={!focusCredentials}
          focusFirstEmptyToken={aliasFocusToken}
          sshConfigAliasMode="linked"
          fieldErrors={fieldErrors}
          runtimeOptionsError={currentRuntimeOptionsError}
          kind={kind}
          host={host}
          port={port}
          username={username}
          sshAuthMethod={sshAuthMethod}
          assetInstallMode={assetInstallMode}
          password={password}
          privateKeyPath={privateKeyPath}
          privateKeyPassphrase={privateKeyPassphrase}
          wslDistro={wslDistro}
          wslUser={wslUser}
          wslDistros={wslDistros}
          dockerContainer={dockerContainer}
          manualDockerContainer={manualDockerContainer}
          serverUrl={serverUrl}
          serverName={serverName}
          serverToken={serverToken}
          serverWorkspacePath={serverWorkspacePath}
          dockerContainers={dockerContainers}
          dockerAvailable={dockerAvailable}
          sshConfigAliases={sshConfigAliases}
          sshConfigAliasesLoading={sshConfigAliasesLoading}
          sshConfigAliasesError={sshConfigAliasesError}
          selectedSshConfigAlias={selectedSshConfigAlias}
          runtimeOptionsLoading={currentRuntimeOptionsLoading}
          remoteWorkspaceSessions={remoteWorkspaceSessions}
          applySshConfigAlias={onApplySshConfigAlias}
          clearSelectedSshConfigAlias={onClearSelectedSshConfigAlias}
          setHost={onHostChange}
          setPort={onPortChange}
          setUsername={onUsernameChange}
          setSshAuthMethod={onSshAuthMethodChange}
          setAssetInstallMode={onAssetInstallModeChange}
          setPassword={onPasswordChange}
          setPrivateKeyPath={onPrivateKeyPathChange}
          setPrivateKeyPassphrase={onPrivateKeyPassphraseChange}
          setWslDistro={onWslDistroChange}
          setWslUser={onWslUserChange}
          setDockerContainer={onDockerContainerChange}
          setManualDockerContainer={onManualDockerContainerChange}
          setServerUrl={onServerUrlChange}
          setServerName={onServerNameChange}
          setServerToken={onServerTokenChange}
          setServerWorkspacePath={onServerWorkspacePathChange}
          refreshDockerContainers={onDockerContainersRefresh}
        />
      </div>

      {/* 设置入口：取消与主操作右对齐；项目/聊天入口：左返回列表、右连接。只保留一条分隔线（RDUX-27）。 */}
      <div
        className={cn(
          "mt-5 flex items-center gap-2 border-t border-border pt-4",
          addingDevice ? "justify-end" : "justify-between",
        )}
      >
        {addingDevice ? (
          <Button
            type="button"
            variant="ghost"
            className="h-9 px-4"
            onClick={onBack}
            disabled={loading}
          >
            {intl.formatMessage({ id: "common.cancel" })}
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            className="h-9 px-3 text-remote-foreground-muted"
            onClick={onBack}
            disabled={loading}
          >
            <ArrowLeftIcon className="size-4" />
            {intl.formatMessage({ id: "remote.selection.back" })}
          </Button>
        )}
        <Button type="submit" className="h-9 px-4" disabled={loading}>
          {loading ? (
            <>
              <LoaderCircle className="size-4 animate-spin" />
              {intl.formatMessage({ id: "remote.connecting" })}
            </>
          ) : (
            (connectLabel ?? intl.formatMessage({ id: "remote.startConnection" }))
          )}
        </Button>
      </div>
    </form>
  );
}

export function RemoteConnectionDirectoryStep({
  directoryPath,
  onDirectoryPathChange,
  services,
  remoteTarget,
  sourceServerId,
  localWorkspacePath,
  selecting = false,
  onSelect,
  onBack,
  onCancel,
  onChooseLater,
  deviceName,
  profileName,
  deviceVersion,
  onRenameDevice,
  quickOpenPaths = [],
  quickOpenEntries = [],
}: {
  directoryPath?: string;
  onDirectoryPathChange?: (path: string) => void;
  services: IServiceAccessor | null;
  remoteTarget?: RemoteTarget | null;
  /** 刚连接设备的 sourceServerId；识别出设备前不显示「一键同步」。 */
  sourceServerId?: string | null;
  localWorkspacePath?: string;
  selecting?: boolean;
  onSelect: (path: string) => void;
  onBack: () => void;
  onCancel: () => void;
  onChooseLater?: () => void;
  deviceName?: string;
  /** 线路名（原型成功横幅「线路 linux-arm64-dev」段）。 */
  profileName?: string;
  /** 设备版本号，不带 v 前缀（原型成功横幅「v3.8.1」段）。 */
  deviceVersion?: string;
  onRenameDevice?: (name: string) => Promise<void> | void;
  quickOpenPaths?: Array<string | { path: string; label?: string }>;
  quickOpenEntries?: Array<{ path: string; label?: string }>;
}) {
  const { intl } = useZCodeIntl();
  const [navigationRevision, setNavigationRevision] = useState(0);
  const [directoryReady, setDirectoryReady] = useState(false);
  const [localPath, setLocalPath] = useState("");
  const selectedPath = directoryPath ?? localPath;
  const setSelectedPath = onDirectoryPathChange ?? setLocalPath;
  const [renameStatus, setRenameStatus] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [deviceNameDraft, setDeviceNameDraft] = useState(deviceName ?? "");
  useEffect(() => {
    setDeviceNameDraft(deviceName ?? "");
  }, [deviceName]);
  // 「一键同步」打开数据同步弹窗，定位到刚连接的设备；选了目录时 MCP 按该目录做 workspace 映射。
  const dataSync = useDataSyncEntry();
  const dataSyncSourceServerId =
    dataSync.available && sourceServerId && isDataSyncEntryRemoteTarget(remoteTarget)
      ? sourceServerId
      : null;
  const dataSyncDeviceOnline = useDataSyncDeviceOnline(dataSyncSourceServerId);
  const targetWorkspacePath = selectedPath.trim();
  const quickOpenGroups = [
    {
      label: "remote.recentDirectories",
      items: quickOpenPaths.map((item) => (typeof item === "string" ? { path: item } : item)),
    },
    { label: "remote.remoteRecord", items: quickOpenEntries },
  ];
  const saveName = async () => {
    const name = deviceNameDraft.trim();
    if (!name || name === deviceName || !onRenameDevice || renameStatus === "saving") return;
    setRenameStatus("saving");
    try {
      await onRenameDevice(name);
      setRenameStatus("saved");
    } catch {
      setRenameStatus("failed");
    }
  };

  if (!services) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-6 h-full">
        <div className="flex min-h-[22rem] flex-1 items-center justify-center rounded-2xl border border-border bg-card text-ui-base text-remote-foreground-muted">
          <LoaderCircle className="mr-2 size-4 animate-spin" />
          {intl.formatMessage({ id: "common.loading" })}
        </div>
        <div className="flex justify-end gap-3">
          {onChooseLater ? (
            <Button variant="ghost" onClick={onChooseLater}>
              {intl.formatMessage({ id: "remote.chooseLater" })}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="secondary"
            size="lg"
            className="h-10 min-w-0 w-32"
            onClick={onBack}
          >
            {intl.formatMessage({ id: "common.back" })}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" aria-busy={selecting}>
      {deviceName && !onRenameDevice ? (
        <h3 className="text-ui-base font-semibold">{deviceName}</h3>
      ) : null}
      <div className="flex flex-col flex-1 min-h-0 space-y-3 overflow-y-auto">
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-success-surface px-3 py-2 text-ui-sm text-success-surface-foreground">
          <div className="min-w-0">
            <span className="flex items-center gap-2">
              <CheckIcon className="size-4" />
              {intl.formatMessage({ id: "remote.status.connected" })}
              {[
                profileName && profileName !== deviceName
                  ? profileName
                  : remoteTarget
                    ? intl.formatMessage({ id: `remote.kind.${remoteTarget.kind}` })
                    : undefined,
                deviceVersion ? `v${deviceVersion}` : undefined,
              ]
                .filter(Boolean)
                .map((value) => (
                  <span key={value}>· {value}</span>
                ))}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {dataSyncSourceServerId ? (
              <DataSyncEntryDropdownButton
                disabled={!dataSyncDeviceOnline}
                onSelect={(category) =>
                  dataSync.open({
                    sourceServerId: dataSyncSourceServerId,
                    category,
                    ...(targetWorkspacePath && localWorkspacePath
                      ? {
                          workspace: {
                            sourceWorkspacePath: localWorkspacePath,
                            targetWorkspacePath,
                          },
                        }
                      : {}),
                  })
                }
              />
            ) : null}
          </div>
        </div>
        {onRenameDevice ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-ui-sm text-remote-foreground-muted">
              {intl.formatMessage({ id: "remote.renameDevice" })}
            </span>
            <Input
              value={deviceNameDraft}
              aria-label={intl.formatMessage({ id: "remote.renameDevice" })}
              className="h-7 max-w-64 font-mono text-ui-sm"
              onChange={(event) => {
                setDeviceNameDraft(event.currentTarget.value);
                setRenameStatus("idle");
              }}
              disabled={renameStatus === "saving"}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void saveName();
                }
              }}
              onBlur={() => {
                void saveName();
              }}
            />
            <span role="status" className="text-ui-xs text-remote-foreground-muted">
              {intl.formatMessage({
                id:
                  renameStatus === "saved"
                    ? "remote.renameSaved"
                    : renameStatus === "failed"
                      ? "remote.renameFailed"
                      : renameStatus === "saving"
                        ? "common.loading"
                        : "remote.renameDeviceHint",
              })}
            </span>
          </div>
        ) : null}
        {quickOpenGroups.map((group) =>
          group.items.length ? (
            <div key={group.label} className="min-w-0 space-y-1.5">
              <span className="block text-ui-xs text-remote-foreground-muted">
                {intl.formatMessage({ id: group.label })}
              </span>
              <div className="flex min-w-0 flex-wrap gap-2">
                {group.items.map(({ path, label }) => (
                  <Button
                    key={path}
                    type="button"
                    variant={selectedPath === path ? "secondary" : "outline"}
                    size="sm"
                    className="max-w-full h-auto rounded-md font-mono"
                    disabled={selecting}
                    onClick={() => {
                      setNavigationRevision((revision) => revision + 1);
                      setDirectoryReady(false);
                      setSelectedPath(path);
                    }}
                  >
                    <FolderIcon className="size-3.5 shrink-0 text-remote-foreground-muted" />
                    <span className="break-all whitespace-normal text-left">{path}</span>
                    {label ? (
                      <span className="font-sans text-ui-xs text-remote-foreground-muted">
                        {label}
                      </span>
                    ) : null}
                  </Button>
                ))}
              </div>
            </div>
          ) : null,
        )}
        {/* Bugfix: 该容器之前不是 flex，导致子级 DirectoryBrowser 的 flex-1 无法拿到有效高度，
            目录项变多时 overflow-y-auto 不生效，列表不能垂直滚动。 */}
        <div
          className={cn(
            "min-h-48 flex shrink-0 overflow-hidden",
            selecting ? "pointer-events-none opacity-70" : "",
          )}
        >
          <DirectoryBrowser
            initialPath={selectedPath}
            navigationRevision={navigationRevision}
            onNavigationStateChange={setDirectoryReady}
            services={services}
            embedded
            onSelect={onSelect}
            onCancel={onCancel}
            // Bug 原因：把目录行改成“仅选中”后，点击不再执行 readdir，用户失去了进入子目录的入口。
            // 目录行保持逐级导航，父层通过 onPathChange 记录当前路径并在底部按钮统一确认。
            onPathChange={setSelectedPath}
          />
        </div>
      </div>
      <p
        className="break-all font-mono text-ui-sm text-remote-foreground-muted"
        data-testid="remote-directory-selected-path"
      >
        {intl.formatMessage({ id: "remote.directory.willOpen" }, { path: selectedPath })}
      </p>
      <div className="flex items-center justify-end gap-3 border-t border-border pt-3">
        {onChooseLater ? (
          <Button variant="ghost" className="mr-auto" disabled={selecting} onClick={onChooseLater}>
            {intl.formatMessage({ id: "remote.chooseLater" })}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="secondary"
          size="lg"
          className="h-10 min-w-0 px-5"
          onClick={onBack}
          disabled={selecting}
        >
          {intl.formatMessage({ id: "common.back" })}
        </Button>
        <Button
          type="button"
          size="lg"
          className="h-10 min-w-0 px-5"
          onClick={() => selectedPath && directoryReady && !selecting && onSelect(selectedPath)}
          disabled={!selectedPath || selecting || !directoryReady}
        >
          {selecting ? (
            <>
              <LoaderCircle className="size-4 animate-spin" />
              {intl.formatMessage({ id: "common.loading" })}
            </>
          ) : (
            intl.formatMessage({ id: "remote.openWorkspaceHere" })
          )}
        </Button>
      </div>
      {dataSync.dialog}
    </div>
  );
}
