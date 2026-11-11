import { RemotePasswordInput } from "@/remote-connection/RemotePasswordInput.js";
/* eslint-disable max-lines -- 远程连接字段较多，SSH/WSL/Docker 分支暂集中在单文件维护。 */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import type {
  DockerContainerInfo,
  RemoteAssetInstallMode,
  RemoteTarget,
  RemoteWorkspaceSessionEntry,
  SSHConfigAliasOption,
  WSLDistro,
} from "@zcode/shared";
import type { LucideIcon } from "lucide-react";
import {
  AlertCircleIcon,
  AlertTriangleIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  LinkIcon,
  LoaderCircle,
  FileKey,
  XIcon,
} from "lucide-react";
import { isValidWslUser } from "@zcode/shared";
import {
  TID_DOCKER_CONTAINER_INPUT,
  TID_DOCKER_CONTAINER_SELECT,
  TID_SSH_CONFIG_ALIAS_CHIP,
  TID_SSH_CONFIG_ALIAS_SELECT,
  TID_SSH_AUTH_PASSWORD,
  TID_SSH_AUTH_PRIVATE_KEY,
  TID_SSH_HOST_INPUT,
  TID_SSH_PASSWORD_INPUT,
  TID_SSH_PORT_INPUT,
  TID_SSH_PRIVATE_KEY_INPUT,
  TID_SSH_USERNAME_INPUT,
  TID_SERVER_NAME_INPUT,
  TID_SERVER_TOKEN_INPUT,
  TID_SERVER_URL_INPUT,
  TID_SERVER_WORKSPACE_PATH_INPUT,
  TID_WSL_DISTRO_SELECT,
  TID_WSL_USER_INPUT,
} from "@zcode/shared/test-ids";
import type { SSHAuthMethod } from "@/hooks/useRemoteConnectionForm.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { RemoteConnectionHistoryInput } from "@/remote-connection/RemoteConnectionHistoryInput.js";
import {
  REMOTE_KIND_PRESENTATION,
  RemoteConnectionKindTile,
} from "@/remote-connection/RemoteConnectionTags.js";
import { buildSshConnectionHistorySuggestions } from "@/remote-connection/sshHistorySuggestions.js";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  parseSshPasteTarget,
  type RemoteFormField,
  type RemoteFormFieldError,
} from "@/lib/remoteConnectionWizard.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";

export interface RemoteSegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: LucideIcon;
  /** 只有连接类型切换传入类型色；其余分段保持中性选中态（DESIGN.md Tabs）。 */
  selectedClassName?: string;
  testId?: string;
}

/** 远程连接表单统一的分段控件：外框方框、竖线分隔、选中项 aria-pressed。 */
export function RemoteSegmentedControl<T extends string>({
  label,
  labelledBy,
  value,
  options,
  onChange,
  disabled,
  wrap = false,
}: {
  label?: string;
  labelledBy?: string;
  value: T;
  options: RemoteSegmentedOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  /** 长文案（如下载方式）允许换行；短标签保持单行。 */
  wrap?: boolean;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      aria-labelledby={labelledBy}
      className="flex w-fit max-w-full overflow-hidden rounded-lg border border-input-border"
    >
      {options.map((option, index) => {
        const selected = option.value === value;
        const Icon = option.icon;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            disabled={disabled}
            data-testid={option.testId}
            onClick={() => onChange(option.value)}
            className={cn(
              "inline-flex min-h-8 min-w-0 items-center justify-center gap-1.5 px-3 text-ui-base transition-colors disabled:opacity-50",
              wrap ? "py-1 text-center" : "whitespace-nowrap",
              index > 0 && "border-l border-input-border",
              selected
                ? cn("font-medium", option.selectedClassName ?? "bg-selected text-foreground")
                : // 全局样式禁用了 focus outline / box-shadow，键盘焦点改用背景提示。
                  "text-remote-foreground-muted hover:text-foreground focus-visible:bg-hover focus-visible:text-foreground",
            )}
          >
            {Icon ? <Icon className="size-3.5 shrink-0" /> : null}
            <span className={cn("min-w-0", wrap && "break-words")}>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

const NO_SSH_CONFIG_ALIAS_VALUE = "__ssh_config_alias_none__";

export function formatSshConfigAliasSummary(aliasOption: SSHConfigAliasOption): string {
  const host = aliasOption.host?.trim() || aliasOption.alias;
  const username = aliasOption.username?.trim();
  const withUser = username ? `${username}@${host}` : host;
  return aliasOption.port != null ? `${withUser}:${aliasOption.port}` : withUser;
}

/**
 * SSH config Host 的可搜索弹层。新建连接的「从 SSH config 导入」与编辑连接高级选项里的
 * 别名下拉共用同一列表，触发按钮由调用方提供。
 */
export function SshConfigAliasPicker({
  aliases,
  selectedAlias,
  includeNoneOption = false,
  align = "start",
  onApply,
  onClear,
  children,
}: {
  aliases: SSHConfigAliasOption[];
  selectedAlias: string | null;
  /** 编辑连接的下拉保留「不使用别名」；新建表单用关联标签的 × 解除。 */
  includeNoneOption?: boolean;
  align?: "start" | "end";
  onApply: (option: SSHConfigAliasOption) => void;
  onClear?: () => void;
  children: ReactNode;
}) {
  const { intl } = useZCodeIntl();
  const [open, setOpen] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const handleListWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    const listElement = event.currentTarget;
    if (listElement.scrollHeight <= listElement.clientHeight) {
      return;
    }

    // Popover 嵌在 Dialog 中时，外层滚动锁会吞掉默认滚轮行为，
    // 导致 alias CommandList 只能拖滚动条、不能直接滚轮滚动。
    // 这里显式驱动列表自身 scrollTop，确保鼠标滚轮和触控板都能滚动候选项。
    listElement.scrollTop += event.deltaY;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      listRef.current
        ?.querySelector<HTMLElement>('[data-ssh-config-alias-selected="true"]')
        ?.scrollIntoView({ block: "nearest" });
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [open, selectedAlias, aliases.length]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align={align} sideOffset={6} className="w-80 gap-0 bg-menu p-0">
        <Command className="bg-transparent p-0 text-foreground">
          <CommandInput
            placeholder={intl.formatMessage({
              id: "ssh.configAliasSearchPlaceholder",
            })}
            className="h-8"
          />
          <CommandList
            ref={listRef}
            className="max-h-60 overscroll-contain"
            onWheel={handleListWheel}
          >
            <CommandEmpty className="px-4 py-5 text-remote-foreground-muted">
              {intl.formatMessage({ id: "ssh.configAliasEmpty" })}
            </CommandEmpty>
            <CommandGroup className="p-1">
              {includeNoneOption ? (
                <CommandItem
                  value={NO_SSH_CONFIG_ALIAS_VALUE}
                  data-checked={selectedAlias == null ? "true" : undefined}
                  data-ssh-config-alias-selected={selectedAlias == null ? "true" : undefined}
                  className="min-h-8 cursor-pointer px-2 text-ui-base"
                  onSelect={() => {
                    onClear?.();
                    setOpen(false);
                  }}
                >
                  <span className="truncate">
                    {intl.formatMessage({
                      id: "ssh.configAliasPlaceholder",
                    })}
                  </span>
                </CommandItem>
              ) : null}
              {aliases.map((aliasOption) => {
                const selected = selectedAlias === aliasOption.alias;
                return (
                  <CommandItem
                    key={aliasOption.alias}
                    value={`${aliasOption.alias} ${formatSshConfigAliasSummary(aliasOption)}`}
                    data-checked={selected ? "true" : undefined}
                    data-ssh-config-alias-selected={selected ? "true" : undefined}
                    className="min-h-8 cursor-pointer gap-2 px-2 text-ui-base"
                    onSelect={() => {
                      onApply(aliasOption);
                      setOpen(false);
                    }}
                  >
                    <RemoteConnectionKindTile kind="ssh" />
                    <span className="flex min-w-0 flex-1 flex-col text-left">
                      <span className="truncate">{aliasOption.alias}</span>
                      <span className="truncate font-mono text-ui-sm text-remote-foreground-muted">
                        {formatSshConfigAliasSummary(aliasOption)}
                      </span>
                    </span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function FieldLabel({
  htmlFor,
  id,
  children,
}: {
  htmlFor?: string;
  id?: string;
  children: ReactNode;
}) {
  return (
    <label
      htmlFor={htmlFor}
      id={id}
      className="mb-1.5 block text-ui-sm text-remote-foreground-muted"
    >
      {children}
    </label>
  );
}

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="mt-1.5 flex items-start gap-1 text-ui-sm text-destructive">
      <AlertCircleIcon className="mt-0.5 size-3.5 shrink-0" />
      <span>{message}</span>
    </p>
  );
}

/** 字段下方提示：限制信息用 warning 卡片，粘贴识别用 success，其余中性。 */
function FieldHint({
  tone = "muted",
  children,
}: {
  tone?: "muted" | "warning" | "success";
  children: ReactNode;
}) {
  return (
    <p
      data-remote-field-hint={tone}
      className={cn(
        "mt-1.5 flex items-start gap-1.5 text-pretty text-ui-sm",
        tone === "muted" && "text-remote-foreground-muted",
        tone === "success" && "text-success",
        tone === "warning" &&
          "rounded-lg bg-warning-surface px-3 py-2 text-warning-surface-foreground",
      )}
    >
      {tone === "warning" ? <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" /> : null}
      {tone === "success" ? <CheckIcon className="mt-0.5 size-3.5 shrink-0" /> : null}
      <span>{children}</span>
    </p>
  );
}

export function RemoteConnectionFields({
  focusCredentials,
  autoFocusHost = false,
  focusFirstEmptyToken = 0,
  sshConfigAliasMode = "advanced",
  fieldErrors = [],
  runtimeOptionsError = "",
  focusField,
  passwordPlaceholder,
  privateKeyPassphrasePlaceholder,
  kind,
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
  runtimeOptionsLoading,
  remoteWorkspaceSessions = [],
  refreshDockerContainers,
  applySshConfigAlias,
  clearSelectedSshConfigAlias,
  setHost,
  setPort,
  setUsername,
  setSshAuthMethod,
  setAssetInstallMode,
  setPassword,
  setPrivateKeyPath,
  setPrivateKeyPassphrase,
  setWslDistro,
  setWslUser,
  setDockerContainer,
  setManualDockerContainer,
  setServerUrl,
  setServerName,
  setServerToken,
  setServerWorkspacePath,
}: {
  focusCredentials?: boolean;
  /** 新建连接表单打开时把焦点放在主机（RDUX-27）。 */
  autoFocusHost?: boolean;
  /** 每次递增时把焦点移到第一个为空的必填 SSH 字段；全部已填时移到表单主操作。 */
  focusFirstEmptyToken?: number;
  /**
   * linked：新建连接表单，别名由外部「从 SSH config 导入」选择，这里只显示关联标签；
   * advanced：编辑连接弹窗，别名下拉保留在高级选项内。
   */
  sshConfigAliasMode?: "advanced" | "linked";
  /** 提交后显示的内联错误，来自 collectRemoteFormFieldErrors。 */
  fieldErrors?: RemoteFormFieldError[];
  runtimeOptionsError?: string;
  focusField?: "host" | "auth";
  passwordPlaceholder?: string;
  privateKeyPassphrasePlaceholder?: string;
  kind: RemoteTarget["kind"];
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
  runtimeOptionsLoading: boolean;
  remoteWorkspaceSessions?: RemoteWorkspaceSessionEntry[];
  refreshDockerContainers?: () => void;
  applySshConfigAlias: (value: SSHConfigAliasOption) => void;
  clearSelectedSshConfigAlias: () => void;
  setHost: (value: string) => void;
  setPort: (value: string) => void;
  setUsername: (value: string) => void;
  setSshAuthMethod: (value: SSHAuthMethod) => void;
  setAssetInstallMode: (value: RemoteAssetInstallMode) => void;
  setPassword: (value: string) => void;
  setPrivateKeyPath: (value: string) => void;
  setPrivateKeyPassphrase: (value: string) => void;
  setWslDistro: (value: string) => void;
  setWslUser?: (value: string) => void;
  setDockerContainer: (value: string) => void;
  setManualDockerContainer: (value: string) => void;
  setServerUrl: (value: string) => void;
  setServerName: (value: string) => void;
  setServerToken: (value: string) => void;
  setServerWorkspacePath: (value: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const fieldId = useId();
  const [dockerInputMode, setDockerInputMode] = useState<"select" | "manual">(
    manualDockerContainer || !dockerContainer ? "manual" : "select",
  );
  const platform = usePlatform();
  const [dockerContainerPopoverOpen, setDockerContainerPopoverOpen] = useState(false);
  const [advancedOptionsOpen, setAdvancedOptionsOpen] = useState(false);
  // 粘贴识别结果只属于本次粘贴；主机再被手动修改时清除。
  const [pasteRecognized, setPasteRecognized] = useState<string | null>(null);
  const [pasteFocusRequest, setPasteFocusRequest] = useState(0);
  const sshRootRef = useRef<HTMLDivElement | null>(null);
  const sshHistorySuggestions = buildSshConnectionHistorySuggestions(remoteWorkspaceSessions);
  const errorOf = (field: RemoteFormField) =>
    fieldErrors.find((error) => error.field === field)?.message;
  const errorId = (field: RemoteFormField) => `${fieldId}-${field}-error`;
  const invalidProps = (field: RemoteFormField, flagged = false) => ({
    "aria-invalid": errorOf(field) || flagged ? true : undefined,
    "aria-describedby": errorOf(field) ? errorId(field) : undefined,
  });
  const selectedSshAliasOption =
    selectedSshConfigAlias == null
      ? null
      : (sshConfigAliases.find((option) => option.alias === selectedSshConfigAlias) ?? null);
  const sshAliasTriggerLabel = sshConfigAliasesLoading
    ? intl.formatMessage({ id: "common.loading" })
    : (selectedSshAliasOption?.alias ??
      selectedSshConfigAlias ??
      (sshConfigAliases.length === 0
        ? intl.formatMessage({ id: "ssh.configAliasEmpty" })
        : intl.formatMessage({ id: "ssh.configAliasPlaceholder" })));
  // Bugfix: 空下拉列表曾固定显示「选择正在运行的容器」，下拉又盖住选择器下方的原因提示，
  // 用户看不到为什么没有候选。空列表与下方提示共用同一条原因文案。
  const dockerContainerEmptyText = runtimeOptionsError
    ? intl.formatMessage({ id: "remote.optionsLoadFailed" })
    : dockerAvailable === false
      ? intl.formatMessage({ id: "docker.unavailable" })
      : intl.formatMessage({ id: "docker.noContainers" });
  const dockerContainerTriggerLabel =
    dockerContainer.trim() ||
    (runtimeOptionsLoading
      ? intl.formatMessage({ id: "docker.loading" })
      : intl.formatMessage({ id: "docker.selectContainer" }));
  const dockerContainerTriggerIsPlaceholder = !dockerContainer.trim();
  const manualDockerContainerIsEmpty = manualDockerContainer.trim().length === 0;
  const wslUserIsRoot = wslUser.trim().toLowerCase() === "root";
  const wslUserIsInvalid = wslUser.trim().length > 0 && !isValidWslUser(wslUser);
  const handleDockerContainerPopoverOpenChange = (nextOpen: boolean) => {
    setDockerContainerPopoverOpen(nextOpen);
    if (nextOpen) {
      refreshDockerContainers?.();
    }
  };

  useEffect(() => {
    if (kind !== "docker" && dockerContainerPopoverOpen) {
      setDockerContainerPopoverOpen(false);
    }
  }, [dockerContainerPopoverOpen, kind]);

  // 导入 Host 或粘贴拆分后，按提交后的最新字段值把焦点移到第一个空必填项（RDUX-27）。
  // 放在 effect 里而不是事件回调里，保证读取到已经提交到 DOM 的值。
  const focusRequestKey = `${focusFirstEmptyToken}:${pasteFocusRequest}`;
  const lastFocusRequestKeyRef = useRef(focusRequestKey);
  useEffect(() => {
    if (lastFocusRequestKeyRef.current === focusRequestKey) return;
    lastFocusRequestKeyRef.current = focusRequestKey;
    const root = sshRootRef.current;
    if (!root) return;
    const firstEmptyTestId = !host.trim()
      ? TID_SSH_HOST_INPUT
      : !username.trim()
        ? TID_SSH_USERNAME_INPUT
        : sshAuthMethod === "password"
          ? TID_SSH_PASSWORD_INPUT
          : !privateKeyPath.trim()
            ? TID_SSH_PRIVATE_KEY_INPUT
            : null;
    const target = firstEmptyTestId
      ? root.querySelector<HTMLElement>(`[data-testid="${firstEmptyTestId}"]`)
      : root.closest("form")?.querySelector<HTMLElement>('button[type="submit"]');
    target?.focus();
  }, [focusRequestKey]);

  const sshAliasField = (
    <div className="space-y-1">
      <FieldLabel htmlFor={`${fieldId}-ssh-alias`}>
        {intl.formatMessage({ id: "ssh.configAlias" })}
      </FieldLabel>
      <SshConfigAliasPicker
        aliases={sshConfigAliases}
        selectedAlias={selectedSshConfigAlias}
        includeNoneOption
        onApply={applySshConfigAlias}
        onClear={clearSelectedSshConfigAlias}
      >
        <Button
          type="button"
          variant="outline"
          size="lg"
          disabled={
            sshConfigAliasesLoading || (sshConfigAliases.length === 0 && !selectedSshConfigAlias)
          }
          id={`${fieldId}-ssh-alias`}
          data-testid={TID_SSH_CONFIG_ALIAS_SELECT}
          className="h-9 w-full max-w-80 justify-between rounded-lg border-input-border bg-input px-3 text-ui-base font-normal hover:border-input-border-hover hover:bg-input aria-expanded:border-input-border-focused aria-expanded:bg-input-focused"
        >
          <span className="min-w-0 truncate text-left">{sshAliasTriggerLabel}</span>
          <ChevronDownIcon className="size-3.5 text-remote-foreground-muted" />
        </Button>
      </SshConfigAliasPicker>
      {sshConfigAliasesError ? (
        <p className="text-pretty text-ui-sm text-remote-foreground-muted">
          {intl.formatMessage({
            id: "ssh.configAliasLoadFailed",
          })}
        </p>
      ) : null}
    </div>
  );

  switch (kind) {
    case "ssh":
      return (
        <div ref={sshRootRef} className="space-y-4">
          {selectedSshConfigAlias && sshConfigAliasMode === "linked" ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span
                data-testid={TID_SSH_CONFIG_ALIAS_CHIP}
                className={cn(
                  "inline-flex h-7 items-center gap-1.5 rounded-md border pr-0.5 pl-2 text-ui-sm",
                  REMOTE_KIND_PRESENTATION.ssh.className,
                )}
              >
                <LinkIcon className="size-3.5 shrink-0" />
                <span className="truncate">
                  {intl.formatMessage(
                    { id: "ssh.configAliasLinked" },
                    { alias: selectedSshConfigAlias },
                  )}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={intl.formatMessage({ id: "ssh.configAliasUnlink" })}
                  title={intl.formatMessage({ id: "ssh.configAliasUnlink" })}
                  onClick={clearSelectedSshConfigAlias}
                >
                  <XIcon />
                </Button>
              </span>
              <span className="text-ui-sm text-remote-foreground-muted">
                {intl.formatMessage({ id: "ssh.configAliasLinkedHint" })}
              </span>
            </div>
          ) : null}
          {selectedSshConfigAlias && sshConfigAliasMode === "advanced" ? (
            <p className="text-pretty text-ui-sm text-remote-foreground-muted">
              {selectedSshConfigAlias} · {intl.formatMessage({ id: "ssh.configAliasDescription" })}
            </p>
          ) : null}
          {/* Bugfix: Electron / Chromium 的原生 autocomplete 在 SSH 向导里不稳定，
              而且默认值（如 localhost / 22）会把历史候选提前过滤掉。
              这里改成用应用自身持久化的远程连接历史做显式候选，focus 时先展示完整历史；密码仍然不参与历史回填。 */}
          {/* Bugfix: 建议列表之前直接跟着全宽输入框展开，在大对话框里会变成长条。
              这里把宽度限制在字段语义范围内，只收窄建议列表，不改变原输入框布局。 */}
          {/* Bugfix: 示例值直接作为 placeholder 会被误认为已有默认值。
              这里改成“输入提示 + 示例”，让用户知道仍需手动填写必填字段。 */}
          {/* 主机与端口同属连接目标，放在同一行；端口固定 6rem，窄屏同样并排（RDUX-27）。 */}
          <div>
            <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-3">
              <div className="min-w-0">
                <RemoteConnectionHistoryInput
                  className="h-9 font-mono placeholder:font-sans text-ui-base"
                  label={intl.formatMessage({ id: "ssh.host" })}
                  autoFocus={autoFocusHost || focusField === "host"}
                  {...invalidProps("host", focusField === "host")}
                  value={host}
                  onChange={(value) => {
                    setPasteRecognized(null);
                    setHost(value);
                  }}
                  onBlur={() => setHost(host.trim())}
                  onPaste={(event) => {
                    const parsed = parseSshPasteTarget(event.clipboardData.getData("text"));
                    if (!parsed) return;
                    // 粘贴 user@host:port 或 ssh 命令时一次填好三个字段；setter 走表单原有语义，
                    // 视为手动修改并解除别名关联（RDUX-27）。
                    event.preventDefault();
                    setHost(parsed.host);
                    if (parsed.username) setUsername(parsed.username);
                    if (parsed.port) setPort(parsed.port);
                    setPasteRecognized(
                      `${parsed.username ? `${parsed.username}@` : ""}${parsed.host}${
                        parsed.port ? `:${parsed.port}` : ""
                      }`,
                    );
                    setPasteFocusRequest((request) => request + 1);
                  }}
                  placeholder={intl.formatMessage({ id: "ssh.hostPlaceholder" })}
                  suggestions={sshHistorySuggestions.hosts}
                  emptyText={intl.formatMessage({ id: "remote.history.empty" })}
                  suggestionWidth="min(30ch, calc(100vw - 2rem))"
                  autoCapitalize="none"
                  spellCheck={false}
                  data-testid={TID_SSH_HOST_INPUT}
                />
              </div>
              <RemoteConnectionHistoryInput
                className="h-9 font-mono placeholder:font-sans text-ui-base"
                label={intl.formatMessage({ id: "ssh.port" })}
                value={port}
                onChange={setPort}
                placeholder="22"
                suggestions={sshHistorySuggestions.ports}
                emptyText={intl.formatMessage({ id: "remote.history.empty" })}
                suggestionWidth="min(8ch, calc(100vw - 2rem))"
                inputMode="numeric"
                {...invalidProps("port")}
                data-testid={TID_SSH_PORT_INPUT}
              />
            </div>
            <FieldError id={errorId("host")} message={errorOf("host")} />
            {/* 端口错误文案较长，放在整行下方，避免挤进 6rem 列。 */}
            <FieldError id={errorId("port")} message={errorOf("port")} />
            {pasteRecognized && !errorOf("host") ? (
              <FieldHint tone="success">
                {intl.formatMessage({ id: "ssh.pasteRecognized" }, { target: pasteRecognized })}
              </FieldHint>
            ) : null}
          </div>

          <div>
            <RemoteConnectionHistoryInput
              className="h-9 font-mono placeholder:font-sans text-ui-base"
              label={intl.formatMessage({ id: "ssh.username" })}
              value={username}
              onChange={setUsername}
              onBlur={() => setUsername(username.trim())}
              placeholder={intl.formatMessage({
                id: "ssh.usernamePlaceholder",
              })}
              suggestions={sshHistorySuggestions.usernames}
              emptyText={intl.formatMessage({ id: "remote.history.empty" })}
              suggestionWidth="min(30ch, calc(100vw - 2rem))"
              autoCapitalize="none"
              spellCheck={false}
              {...invalidProps("username")}
              data-testid={TID_SSH_USERNAME_INPUT}
            />
            <FieldError id={errorId("username")} message={errorOf("username")} />
          </div>

          <div className="space-y-2">
            {/* 认证方式标签与分段同行，分段已说明凭据类型，凭据输入不再重复可见标签。 */}
            <div className="flex flex-wrap items-center gap-3">
              <span
                id={`${fieldId}-ssh.authMethod`}
                className="text-ui-sm text-remote-foreground-muted"
              >
                {intl.formatMessage({ id: "ssh.authMethod" })}
              </span>
              <RemoteSegmentedControl
                labelledBy={`${fieldId}-ssh.authMethod`}
                value={sshAuthMethod}
                onChange={setSshAuthMethod}
                options={[
                  {
                    value: "password",
                    label: intl.formatMessage({ id: "ssh.auth.password" }),
                    testId: TID_SSH_AUTH_PASSWORD,
                  },
                  {
                    value: "privateKey",
                    label: intl.formatMessage({ id: "ssh.auth.privateKey" }),
                    testId: TID_SSH_AUTH_PRIVATE_KEY,
                  },
                ]}
              />
            </div>
            {sshAuthMethod === "password" ? (
              <div>
                <RemotePasswordInput
                  size="lg"
                  className="h-9 pr-10 text-ui-base"
                  autoFocus={focusCredentials || focusField === "auth"}
                  {...invalidProps("password", focusField === "auth")}
                  aria-label={intl.formatMessage({ id: "ssh.password" })}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={
                    passwordPlaceholder ?? intl.formatMessage({ id: "ssh.passwordPlaceholder" })
                  }
                  id={`${fieldId}-ssh.password`}
                  name="remote-ssh-password"
                  autoComplete="off"
                  data-testid={TID_SSH_PASSWORD_INPUT}
                />
                <FieldError id={errorId("password")} message={errorOf("password")} />
              </div>
            ) : (
              <div className="space-y-3">
                <div>
                  <div className="relative">
                    <RemoteConnectionHistoryInput
                      className="h-9 pr-10 font-mono placeholder:font-sans text-ui-base"
                      value={privateKeyPath}
                      onChange={setPrivateKeyPath}
                      placeholder={intl.formatMessage({
                        id: "ssh.privateKeyPlaceholder",
                      })}
                      suggestions={sshHistorySuggestions.privateKeyPaths}
                      emptyText={intl.formatMessage({
                        id: "remote.history.empty",
                      })}
                      autoCapitalize="none"
                      spellCheck={false}
                      id={`${fieldId}-ssh.privateKey`}
                      aria-label={intl.formatMessage({ id: "ssh.privateKey" })}
                      autoFocus={focusField === "auth"}
                      {...invalidProps("privateKey", focusField === "auth")}
                      data-testid={TID_SSH_PRIVATE_KEY_INPUT}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-lg"
                      className="absolute top-1/2 right-0.5 -translate-y-1/2"
                      aria-label={intl.formatMessage({
                        id: "ssh.privateKeySelect",
                      })}
                      title={intl.formatMessage({ id: "ssh.privateKeySelect" })}
                      onClick={() => {
                        void (async () => {
                          const selectedPath = await platform.selectFile();
                          if (selectedPath) {
                            setPrivateKeyPath(selectedPath);
                          }
                        })();
                      }}
                    >
                      <FileKey className="size-4" />
                    </Button>
                  </div>
                  <FieldError id={errorId("privateKey")} message={errorOf("privateKey")} />
                </div>
                <div>
                  <FieldLabel htmlFor={`${fieldId}-ssh.privateKeyPassphrase`}>
                    {intl.formatMessage({ id: "ssh.privateKeyPassphrase" })}
                  </FieldLabel>
                  <RemotePasswordInput
                    size="lg"
                    className="h-9 text-ui-base"
                    autoFocus={focusCredentials}
                    value={privateKeyPassphrase}
                    onChange={(e) => setPrivateKeyPassphrase(e.target.value)}
                    placeholder={
                      privateKeyPassphrasePlaceholder ??
                      intl.formatMessage({ id: "ssh.privateKeyPassphrasePlaceholder" })
                    }
                    id={`${fieldId}-ssh.privateKeyPassphrase`}
                    name="remote-ssh-private-key-passphrase"
                    autoComplete="off"
                  />
                </div>
              </div>
            )}
          </div>

          {/* 高级选项默认收起，紧凑文字触发，不再加虚线分隔（RDUX-27）。 */}
          <Collapsible open={advancedOptionsOpen} onOpenChange={setAdvancedOptionsOpen}>
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="-ml-1 px-1 text-remote-foreground-muted hover:text-foreground"
              >
                <ChevronRightIcon
                  className={cn(
                    "size-3.5 transition-transform",
                    advancedOptionsOpen && "rotate-90",
                  )}
                />
                {intl.formatMessage({ id: "ssh.advancedOptions" })}
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-3 pt-2">
              {sshConfigAliasMode === "advanced" ? sshAliasField : null}

              <div>
                <FieldLabel id={`${fieldId}-ssh.assetInstallMode`}>
                  {intl.formatMessage({ id: "ssh.assetInstallMode" })}
                </FieldLabel>
                <RemoteSegmentedControl
                  labelledBy={`${fieldId}-ssh.assetInstallMode`}
                  value={assetInstallMode}
                  onChange={setAssetInstallMode}
                  wrap
                  options={(["local-download-upload", "remote-download"] as const).map((value) => ({
                    value,
                    label: intl.formatMessage({ id: `ssh.assetInstallMode.${value}` }),
                  }))}
                />
                <FieldHint>
                  {intl.formatMessage({ id: "ssh.assetInstallModeDescription" })}
                </FieldHint>
              </div>
            </CollapsibleContent>
          </Collapsible>
        </div>
      );
    case "server":
      return (
        <div className="space-y-3">
          <p className="text-pretty text-ui-base text-remote-foreground-muted">
            {intl.formatMessage({ id: "server.description" })}
          </p>
          <div>
            <label
              htmlFor={`${fieldId}-server.url`}
              className="mb-1.5 block text-ui-sm text-remote-foreground-muted"
            >
              {intl.formatMessage({ id: "server.url" })}
            </label>
            <Input
              size="lg"
              className="h-9 text-ui-base"
              value={serverUrl}
              onChange={(event) => setServerUrl(event.target.value)}
              placeholder={intl.formatMessage({ id: "server.urlPlaceholder" })}
              autoCapitalize="none"
              spellCheck={false}
              id={`${fieldId}-server.url`}
              {...invalidProps("serverUrl")}
              data-testid={TID_SERVER_URL_INPUT}
            />
            <FieldError id={errorId("serverUrl")} message={errorOf("serverUrl")} />
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <label
                htmlFor={`${fieldId}-server.name`}
                className="mb-1.5 block text-ui-sm text-remote-foreground-muted"
              >
                {intl.formatMessage({ id: "server.name" })}
              </label>
              <Input
                size="lg"
                className="h-9 text-ui-base"
                value={serverName}
                onChange={(event) => setServerName(event.target.value)}
                placeholder={intl.formatMessage({
                  id: "server.namePlaceholder",
                })}
                id={`${fieldId}-server.name`}
                data-testid={TID_SERVER_NAME_INPUT}
              />
            </div>
            <div>
              <label
                htmlFor={`${fieldId}-server.token`}
                className="mb-1.5 block text-ui-sm text-remote-foreground-muted"
              >
                {intl.formatMessage({ id: "server.token" })}
              </label>
              <RemotePasswordInput
                size="lg"
                className="h-9 text-ui-base"
                autoFocus={focusCredentials}
                value={serverToken}
                onChange={(event) => setServerToken(event.target.value)}
                placeholder={intl.formatMessage({
                  id: "server.tokenPlaceholder",
                })}
                autoComplete="off"
                id={`${fieldId}-server.token`}
                data-testid={TID_SERVER_TOKEN_INPUT}
              />
            </div>
          </div>
          <div>
            <label
              htmlFor={`${fieldId}-server.workspacePath`}
              className="mb-1.5 block text-ui-sm text-remote-foreground-muted"
            >
              {intl.formatMessage({ id: "server.workspacePath" })}
            </label>
            <Input
              size="lg"
              className="h-9 text-ui-base"
              value={serverWorkspacePath}
              onChange={(event) => setServerWorkspacePath(event.target.value)}
              placeholder={intl.formatMessage({
                id: "server.workspacePathPlaceholder",
              })}
              autoCapitalize="none"
              spellCheck={false}
              id={`${fieldId}-server.workspacePath`}
              data-testid={TID_SERVER_WORKSPACE_PATH_INPUT}
            />
            <p className="mt-1 text-pretty text-ui-base text-remote-foreground-muted">
              {intl.formatMessage({ id: "server.workspacePathDescription" })}
            </p>
          </div>
        </div>
      );
    case "wsl":
      return (
        <div className="space-y-4">
          <div>
            <FieldLabel htmlFor={`${fieldId}-wsl-distro`}>
              {intl.formatMessage({ id: "wsl.distro" })}
            </FieldLabel>
            <Input
              id={`${fieldId}-wsl-distro`}
              size="lg"
              className="h-9 text-ui-base"
              value={wslDistro}
              onChange={(event) => setWslDistro(event.target.value)}
              placeholder={intl.formatMessage({ id: "wsl.defaultDistro" })}
              data-testid={TID_WSL_DISTRO_SELECT}
              list={`${fieldId}-wsl-options`}
            />
            <datalist id={`${fieldId}-wsl-options`}>
              {wslDistros.map((distro) => (
                <option key={distro.name} value={distro.name} />
              ))}
            </datalist>
            <FieldHint>
              {runtimeOptionsLoading
                ? intl.formatMessage({ id: "wsl.loading" })
                : runtimeOptionsError
                  ? intl.formatMessage({ id: "remote.optionsLoadFailed" })
                  : wslDistros.length > 0
                    ? intl.formatMessage(
                        { id: "wsl.detectedCount" },
                        {
                          count: String(wslDistros.length),
                        },
                      )
                    : intl.formatMessage({ id: "wsl.noDistros" })}
            </FieldHint>
          </div>
          <div>
            <FieldLabel htmlFor={`${fieldId}-wsl.user`}>
              {intl.formatMessage({ id: "wsl.user" })}
            </FieldLabel>
            <Input
              size="lg"
              className="h-9 text-ui-base"
              value={wslUser}
              onChange={(event) => setWslUser?.(event.target.value)}
              placeholder={intl.formatMessage({ id: "wsl.defaultUser" })}
              autoCapitalize="none"
              spellCheck={false}
              {...invalidProps("wslUser", wslUserIsInvalid)}
              id={`${fieldId}-wsl.user`}
              data-testid={TID_WSL_USER_INPUT}
            />
            {wslUserIsInvalid ? (
              <FieldError
                id={errorId("wslUser")}
                message={intl.formatMessage({ id: "wsl.validation.invalidUser" })}
              />
            ) : (
              <FieldHint>{intl.formatMessage({ id: "wsl.userDescription" })}</FieldHint>
            )}
            {wslUserIsRoot ? (
              <FieldHint tone="warning">{intl.formatMessage({ id: "wsl.rootWarning" })}</FieldHint>
            ) : null}
          </div>
        </div>
      );
    case "docker":
      return (
        <div className="space-y-4">
          <RemoteSegmentedControl
            label="Docker"
            value={dockerInputMode}
            onChange={(mode) => {
              setDockerInputMode(mode);
              setDockerContainer("");
              setManualDockerContainer("");
            }}
            options={(["select", "manual"] as const).map((mode) => ({
              value: mode,
              label: intl.formatMessage({ id: `docker.inputMode.${mode}` }),
            }))}
          />
          {dockerInputMode === "select" ? (
            <div>
              <FieldLabel htmlFor={`${fieldId}-docker-select`}>
                {intl.formatMessage({ id: "docker.container" })}
              </FieldLabel>
              <Popover
                open={dockerContainerPopoverOpen}
                onOpenChange={handleDockerContainerPopoverOpenChange}
              >
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="lg"
                    id={`${fieldId}-docker-select`}
                    data-testid={TID_DOCKER_CONTAINER_SELECT}
                    {...invalidProps("docker")}
                    className="h-9 w-full justify-between rounded-lg border-input-border bg-input px-3 text-ui-base font-normal hover:border-input-border-hover hover:bg-input aria-expanded:border-input-border-focused aria-expanded:bg-input-focused aria-invalid:border-destructive"
                  >
                    <span
                      className={cn(
                        "min-w-0 truncate text-left",
                        dockerContainerTriggerIsPlaceholder
                          ? "text-remote-foreground-muted"
                          : "text-foreground",
                      )}
                    >
                      {dockerContainerTriggerLabel}
                    </span>
                    {runtimeOptionsLoading ? (
                      <LoaderCircle className="size-3.5 shrink-0 animate-spin text-remote-foreground-muted" />
                    ) : (
                      <ChevronDownIcon className="size-3.5 shrink-0 text-remote-foreground-muted" />
                    )}
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  sideOffset={6}
                  className="max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-menu p-1 shadow-lg"
                  style={{ width: "var(--radix-popover-trigger-width)" }}
                >
                  <Command className="rounded-lg bg-transparent p-0 text-foreground">
                    <CommandInput
                      aria-label={intl.formatMessage({ id: "docker.selectContainer" })}
                      placeholder={intl.formatMessage({ id: "docker.selectContainer" })}
                    />
                    <CommandList className="max-h-56 scroll-py-1">
                      {runtimeOptionsLoading ? (
                        <div className="flex min-h-8 items-center gap-2 rounded-lg px-3 py-1.5 text-ui-base text-remote-foreground-muted">
                          <LoaderCircle className="size-3.5 shrink-0 animate-spin" />
                          <span className="truncate">
                            {intl.formatMessage({ id: "docker.loading" })}
                          </span>
                        </div>
                      ) : null}
                      {dockerContainers.length === 0 && !runtimeOptionsLoading ? (
                        <CommandEmpty className="px-3 py-5 text-ui-base text-remote-foreground-muted">
                          {dockerContainerEmptyText}
                        </CommandEmpty>
                      ) : (
                        dockerContainers.map((container) => {
                          const selected = container.name === dockerContainer;

                          return (
                            <CommandItem
                              key={container.id}
                              value={container.name}
                              className="min-h-8 cursor-pointer gap-2 rounded-lg px-2 py-1.5 text-ui-base text-foreground data-selected:bg-menu-hover data-selected:text-foreground"
                              onSelect={() => {
                                setManualDockerContainer("");
                                setDockerContainer(container.name);
                                setDockerContainerPopoverOpen(false);
                              }}
                            >
                              <RemoteConnectionKindTile kind="docker" />
                              <span className="min-w-0 flex-1 truncate">{container.name}</span>
                              <CheckIcon
                                className={cn(
                                  "size-4 shrink-0 text-remote-foreground-muted",
                                  selected ? "opacity-100" : "opacity-0",
                                )}
                              />
                            </CommandItem>
                          );
                        })
                      )}
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
              <FieldError id={errorId("docker")} message={errorOf("docker")} />
              {/* 限制信息放到选择器下方：区分 Docker 不可用、发现失败与没有运行中的容器（RDUX-27）。 */}
              {runtimeOptionsLoading ? null : runtimeOptionsError || dockerAvailable === false ? (
                <FieldHint tone="warning">{dockerContainerEmptyText}</FieldHint>
              ) : dockerContainers.length === 0 ? (
                <FieldHint>{dockerContainerEmptyText}</FieldHint>
              ) : null}
            </div>
          ) : (
            <div>
              <FieldLabel htmlFor={`${fieldId}-docker.container`}>
                {intl.formatMessage({ id: "docker.container" })}
              </FieldLabel>
              <Input
                size="lg"
                className="h-9 text-ui-base"
                value={manualDockerContainer}
                onChange={(event) => {
                  setDockerContainer("");
                  setManualDockerContainer(event.target.value);
                }}
                placeholder={intl.formatMessage({
                  id: "docker.containerPlaceholder",
                })}
                {...invalidProps("docker")}
                id={`${fieldId}-docker.container`}
                data-testid={TID_DOCKER_CONTAINER_INPUT}
              />
              <FieldError id={errorId("docker")} message={errorOf("docker")} />
              {manualDockerContainerIsEmpty && !errorOf("docker") ? (
                <FieldHint>{intl.formatMessage({ id: "docker.manualContainerHint" })}</FieldHint>
              ) : null}
            </div>
          )}
        </div>
      );
  }
}
