/* eslint-disable max-lines -- MCP 设置页集中维护列表、插件分组、表单入口和标题行模式切换，拆分会增加跨状态传递复杂度。 */
/**
 * MCP Settings Section
 *
 * Manages MCP server configuration in the settings page.
 * Supports the unified ZCode Agent MCP source backed by settings directories.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertToZCodeAgentMcpServer } from "@zcode/shared";
import {
  TID_MCP_OPEN_AUTHORIZATION_BUTTON,
  TID_PLUGIN_MCP_SERVER_ROW,
  testId,
} from "@zcode/shared/test-ids";
import type {
  RemoteTarget,
  WorkspaceMcpTrustDecision,
  ZCodeWorkspaceMcpTrustResult,
  ZCodeAvailablePluginSummary,
  ZCodeAgentMcpServer,
  ZCodeMcpListMode,
  ZCodeMcpServer,
  ZCodeMcpServerStatusSnapshot,
  ZCodePluginInfo,
} from "@zcode/shared";
import {
  isZCodeAgentMcpStatusModeUnsupportedError,
  type IServiceAccessor,
  type IMcpSyncService,
} from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { logger } from "@/logger.js";
import { McpServerForm } from "@/settings/McpServerForm.js";
import { McpServerList, McpStatusDot } from "@/settings/McpServerList.js";
import {
  formToConfig,
  type FormState,
  type McpEditorMode,
  type ServerScope,
} from "@/settings/mcpSettingsShared.js";
import { SettingsBreadcrumbReporter } from "@/settings/SettingsHeaderBreadcrumb.js";
import { SettingsResourceHeaderActions } from "@/settings/SettingsResourceHeaderActions.js";
import { PluginStoreAvatar } from "@/settings/PluginStoreAvatar.js";
import {
  PluginInstallEmptyState,
  PluginLoadingState,
  PluginSearchEmptyState,
} from "@/settings/PluginInstallEmptyState.js";
import {
  buildPluginMcpServerItems,
  filterLocalMcpServers,
  groupPluginMcpServersByPlugin,
  type PluginMcpServerItem,
} from "@/settings/pluginManagedResourceGroups.js";
import { resolvePluginDisplayName } from "@/settings/pluginStoreListing.js";
import {
  McpFailurePresentation,
  resolveMcpFailureMessageId,
} from "@/settings/McpFailurePresentation.js";
import {
  SettingsResourceGroupHeader,
  SettingsResourceList,
} from "@/settings/SettingsResourceGroup.js";
import { McpServersImportDialog } from "@/settings/ExternalAgentImportDialog.js";
import {
  formatRemoteSyncTargetLabel,
  shouldShowRemoteSyncActions,
  useSettingsDataSyncEntry,
} from "@/data-sync/index.js";
import { useMcpStore } from "@/store/mcpStore.js";
import { usePluginManagementStore } from "@/store/pluginManagementStore.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useConfigWorkspaceServices as useWorkspaceServices } from "@/workspace-config-catalog/index.js";
import type { ConfigWorkspaceTarget } from "@/workspace-config-catalog/index.js";
import { getPluginWorkspaceKey } from "@/settings/PluginScopeMenu.js";
import { ExternalLink, Import, Plus, UploadCloud } from "lucide-react";
import { SettingsSegmentedTabs } from "@/settings/SettingsSegmentedTabs.js";
import { selectPluginsForScope } from "@/settings/pluginCapabilityProjection.js";

const DEFAULT_MCP_SOURCE: ServerScope = "zcodeagentmcp";
const MCP_OAUTH_AUTHORIZATION_STATUS_REFRESH_MS = 1_000;
const MCP_OAUTH_AUTHORIZATION_STATUS_REFRESH_DURATION_MS = 5 * 60_000;
const MCP_OAUTH_AUTHORIZATION_FOLLOWUP_REFRESH_ATTEMPTS = 10;

export async function applyWorkspaceMcpTrustDecision(
  request: WorkspaceMcpTrustDecision,
  isCurrentTarget: () => boolean,
  decide: (request: WorkspaceMcpTrustDecision) => Promise<ZCodeWorkspaceMcpTrustResult>,
): Promise<boolean> {
  if (!isCurrentTarget()) return false;
  const result = await decide(request);
  if (!result.accepted) throw new Error(result.reasonCode ?? "workspace_mcp_trust_unavailable");
  return isCurrentTarget();
}

export function createMcpOAuthAuthorizationStatusRefreshDeadline(
  now: () => number = Date.now,
): number {
  return now() + MCP_OAUTH_AUTHORIZATION_STATUS_REFRESH_DURATION_MS;
}

export function isMcpOAuthAuthorizationStatusRefreshExpired(
  deadline: number,
  now: () => number = Date.now,
): boolean {
  return now() >= deadline;
}

export type McpServerStatusListRefreshOutcome =
  | "refreshed"
  | "stale-workspace"
  | "status-mode-unsupported";

export async function refreshMcpServerStatusList({
  beginServerStatusListRefresh,
  markServerStatusListRefreshFailed,
  mergeServerStatusSnapshots,
  getCurrentWorkspaceKey,
  mode,
  mcpServers,
  requestedWorkspaceKey,
  workspaceIdentity,
  workspacePath,
  mcpSyncService,
}: {
  beginServerStatusListRefresh: (mode?: ZCodeMcpListMode) => number;
  markServerStatusListRefreshFailed?: (
    error: string,
    requestEpoch: number,
    mode?: ZCodeMcpListMode,
  ) => void;
  mergeServerStatusSnapshots: (
    statuses: Record<string, ZCodeMcpServerStatusSnapshot>,
    requestEpoch: number,
    mode?: ZCodeMcpListMode,
  ) => void;
  getCurrentWorkspaceKey: () => string;
  mode?: ZCodeMcpListMode;
  mcpServers?: ZCodeAgentMcpServer[];
  requestedWorkspaceKey: string;
  workspaceIdentity?: string;
  workspacePath: string;
  // mcp/list 收敛到 IMcpSyncService——UI 不直接触达 zcodeAgentService。
  mcpSyncService: Pick<IMcpSyncService, "listWorkspaceMcpServerStatuses">;
}): Promise<McpServerStatusListRefreshOutcome> {
  if (!requestedWorkspaceKey || getCurrentWorkspaceKey() !== requestedWorkspaceKey) {
    return "stale-workspace";
  }
  const refreshMode = mode ?? "connect";
  const requestEpoch = beginServerStatusListRefresh(refreshMode);
  try {
    const result = await mcpSyncService.listWorkspaceMcpServerStatuses({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(mcpServers !== undefined ? { mcpServers } : {}),
      ...(mode ? { mode } : {}),
    });
    if (getCurrentWorkspaceKey() !== requestedWorkspaceKey) {
      return "stale-workspace";
    }
    mergeServerStatusSnapshots(result.statuses, requestEpoch, refreshMode);
    return "refreshed";
  } catch (error) {
    if (getCurrentWorkspaceKey() !== requestedWorkspaceKey) {
      return "stale-workspace";
    }
    if (refreshMode === "status" && isZCodeAgentMcpStatusModeUnsupportedError(error)) {
      return "status-mode-unsupported";
    }
    markServerStatusListRefreshFailed?.(
      error instanceof Error ? error.message : String(error),
      requestEpoch,
      refreshMode,
    );
    throw error;
  }
}

export interface McpOAuthAuthorizationPendingRefresh {
  mcpServers: ZCodeAgentMcpServer[];
  pendingKey: string;
  workspaceKey: string;
}

export function transitionMcpAutoStatusListRefreshKey(
  previousKey: string,
  nextKey: string,
): { lastRefreshKey: string; shouldRefresh: boolean } {
  if (!nextKey) {
    // workspace 切换会先清空 server/status；若空状态仍保留 A 的去重 key，
    // 回到相同配置的 A 时会被误判为已刷新，列表和 OAuth 轮询永久停在 unknown。
    return { lastRefreshKey: "", shouldRefresh: false };
  }
  return {
    lastRefreshKey: nextKey,
    shouldRefresh: previousKey !== nextKey,
  };
}

export interface McpOAuthAuthorizationFollowupRefresh {
  mcpServers: ZCodeAgentMcpServer[];
  refreshKey: string;
  workspaceKey: string;
}

export function transitionMcpOAuthAuthorizationPendingRefresh({
  activeWorkspaceKey,
  existingFollowup = null,
  mcpServers,
  now = Date.now,
  pendingKey,
  previous,
}: {
  activeWorkspaceKey: string;
  existingFollowup?: McpOAuthAuthorizationFollowupRefresh | null;
  mcpServers: ZCodeAgentMcpServer[];
  now?: () => number;
  pendingKey: string;
  previous: McpOAuthAuthorizationPendingRefresh | null;
}): {
  followup: McpOAuthAuthorizationFollowupRefresh | null;
  pending: McpOAuthAuthorizationPendingRefresh | null;
} {
  if (!activeWorkspaceKey) {
    return { followup: null, pending: null };
  }
  if (pendingKey) {
    return {
      followup: null,
      pending: {
        mcpServers: [...mcpServers],
        pendingKey,
        workspaceKey: activeWorkspaceKey,
      },
    };
  }
  if (existingFollowup?.workspaceKey === activeWorkspaceKey) {
    // follow-up 自己的 status merge 会改变 servers/snapshot 并重跑 transition；
    // 同 workspace 的有界重试窗口必须保持同一对象，不能在首包后把自己 cleanup。
    return { followup: existingFollowup, pending: null };
  }
  if (!previous || previous.workspaceKey !== activeWorkspaceKey) {
    return { followup: null, pending: null };
  }
  return {
    followup: {
      mcpServers: [...previous.mcpServers],
      refreshKey: `${activeWorkspaceKey}:${previous.pendingKey}:${now()}`,
      workspaceKey: activeWorkspaceKey,
    },
    pending: null,
  };
}

interface McpStatusListRefreshQueue {
  request: (runLatest: () => Promise<void>) => Promise<void>;
}

/** 刷新来源：manual 是用户点了刷新按钮，auto 是列表/配置变化驱动的自动刷新。 */
export type McpStatusListRefreshTrigger = "auto" | "manual";

export interface McpStatusListRefreshInput {
  activeWorkspaceKey: string;
  activeWorkspacePath?: string;
  configReadyWorkspaceKey: string;
  isConfigLoaded: boolean;
  serverStatusListKey: string;
  storeWorkspaceKey: string;
}

export function resolveMcpStatusListRefreshSkipReason({
  input,
  requestedWorkspaceKey,
  trigger,
}: {
  input: McpStatusListRefreshInput;
  requestedWorkspaceKey: string;
  trigger: McpStatusListRefreshTrigger;
}): string | undefined {
  if (!requestedWorkspaceKey) return "no-active-workspace";
  if (input.activeWorkspaceKey !== requestedWorkspaceKey) {
    return "workspace-changed";
  }
  if (input.storeWorkspaceKey !== requestedWorkspaceKey) {
    return "mcp-store-not-aligned";
  }
  if (input.configReadyWorkspaceKey !== requestedWorkspaceKey) {
    return "config-not-ready";
  }
  if (!input.isConfigLoaded) return "config-not-loaded";
  if (!input.activeWorkspacePath) return "no-workspace-path";
  // 只有宿主/插件内置 MCP、没有任何用户 MCP 时 serverStatusListKey 会是空串。
  // 自动刷新据此去重没问题，但用户点了刷新就必须真的发一次请求，否则按钮看起来完全没反应。
  if (!input.serverStatusListKey && trigger !== "manual") {
    return "empty-status-list-key";
  }
  return undefined;
}

export function createMcpStatusListRefreshQueue(): McpStatusListRefreshQueue {
  let inFlight: Promise<void> | null = null;
  let latestRun: (() => Promise<void>) | null = null;
  let rerunAfterCurrent = false;

  return {
    async request(runLatest) {
      latestRun = runLatest;
      if (inFlight) {
        rerunAfterCurrent = true;
        await inFlight;
        return;
      }

      inFlight = (async () => {
        try {
          do {
            rerunAfterCurrent = false;
            const run = latestRun ?? runLatest;
            latestRun = null;
            await run();
          } while (rerunAfterCurrent);
        } finally {
          inFlight = null;
        }
      })();

      await inFlight;
    },
  };
}

export function buildMcpOAuthAuthorizationStatusRefreshServers(
  servers: ZCodeMcpServer[],
  statusSnapshots: Record<string, ZCodeMcpServerStatusSnapshot> = {},
): ZCodeAgentMcpServer[] {
  const pendingSnapshotNames = new Set(
    Object.entries(statusSnapshots)
      .filter(([, snapshot]) => Boolean(snapshot.authorization?.authorizationUrl))
      .map(([serverName]) => serverName),
  );
  const result: ZCodeAgentMcpServer[] = [];
  const seenNames = new Set<string>();

  for (const server of servers) {
    if (server.source !== "zcodeagentmcp" || !server.enabled) {
      continue;
    }
    const hasPendingAuthorization =
      Boolean(server.authorization?.authorizationUrl) || pendingSnapshotNames.has(server.name);
    if (!hasPendingAuthorization || seenNames.has(server.name)) {
      continue;
    }
    const zcodeAgentServer = convertToZCodeAgentMcpServer(
      server.name,
      server.config,
      server.scope === "workspace" ? "workspace" : "user",
    );
    if (!zcodeAgentServer) {
      continue;
    }
    seenNames.add(server.name);
    result.push(zcodeAgentServer);
  }

  return result;
}

export function buildMcpOAuthAuthorizationStatusRefreshOptions(mcpServers: ZCodeAgentMcpServer[]): {
  mode: "status";
  mcpServers: ZCodeAgentMcpServer[];
} {
  return {
    // OAuth pending/follow-up/focus 刷新只读运行态，不能让 pending 子集进入 connect replace 路径。
    mode: "status",
    mcpServers,
  };
}

export function buildMcpServerStatusListKey(servers: ZCodeMcpServer[]): string {
  return servers
    .filter((server) => server.source === "zcodeagentmcp")
    .map((server) => {
      const enabledKey = server.enabled ? "enabled" : "disabled";
      return `${server.id}:${enabledKey}:${JSON.stringify(server.config)}`;
    })
    .join("|");
}

export function buildPluginMcpServerStatusListKey(plugins: ZCodePluginInfo[]): string {
  return plugins
    .map((plugin) => {
      const declaredNames = plugin.declaredMcpServerNames ?? [];
      const runtimeNames = plugin.mcpServerNames;
      if (!plugin.enabled || (declaredNames.length === 0 && runtimeNames.length === 0)) {
        return "";
      }
      return `${plugin.id}:${plugin.enabled ? "enabled" : "disabled"}:${[...declaredNames]
        .sort()
        .join(",")}:${[...runtimeNames].sort().join(",")}`;
    })
    .filter(Boolean)
    .join("|");
}

export function shouldShowPluginMcpServersInMcpSettings(isRemoteSyncContext: boolean): boolean {
  return !isRemoteSyncContext;
}

export function buildPendingMcpOAuthAuthorizationRefreshKey(
  servers: ZCodeMcpServer[],
  statusSnapshots: Record<string, ZCodeMcpServerStatusSnapshot> = {},
): string {
  const localPendingKeys = servers
    .filter(
      (server) =>
        server.source === "zcodeagentmcp" &&
        server.enabled &&
        Boolean(server.authorization?.authorizationUrl),
    )
    .map((server) => `${server.id}:${server.authorization?.startedAt ?? ""}`);
  const runtimePendingKeys = Object.entries(statusSnapshots)
    .filter(([, snapshot]) => Boolean(snapshot.authorization?.authorizationUrl))
    .map(([serverName, snapshot]) => `${serverName}:${snapshot.authorization?.startedAt ?? ""}`);
  return Array.from(new Set([...localPendingKeys, ...runtimePendingKeys])).join("|");
}

function PluginMcpServerList({
  items,
  pluginListingById,
  onOpenAuthorization,
}: {
  items: PluginMcpServerItem[];
  pluginListingById: ReadonlyMap<string, ZCodeAvailablePluginSummary["listing"]>;
  onOpenAuthorization?: (item: PluginMcpServerItem) => void;
}) {
  const { intl } = useZCodeIntl();
  const openAuthorizationLabel = intl.formatMessage({
    id: "settings.mcp.oauth.openAuthorization",
  });

  function resolveStatusDescription(item: PluginMcpServerItem): string {
    if (item.authorization?.authorizationUrl) {
      return intl.formatMessage({
        id: "settings.mcp.plugin.authorizationRequiredDescription",
      });
    }
    if (item.status === "error") {
      return intl.formatMessage({
        id: resolveMcpFailureMessageId(item.failureKind),
      });
    }
    if (item.active) {
      if (item.status === "connecting") {
        return intl.formatMessage({
          id: "settings.mcp.plugin.connectingDescription",
        });
      }
      if (item.status === "connected") {
        return intl.formatMessage({
          id: "settings.mcp.plugin.connectedDescription",
        });
      }
      if (item.status === "disconnected") {
        return intl.formatMessage({
          id: "settings.mcp.plugin.disconnectedDescription",
        });
      }
      return intl.formatMessage({ id: "settings.mcp.plugin.activeDescription" });
    }
    if (!item.pluginEnabled) {
      return intl.formatMessage({
        id: "settings.mcp.plugin.disabledDescription",
      });
    }
    return intl.formatMessage({
      id: "settings.mcp.plugin.unavailableDescription",
    });
  }

  return (
    <SettingsResourceList
      items={items}
      getKey={(item) => item.id}
      renderItem={(item) => {
        const statusDescription = resolveStatusDescription(item);
        return (
          <div
            className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 transition-colors hover:bg-hover"
            data-mcp-status={item.status ?? ""}
            data-mcp-tool-count={item.toolCount}
            data-testid={testId(TID_PLUGIN_MCP_SERVER_ROW, item.runtimeServerName)}
          >
            <div className="relative size-9 shrink-0" data-mcp-status-dot-placement="icon-corner">
              <PluginStoreAvatar
                item={{
                  name: item.pluginName,
                  listing: pluginListingById.get(item.pluginId),
                }}
                className="size-9 bg-background"
              />
              <span className="absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full bg-background">
                <McpStatusDot
                  status={item.status}
                  attention={Boolean(item.authorization?.authorizationUrl)}
                  disabled={!item.pluginEnabled}
                  reason={statusDescription}
                />
              </span>
            </div>
            <div className="min-w-0">
              <div className="truncate text-ui-base font-medium text-foreground">{item.name}</div>
              {item.status === "error" ? (
                <McpFailurePresentation error={item.error} failureKind={item.failureKind} />
              ) : (
                <div className="mt-0.5 truncate text-ui-sm text-foreground-subtle">
                  {statusDescription}
                </div>
              )}
            </div>
            {item.authorization?.authorizationUrl ? (
              <div className="flex min-w-0 max-w-full shrink-0 items-center gap-2">
                <Button
                  variant="link"
                  size="sm"
                  className="text-sky-500 hover:text-sky-600 dark:text-sky-400 dark:hover:text-sky-300"
                  aria-label={openAuthorizationLabel}
                  data-testid={testId(TID_MCP_OPEN_AUTHORIZATION_BUTTON, item.runtimeServerName)}
                  title={openAuthorizationLabel}
                  onClick={() => onOpenAuthorization?.(item)}
                >
                  <ExternalLink className="size-4" aria-hidden="true" />
                  <span className="hidden sm:inline">{openAuthorizationLabel}</span>
                </Button>
              </div>
            ) : null}
          </div>
        );
      }}
    />
  );
}

interface McpSettingsSectionProps {
  workspacePath?: string | null;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  remoteTarget?: RemoteTarget;
  isWebRemoteControl?: boolean;
  scopeFilter: "user" | "workspace";
  parentScopeKey: string;
  workspaceTabs: ConfigWorkspaceTarget[];
  searchQuery: string;
  onVisibleCountChange?: (count: number) => void;
  onEditorOpenChange?: (open: boolean) => void;
  onFormScopeKeyChange?: (scopeKey: string | null) => void;
  onOpenPluginStore?: () => void;
  showMarketplaceBreadcrumb?: boolean;
  /** Scope 选中在线远端设备的「用户」时为该设备；同步按钮只在此时显示。 */
  dataSyncSourceServerId?: string | null;
  unscopedServices?: IServiceAccessor;
  cacheAuthorityKey?: string;
}

export function McpSettingsSection({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  remoteTarget,
  isWebRemoteControl = false,
  scopeFilter,
  parentScopeKey,
  workspaceTabs,
  searchQuery,
  onVisibleCountChange,
  onEditorOpenChange,
  onFormScopeKeyChange,
  onOpenPluginStore,
  showMarketplaceBreadcrumb = false,
  dataSyncSourceServerId,
  unscopedServices,
  cacheAuthorityKey,
}: McpSettingsSectionProps) {
  const { intl, locale } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const services = useWorkspaceServices(
    workspacePath,
    remoteSessionId,
    workspaceIdentity,
    remoteTarget,
    { unscopedServices, forceUnscoped: Boolean(cacheAuthorityKey || unscopedServices) },
  );
  const platform = usePlatform();

  const storedServers = useMcpStore((s) => s.servers);
  const storedStatusSnapshots = useMcpStore((s) => s.statusSnapshots);
  const plugins = usePluginManagementStore((state) => state.plugins);
  const availablePlugins = usePluginManagementStore((state) => state.availablePlugins);
  const installedPlugins = usePluginManagementStore((state) => state.installedPlugins);
  const pluginStoreWorkspacePath = usePluginManagementStore((state) => state.workspacePath);
  const pluginStoreWorkspaceIdentity = usePluginManagementStore((state) => state.workspaceIdentity);
  const pluginStoreAuthorityKey = usePluginManagementStore((state) => state.authorityKey);
  const pluginConfigScope = usePluginManagementStore((state) => state.configScope);
  const initializePlugins = usePluginManagementStore((state) => state.initialize);
  const currentProjectPath = useMcpStore((s) => s.currentProjectPath);
  const currentWorkspaceIdentity = useMcpStore((s) => s.currentWorkspaceIdentity);
  const currentAuthorityKey = useMcpStore((s) => s.currentAuthorityKey);
  // Bug 原因：props 缺省时曾回退到当前 tab 的路径和 identity。远端「用户」本来就没有 identity，
  // 回退后混入当前 tab 的 identity，读写落到当前 tab 所在设备。
  // 修法：只用 Scope 目标（props）这一组绑定；唯一调用方 PluginsSection 总会传入目标路径。
  const activeWorkspacePath = workspacePath ?? undefined;
  const activeWorkspaceIdentity = workspaceIdentity;
  const activeWorkspaceKey = `${cacheAuthorityKey?.trim() || "workspace"}\0${activeWorkspaceIdentity?.trim() || activeWorkspacePath || ""}`;
  const currentMcpStoreWorkspaceKey = `${currentAuthorityKey?.trim() || "workspace"}\0${currentWorkspaceIdentity?.trim() || currentProjectPath}`;
  // 修复原因：active tab 会先于异步 MCP 目录加载切换；过渡帧不能把 A 的配置和
  // snapshot 投影到 B，更不能让后续 effect 把这些敏感配置发送给 B 的 Agent。
  const mcpStoreMatchesActiveWorkspace =
    Boolean(activeWorkspaceKey) && currentMcpStoreWorkspaceKey === activeWorkspaceKey;
  const servers = mcpStoreMatchesActiveWorkspace ? storedServers : [];
  const statusSnapshots = mcpStoreMatchesActiveWorkspace ? storedStatusSnapshots : {};
  const isConfigLoaded = useMcpStore((s) => s.isConfigLoaded);
  const ensureLoadedForWorkspace = useMcpStore((s) => s.ensureLoadedForWorkspace);
  const loadMcpFromUserDirectory = useMcpStore((s) => s.loadMcpFromUserDirectory);
  const toggleServer = useMcpStore((s) => s.toggleServer);
  const addScopedMcpServer = useMcpStore((s) => s.addScopedMcpServer);
  const updateScopedMcpServer = useMcpStore((s) => s.updateScopedMcpServer);
  const deleteScopedMcpServer = useMcpStore((s) => s.deleteScopedMcpServer);
  const updateServerStatus = useMcpStore((s) => s.updateServerStatus);
  const beginServerStatusListRefresh = useMcpStore((s) => s.beginServerStatusListRefresh);
  const markServerStatusListRefreshFailed = useMcpStore((s) => s.markServerStatusListRefreshFailed);
  const mergeServerStatusSnapshots = useMcpStore((s) => s.mergeServerStatusSnapshots);

  const [showForm, setShowForm] = useState(false);
  const [formScopeKey, setFormScopeKey] = useState(parentScopeKey);
  const [editingServer, setEditingServer] = useState<ZCodeMcpServer | null>(null);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const query = searchQuery;
  const [editorMode, setEditorMode] = useState<McpEditorMode>("form");
  const [mcpConfigReadyWorkspaceKey, setMcpConfigReadyWorkspaceKey] = useState("");
  const [mcpOAuthAuthorizationFollowupRefresh, setMcpOAuthAuthorizationFollowupRefresh] =
    useState<McpOAuthAuthorizationFollowupRefresh | null>(null);
  const [mcpStatusOnlyUnsupported, setMcpStatusOnlyUnsupported] = useState(false);
  const mcpStatusOnlyUnsupportedRef = useRef(false);
  const isFormView = showForm || editingServer !== null;
  useEffect(() => {
    onEditorOpenChange?.(isFormView);
  }, [isFormView, onEditorOpenChange]);
  useEffect(
    () => () => {
      onEditorOpenChange?.(false);
    },
    [onEditorOpenChange],
  );
  const serverStatusListKey = useMemo(
    () =>
      [buildMcpServerStatusListKey(servers), buildPluginMcpServerStatusListKey(plugins)]
        .filter(Boolean)
        .join("|"),
    [plugins, servers],
  );
  const statusListRefreshQueueRef = useRef<McpStatusListRefreshQueue | null>(null);
  if (!statusListRefreshQueueRef.current) {
    statusListRefreshQueueRef.current = createMcpStatusListRefreshQueue();
  }
  const latestStatusListRefreshInputRef = useRef<{
    activeWorkspaceIdentity?: string;
    activeWorkspaceKey: string;
    activeWorkspacePath?: string;
    configReadyWorkspaceKey: string;
    storeWorkspaceKey: string;
    isConfigLoaded: boolean;
    serverStatusListKey: string;
  }>({
    activeWorkspaceIdentity,
    activeWorkspaceKey,
    activeWorkspacePath: activeWorkspacePath ?? undefined,
    configReadyWorkspaceKey: mcpConfigReadyWorkspaceKey,
    isConfigLoaded,
    serverStatusListKey,
    storeWorkspaceKey: currentMcpStoreWorkspaceKey,
  });
  latestStatusListRefreshInputRef.current = {
    activeWorkspaceIdentity,
    activeWorkspaceKey,
    activeWorkspacePath: activeWorkspacePath ?? undefined,
    configReadyWorkspaceKey: mcpConfigReadyWorkspaceKey,
    isConfigLoaded,
    serverStatusListKey,
    storeWorkspaceKey: currentMcpStoreWorkspaceKey,
  };
  const autoStatusListRefreshKey = useMemo(() => {
    if (
      !isConfigLoaded ||
      !activeWorkspacePath ||
      !activeWorkspaceKey ||
      mcpConfigReadyWorkspaceKey !== activeWorkspaceKey ||
      !serverStatusListKey
    ) {
      return "";
    }
    return [activeWorkspaceIdentity ?? "", activeWorkspacePath, serverStatusListKey].join("\n");
  }, [
    activeWorkspaceIdentity,
    activeWorkspaceKey,
    activeWorkspacePath,
    isConfigLoaded,
    mcpConfigReadyWorkspaceKey,
    serverStatusListKey,
  ]);
  const pendingMcpOAuthAuthorizationRefreshKey = useMemo(
    () => buildPendingMcpOAuthAuthorizationRefreshKey(servers, statusSnapshots),
    [servers, statusSnapshots],
  );
  const pendingMcpOAuthAuthorizationRefreshServers = useMemo(
    () => buildMcpOAuthAuthorizationStatusRefreshServers(servers, statusSnapshots),
    [servers, statusSnapshots],
  );
  const pendingMcpOAuthAuthorizationRefreshDeadline = useMemo(
    () =>
      activeWorkspaceKey && pendingMcpOAuthAuthorizationRefreshKey
        ? createMcpOAuthAuthorizationStatusRefreshDeadline()
        : 0,
    // status snapshot merge 会重建 pending server 数组并重启轮询 effect；
    // deadline 只能随 workspace/pending 授权窗口变化，否则慢请求会不断续期 5 分钟窗口。
    [activeWorkspaceKey, pendingMcpOAuthAuthorizationRefreshKey],
  );
  const lastPendingMcpOAuthAuthorizationRefreshRef =
    useRef<McpOAuthAuthorizationPendingRefresh | null>(null);
  const lastAutoStatusListRefreshKeyRef = useRef("");
  const requestMcpServerStatusList = useCallback(
    async (options?: {
      mcpServers?: ZCodeAgentMcpServer[];
      mode?: ZCodeMcpListMode;
      trigger?: McpStatusListRefreshTrigger;
    }) => {
      const trigger = options?.trigger ?? "auto";
      const requestedWorkspaceKey = activeWorkspaceKey;
      const requestedInput = latestStatusListRefreshInputRef.current;
      // 队列 runner 和 in-flight response 都可能跨 workspace 生命周期；
      // active/store/readiness 三个 key 必须仍一致，才能发送请求或合并结果。
      const getCurrentRefreshWorkspaceKey = () => {
        const latest = latestStatusListRefreshInputRef.current;
        return latest.activeWorkspaceKey === latest.storeWorkspaceKey &&
          latest.configReadyWorkspaceKey === latest.activeWorkspaceKey
          ? latest.activeWorkspaceKey
          : "";
      };
      const isRequestCurrent = () => getCurrentRefreshWorkspaceKey() === requestedWorkspaceKey;
      const skipReason = resolveMcpStatusListRefreshSkipReason({
        input: requestedInput,
        requestedWorkspaceKey,
        trigger,
      });
      if (skipReason) {
        // 这些 guard 过去全是静默 return，用户点刷新后既没有请求也没有任何痕迹，
        // 复现时无法从日志判断"没发请求"还是"发了但读到旧状态"。
        if (trigger === "manual") {
          logger.warn("[mcp] manual status refresh skipped", {
            reason: skipReason,
            workspacePath: requestedInput.activeWorkspacePath,
          });
        }
        return;
      }
      if (options?.mode === "status" && mcpStatusOnlyUnsupportedRef.current) {
        return;
      }
      const requestedWorkspacePath = requestedInput.activeWorkspacePath;
      // skipReason 已经覆盖了这个分支，这里只为类型收窄。
      if (!requestedWorkspacePath) return;
      const requestedMcpServers =
        options?.mcpServers ?? useMcpStore.getState().getEnabledMcpServersForZCode("zcode");
      await statusListRefreshQueueRef.current?.request(async () => {
        if (!isRequestCurrent()) {
          return;
        }
        if (options?.mode === "status" && mcpStatusOnlyUnsupportedRef.current) {
          return;
        }

        const outcome = await refreshMcpServerStatusList({
          beginServerStatusListRefresh,
          getCurrentWorkspaceKey: getCurrentRefreshWorkspaceKey,
          markServerStatusListRefreshFailed,
          mergeServerStatusSnapshots,
          // 设置页列表可能来自 `.agents/mcp.json` fallback；agent 侧 mcp/list 自己
          // createConfig 读不到这批 UI-resolved MCP，必须和真实 session 一样显式下发。
          mcpServers: requestedMcpServers,
          mode: options?.mode,
          requestedWorkspaceKey,
          workspaceIdentity: requestedInput.activeWorkspaceIdentity,
          workspacePath: requestedWorkspacePath,
          mcpSyncService: services.mcpSyncService,
        }).catch((error) => {
          logger.warn("[mcp] list server statuses failed", {
            error: error instanceof Error ? error.message : String(error),
            workspacePath: requestedWorkspacePath,
          });
          if (trigger === "manual") {
            // Bugfix：手动刷新失败过去只进日志，用户看到的仍是旧状态且毫无提示。
            const message = error instanceof Error ? error.message : String(error);
            toast(intl.formatMessage({ id: "settings.mcp.refreshFailed" }, { error: message }), {
              durationMs: 8_000,
            });
          }
          return "failed" as const;
        });
        if (outcome === "stale-workspace" || !isRequestCurrent()) {
          return;
        }
        if (outcome === "status-mode-unsupported") {
          // 旧 Agent 会稳定拒绝 mode=status；继续 pending 定时器和焦点监听
          // 只会每秒制造同一条协议错误，且不可能推进 OAuth 状态。
          mcpStatusOnlyUnsupportedRef.current = true;
          lastPendingMcpOAuthAuthorizationRefreshRef.current = null;
          setMcpOAuthAuthorizationFollowupRefresh(null);
          setMcpStatusOnlyUnsupported(true);
          logger.warn("[mcp] status-only refresh unsupported; stop OAuth status polling", {
            workspacePath: requestedWorkspacePath,
          });
          toast(intl.formatMessage({ id: "settings.mcp.statusOnlyUnsupported" }), {
            durationMs: 8_000,
          });
        } else if (outcome === "refreshed" && options?.mode !== "status") {
          mcpStatusOnlyUnsupportedRef.current = false;
          setMcpStatusOnlyUnsupported(false);
        }
      });
    },
    [
      activeWorkspaceKey,
      beginServerStatusListRefresh,
      intl,
      markServerStatusListRefreshFailed,
      mergeServerStatusSnapshots,
      services.mcpSyncService,
    ],
  );

  const [refreshingStatusList, setRefreshingStatusList] = useState(false);
  // 刷新按钮过去点了没有任何可见反馈——请求可能被 guard 静默丢弃，也可能在飞行中。
  // 这里统一：先确保配置已加载，再以 manual 触发发一次请求，期间按钮进入 loading 态。
  const handleManualRefresh = useCallback(async () => {
    if (refreshingStatusList) return;
    setRefreshingStatusList(true);
    try {
      await loadMcpFromUserDirectory();
      if (activeWorkspacePath && !mcpConfigReadyWorkspaceKey) {
        const loaded = await ensureLoadedForWorkspace(
          activeWorkspacePath,
          services.mcpSyncService,
          activeWorkspaceIdentity,
          cacheAuthorityKey,
        );
        const state = useMcpStore.getState();
        const loadedWorkspaceKey = `${state.currentAuthorityKey?.trim() || "workspace"}\0${state.currentWorkspaceIdentity?.trim() || state.currentProjectPath}`;
        if (loaded && loadedWorkspaceKey === activeWorkspaceKey) {
          setMcpConfigReadyWorkspaceKey(activeWorkspaceKey);
          // ref 只在 render 时同步；这里补写一次，否则同一 tick 内紧接着的请求仍会
          // 因为 config-not-ready 被跳过，用户就得再点一次刷新。
          latestStatusListRefreshInputRef.current = {
            ...latestStatusListRefreshInputRef.current,
            configReadyWorkspaceKey: activeWorkspaceKey,
          };
        }
      }
      await requestMcpServerStatusList({ trigger: "manual" });
    } finally {
      setRefreshingStatusList(false);
    }
  }, [
    activeWorkspaceIdentity,
    activeWorkspaceKey,
    activeWorkspacePath,
    cacheAuthorityKey,
    ensureLoadedForWorkspace,
    loadMcpFromUserDirectory,
    mcpConfigReadyWorkspaceKey,
    refreshingStatusList,
    requestMcpServerStatusList,
    services.mcpSyncService,
  ]);

  useEffect(() => {
    lastPendingMcpOAuthAuthorizationRefreshRef.current = null;
    setMcpOAuthAuthorizationFollowupRefresh(null);
    mcpStatusOnlyUnsupportedRef.current = false;
    setMcpStatusOnlyUnsupported(false);
  }, [activeWorkspaceKey, services.mcpSyncService]);

  useEffect(() => {
    let cancelled = false;
    setMcpConfigReadyWorkspaceKey("");
    if (!activeWorkspacePath || !activeWorkspaceKey) {
      return;
    }

    void ensureLoadedForWorkspace(
      activeWorkspacePath,
      services.mcpSyncService,
      activeWorkspaceIdentity,
      cacheAuthorityKey,
    )
      .then((loaded) => {
        if (cancelled || !loaded) {
          return;
        }
        const state = useMcpStore.getState();
        const loadedWorkspaceKey = `${state.currentAuthorityKey?.trim() || "workspace"}\0${state.currentWorkspaceIdentity?.trim() || state.currentProjectPath}`;
        if (loadedWorkspaceKey === activeWorkspaceKey) {
          setMcpConfigReadyWorkspaceKey(activeWorkspaceKey);
        }
      })
      .catch((error) => {
        logger.warn("[mcp] load workspace config before status refresh failed", {
          error: error instanceof Error ? error.message : String(error),
          workspacePath: activeWorkspacePath,
        });
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeWorkspaceIdentity,
    activeWorkspaceKey,
    activeWorkspacePath,
    cacheAuthorityKey,
    ensureLoadedForWorkspace,
    services.mcpSyncService,
  ]);

  useEffect(() => {
    if (!activeWorkspacePath) {
      return;
    }
    void initializePlugins({
      pluginService: services.pluginManagementService,
      workspaceIdentity: activeWorkspaceIdentity,
      workspacePath: activeWorkspacePath,
      authorityKey: cacheAuthorityKey,
      configScope: scopeFilter,
    });
  }, [
    activeWorkspaceIdentity,
    activeWorkspacePath,
    cacheAuthorityKey,
    initializePlugins,
    scopeFilter,
    services.pluginManagementService,
  ]);

  useEffect(() => {
    const transition = transitionMcpAutoStatusListRefreshKey(
      lastAutoStatusListRefreshKeyRef.current,
      autoStatusListRefreshKey,
    );
    lastAutoStatusListRefreshKeyRef.current = transition.lastRefreshKey;
    if (!transition.shouldRefresh) {
      return;
    }
    void requestMcpServerStatusList();
  }, [autoStatusListRefreshKey, requestMcpServerStatusList]);

  useEffect(() => {
    if (!activeWorkspaceKey || mcpConfigReadyWorkspaceKey !== activeWorkspaceKey) {
      lastPendingMcpOAuthAuthorizationRefreshRef.current = null;
      setMcpOAuthAuthorizationFollowupRefresh(null);
      return;
    }
    const transition = transitionMcpOAuthAuthorizationPendingRefresh({
      activeWorkspaceKey,
      existingFollowup: mcpOAuthAuthorizationFollowupRefresh,
      mcpServers: pendingMcpOAuthAuthorizationRefreshServers,
      pendingKey: pendingMcpOAuthAuthorizationRefreshKey,
      previous: lastPendingMcpOAuthAuthorizationRefreshRef.current,
    });
    lastPendingMcpOAuthAuthorizationRefreshRef.current = transition.pending;
    // OAuth 回调完成到 MCP 重新连通之间会短暂清掉 authorizationUrl；
    // follow-up 必须携带原 workspaceKey，切换 workspace 时不能复用旧配置。
    setMcpOAuthAuthorizationFollowupRefresh(transition.followup);
  }, [
    activeWorkspaceKey,
    mcpConfigReadyWorkspaceKey,
    mcpOAuthAuthorizationFollowupRefresh,
    pendingMcpOAuthAuthorizationRefreshKey,
    pendingMcpOAuthAuthorizationRefreshServers,
  ]);

  useEffect(() => {
    if (
      !pendingMcpOAuthAuthorizationRefreshKey ||
      !activeWorkspaceKey ||
      mcpConfigReadyWorkspaceKey !== activeWorkspaceKey ||
      mcpStatusOnlyUnsupported
    ) {
      return;
    }

    let cancelled = false;
    let attempts = 0;
    let timeoutId: number | undefined;
    const deadline = pendingMcpOAuthAuthorizationRefreshDeadline;

    const scheduleNextRefresh = () => {
      if (cancelled || isMcpOAuthAuthorizationStatusRefreshExpired(deadline)) {
        return;
      }
      timeoutId = window.setTimeout(() => {
        if (cancelled || isMcpOAuthAuthorizationStatusRefreshExpired(deadline)) {
          return;
        }
        attempts += 1;
        logger.debug("[mcp] refresh status while OAuth authorization is pending", {
          attempt: attempts,
          deadline,
          pendingKey: pendingMcpOAuthAuthorizationRefreshKey,
          workspacePath: activeWorkspacePath,
        });
        // 修复原因：mcp/list 为了尽快返回 authorizationUrl 会让 agent 在后台等待 OAuth
        // 回调并重连；如果当前设置页不继续拉取 snapshot，UI 会停留在 connecting，直到切 tab 重挂载。
        // OAuth 轮询是高频请求，只能走 status-only，避免 pending 子集触发 replace 语义断开无关 MCP。
        void requestMcpServerStatusList(
          buildMcpOAuthAuthorizationStatusRefreshOptions(
            pendingMcpOAuthAuthorizationRefreshServers,
          ),
        ).finally(scheduleNextRefresh);
      }, MCP_OAUTH_AUTHORIZATION_STATUS_REFRESH_MS);
    };

    scheduleNextRefresh();

    return () => {
      cancelled = true;
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [
    activeWorkspacePath,
    activeWorkspaceKey,
    mcpConfigReadyWorkspaceKey,
    mcpStatusOnlyUnsupported,
    pendingMcpOAuthAuthorizationRefreshDeadline,
    pendingMcpOAuthAuthorizationRefreshKey,
    pendingMcpOAuthAuthorizationRefreshServers,
    requestMcpServerStatusList,
  ]);

  useEffect(() => {
    if (
      !mcpOAuthAuthorizationFollowupRefresh ||
      mcpOAuthAuthorizationFollowupRefresh.workspaceKey !== activeWorkspaceKey ||
      mcpConfigReadyWorkspaceKey !== activeWorkspaceKey ||
      mcpStatusOnlyUnsupported
    ) {
      return;
    }

    let cancelled = false;
    let attempts = 0;
    let timeoutId: number | undefined;

    const scheduleNextRefresh = () => {
      if (cancelled) {
        return;
      }
      if (attempts >= MCP_OAUTH_AUTHORIZATION_FOLLOWUP_REFRESH_ATTEMPTS) {
        setMcpOAuthAuthorizationFollowupRefresh((current) =>
          current?.refreshKey === mcpOAuthAuthorizationFollowupRefresh.refreshKey ? null : current,
        );
        return;
      }
      timeoutId = window.setTimeout(() => {
        attempts += 1;
        logger.debug("[mcp] refresh status after OAuth authorization state changed", {
          attempt: attempts,
          followupKey: mcpOAuthAuthorizationFollowupRefresh.refreshKey,
          workspacePath: activeWorkspacePath,
        });
        void requestMcpServerStatusList(
          buildMcpOAuthAuthorizationStatusRefreshOptions(
            mcpOAuthAuthorizationFollowupRefresh.mcpServers,
          ),
        ).finally(scheduleNextRefresh);
      }, MCP_OAUTH_AUTHORIZATION_STATUS_REFRESH_MS);
    };

    void requestMcpServerStatusList(
      buildMcpOAuthAuthorizationStatusRefreshOptions(
        mcpOAuthAuthorizationFollowupRefresh.mcpServers,
      ),
    ).finally(scheduleNextRefresh);

    return () => {
      cancelled = true;
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [
    activeWorkspacePath,
    activeWorkspaceKey,
    mcpConfigReadyWorkspaceKey,
    mcpOAuthAuthorizationFollowupRefresh,
    mcpStatusOnlyUnsupported,
    requestMcpServerStatusList,
  ]);

  useEffect(() => {
    if (
      !pendingMcpOAuthAuthorizationRefreshKey ||
      !activeWorkspaceKey ||
      mcpConfigReadyWorkspaceKey !== activeWorkspaceKey ||
      mcpStatusOnlyUnsupported
    ) {
      return;
    }

    const refreshAfterReturnFromBrowser = () => {
      logger.debug("[mcp] refresh status after returning from OAuth browser", {
        pendingKey: pendingMcpOAuthAuthorizationRefreshKey,
        workspacePath: activeWorkspacePath,
      });
      void requestMcpServerStatusList(
        buildMcpOAuthAuthorizationStatusRefreshOptions(pendingMcpOAuthAuthorizationRefreshServers),
      );
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        refreshAfterReturnFromBrowser();
      }
    };

    window.addEventListener("focus", refreshAfterReturnFromBrowser);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("focus", refreshAfterReturnFromBrowser);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [
    activeWorkspacePath,
    activeWorkspaceKey,
    mcpConfigReadyWorkspaceKey,
    mcpStatusOnlyUnsupported,
    pendingMcpOAuthAuthorizationRefreshKey,
    pendingMcpOAuthAuthorizationRefreshServers,
    requestMcpServerStatusList,
  ]);

  const scopedServers = useMemo(
    () =>
      servers.filter(
        (server) =>
          server.scope === scopeFilter || (scopeFilter === "user" && server.scope === "common"),
      ),
    [scopeFilter, servers],
  );
  const filteredServers = useMemo(
    () => filterLocalMcpServers(scopedServers, query),
    [query, scopedServers],
  );
  const connectedRemoteSyncTarget =
    shouldShowRemoteSyncActions({ remoteSessionId, remoteTarget, isWebRemoteControl }) &&
    activeWorkspacePath
      ? remoteTarget
      : null;
  const isRemoteSyncContext = Boolean(connectedRemoteSyncTarget);
  const pluginMcpServers = useMemo(() => {
    if (!shouldShowPluginMcpServersInMcpSettings(isRemoteSyncContext)) {
      // 插件 MCP 列表来自本机插件管理 store，不是当前远端目标。
      // 远端 MCP 设置页必须和 Skills 一样只展示远端工作区可读写的资源。
      return [];
    }
    // 插件 store 的 key 必须与 pluginManagementStoreLoading.buildWorkspaceKey 同格式
    // （authority\0identity|path），否则带 Source authority 的 activeWorkspaceKey 永远匹配不上。
    const pluginStoreWorkspaceKey = `${pluginStoreAuthorityKey?.trim() || "workspace"}\0${
      pluginStoreWorkspaceIdentity?.trim() || pluginStoreWorkspacePath || ""
    }`;
    const pluginStoreMatchesTarget =
      pluginStoreWorkspaceKey === activeWorkspaceKey && pluginConfigScope === scopeFilter;
    if (!pluginStoreMatchesTarget) {
      return [];
    }
    const scopedPlugins = selectPluginsForScope(plugins, installedPlugins, scopeFilter).filter(
      (plugin) => plugin.enabled,
    );
    return buildPluginMcpServerItems(scopedPlugins, query, statusSnapshots);
  }, [
    installedPlugins,
    activeWorkspaceKey,
    isRemoteSyncContext,
    pluginConfigScope,
    pluginStoreAuthorityKey,
    pluginStoreWorkspaceIdentity,
    pluginStoreWorkspacePath,
    plugins,
    query,
    scopeFilter,
    statusSnapshots,
  ]);
  const pluginListingById = useMemo(
    () => new Map(availablePlugins.map((plugin) => [plugin.id, plugin.listing])),
    [availablePlugins],
  );
  const filteredMcpCount = filteredServers.length + pluginMcpServers.length;
  const pluginMcpGroups = useMemo(
    () => groupPluginMcpServersByPlugin(pluginMcpServers),
    [pluginMcpServers],
  );
  const mcpProjectionReady =
    !activeWorkspacePath ||
    (mcpStoreMatchesActiveWorkspace && mcpConfigReadyWorkspaceKey === activeWorkspaceKey);
  const hasEmptySearchResult = Boolean(query.trim()) && filteredMcpCount === 0;
  const installedServers = useMemo(
    () =>
      filteredServers
        .map((server, index) => ({ index, server }))
        .toSorted((left, right) => {
          // Bug 原因：Source authority 提交从旧基线重放时恢复了已废弃的「需要关注」分组，
          // 把诊断分组改版重新拆成两套列表。异常项只在 Installed 内稳定置顶，避免重复分组。
          const leftAttention = Boolean(
            left.server.authorization?.authorizationUrl || left.server.status === "error",
          );
          const rightAttention = Boolean(
            right.server.authorization?.authorizationUrl || right.server.status === "error",
          );
          return Number(rightAttention) - Number(leftAttention) || left.index - right.index;
        })
        .map(({ server }) => server),
    [filteredServers],
  );
  const hideInstalledGroup = Boolean(query.trim()) && installedServers.length === 0;
  useEffect(() => {
    onVisibleCountChange?.(filteredMcpCount);
  }, [filteredMcpCount, onVisibleCountChange]);
  const remoteMcpSyncTargetLabel = connectedRemoteSyncTarget
    ? formatRemoteSyncTargetLabel(connectedRemoteSyncTarget, activeWorkspacePath ?? "")
    : "";
  // 同步按钮打开数据同步弹窗的 MCP 分类。设置页入口不传 workspace 映射：MCP 只做 home 改写。
  const dataSync = useSettingsDataSyncEntry({
    category: "mcp",
    sourceServerId: dataSyncSourceServerId,
    onPushFinished: async () => {
      const loaded = await loadMcpFromUserDirectory();
      if (loaded) {
        await requestMcpServerStatusList();
      }
    },
  });

  async function handleToggle(id: string, enabled: boolean) {
    await toggleServer(id, enabled);

    if (!enabled) {
      // 禁用后的 unknown 只是本地展示态；toggleServer 已经作废旧请求，
      // 这里不能再推进 epoch，否则刚返回的 mcp/list 会被丢弃并造成反复转圈。
      updateServerStatus(id, "unknown", undefined, {
        invalidateStatusListRequests: false,
      });
      return;
    }

    // renderer 侧浅检查无法真实启动 stdio MCP，曾把不存在的 command 误判为 connected。
    // 打开后只展示连接中，最终绿/红状态统一等待 agent 侧 mcp/list 真实 connect/listTools 回写。
    if (!activeWorkspacePath) {
      updateServerStatus(id, "unknown", undefined, {
        invalidateStatusListRequests: false,
      });
      return;
    }
    // connecting 只是等待真实 mcp/list 的临时展示态，不能作废随后发出的批量请求。
    updateServerStatus(id, "connecting", undefined, {
      invalidateStatusListRequests: false,
    });
    void requestMcpServerStatusList();
  }

  const trustTargetRef = useRef({
    workspaceKey: activeWorkspaceKey,
    service: services.mcpSyncService,
  });
  trustTargetRef.current = { workspaceKey: activeWorkspaceKey, service: services.mcpSyncService };

  const trustAbortRef = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      trustAbortRef.current?.abort();
      trustAbortRef.current = null;
    },
    [activeWorkspaceKey, services.mcpSyncService],
  );

  async function handleWorkspaceMcpTrust(server: ZCodeMcpServer) {
    const review = server.workspaceTrust;
    if (trustAbortRef.current) return;
    const controller = new AbortController();
    const target = trustTargetRef.current;
    const isCurrentTarget = () =>
      !controller.signal.aborted &&
      target.workspaceKey === trustTargetRef.current.workspaceKey &&
      target.service === trustTargetRef.current.service;
    const workspacePath = activeWorkspacePath;
    const decide = services.mcpSyncService.setWorkspaceMcpTrust;
    if (!review || !workspacePath || !decide || server.scope !== "workspace") return;
    trustAbortRef.current = controller;
    const trusted = !review.trusted;
    const confirmed = await confirmDialog(
      {
        title: intl.formatMessage(
          { id: trusted ? "settings.mcp.trust.title" : "settings.mcp.trust.revokeTitle" },
          { name: server.name },
        ),
        description: [
          intl.formatMessage({ id: "settings.mcp.trust.description" }),
          ...review.sourcePaths,
        ].join("\n\n"),
        // Host 已脱敏并格式化声明；使用代码组件保留缩进，不重新读取原始配置。
        codeBlock: { code: review.display, language: "json" },
        scrollableDescription: true,
        intent: "workspace-mcp-trust",
        confirmLabel: intl.formatMessage({
          id: trusted ? "settings.mcp.trust.action" : "settings.mcp.trust.revoke",
        }),
      },
      controller.signal,
    );
    if (!confirmed) {
      if (trustAbortRef.current === controller) trustAbortRef.current = null;
      return;
    }
    try {
      const current = await applyWorkspaceMcpTrustDecision(
        {
          workspacePath,
          ...(activeWorkspaceIdentity ? { workspaceIdentity: activeWorkspaceIdentity } : {}),
          serverName: server.name,
          declarationDigest: review.declarationDigest,
          trusted,
        },
        isCurrentTarget,
        (request) => decide.call(services.mcpSyncService, request),
      );
      if (current) await requestMcpServerStatusList({ mode: "status" });
    } catch {
      if (isCurrentTarget()) toast(intl.formatMessage({ id: "settings.mcp.trust.failed" }));
    } finally {
      if (trustAbortRef.current === controller) trustAbortRef.current = null;
    }
  }

  async function handleSave(form: FormState, prev?: ZCodeMcpServer) {
    if (!activeWorkspacePath) {
      return;
    }
    const loaded = await ensureLoadedForWorkspace(
      activeWorkspacePath,
      services.mcpSyncService,
      activeWorkspaceIdentity,
      cacheAuthorityKey,
    );
    if (!loaded) {
      return;
    }
    const config = {
      ...formToConfig(form),
      ...(prev?.enabled === false ? { enable: false } : {}),
    };
    // 表单 Scope 可以独立于父页面切换，不能继续读取可能仍属于旧目标的
    // currentProjectPath；保存目标必须使用表单已解析并完成加载的 workspace props。
    const projectPath = formScopeKey === "user" ? undefined : activeWorkspacePath;

    if (prev) {
      await updateScopedMcpServer(DEFAULT_MCP_SOURCE, prev.name, config, projectPath);
    } else {
      await addScopedMcpServer(DEFAULT_MCP_SOURCE, form.name, config, projectPath);
    }

    setShowForm(false);
    setEditingServer(null);
    onFormScopeKeyChange?.(null);
  }

  async function handleDelete(server: ZCodeMcpServer) {
    const confirmed = await confirmDialog({
      confirmVariant: "destructive",
      title: intl.formatMessage({ id: "settings.mcp.deleteConfirmTitle" }, { name: server.name }),
      description: intl.formatMessage({
        id: "settings.mcp.deleteConfirmDescription",
      }),
      confirmLabel: intl.formatMessage({
        id: "settings.mcp.deleteConfirmAction",
      }),
      cancelLabel: intl.formatMessage({ id: "common.cancel" }),
    });

    if (!confirmed) {
      return;
    }

    await deleteScopedMcpServer(server.source, server.name, server.projectPath);
    setEditingServer(null);
    setShowForm(false);
    setEditorMode("form");
    onFormScopeKeyChange?.(null);
  }

  function handleEdit(server: ZCodeMcpServer) {
    const ownerWorkspace = workspaceTabs.find((tab) => tab.workspacePath === server.projectPath);
    const ownedScopeKey =
      server.scope === "workspace"
        ? ownerWorkspace
          ? getPluginWorkspaceKey(ownerWorkspace)
          : parentScopeKey
        : "user";
    setFormScopeKey(ownedScopeKey);
    onFormScopeKeyChange?.(ownedScopeKey);
    setEditingServer(server);
    setShowForm(false);
    setEditorMode("form");
  }

  function handleCreate() {
    setFormScopeKey(parentScopeKey);
    onFormScopeKeyChange?.(parentScopeKey);
    setEditingServer(null);
    setEditorMode("form");
    setShowForm(true);
  }

  function handleOpenAuthorization(server: ZCodeMcpServer) {
    const authorizationUrl = server.authorization?.authorizationUrl;
    if (!authorizationUrl) {
      return;
    }
    platform.openExternal(authorizationUrl);
  }

  function handleOpenPluginAuthorization(item: PluginMcpServerItem) {
    const authorizationUrl = item.authorization?.authorizationUrl;
    if (!authorizationUrl) {
      return;
    }
    platform.openExternal(authorizationUrl);
  }

  if (isFormView) {
    const closeFormView = () => {
      setShowForm(false);
      setEditingServer(null);
      setEditorMode("form");
      onFormScopeKeyChange?.(null);
    };
    const pluginsBreadcrumbLabel = intl.formatMessage({ id: "settings.plugins.title" });
    const formBreadcrumbLabel =
      editingServer?.name ?? intl.formatMessage({ id: "settings.mcp.form.createTitle" });
    return (
      <div className="space-y-6">
        <SettingsBreadcrumbReporter
          items={
            showMarketplaceBreadcrumb
              ? [
                  { label: pluginsBreadcrumbLabel, onSelect: closeFormView },
                  { label: formBreadcrumbLabel },
                ]
              : [{ label: formBreadcrumbLabel }]
          }
          onSectionSelect={
            showMarketplaceBreadcrumb && onOpenPluginStore ? onOpenPluginStore : closeFormView
          }
        />
        <div className="space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <h3 className="text-ui-xl font-semibold text-foreground">
                {editingServer
                  ? intl.formatMessage({ id: "settings.mcp.form.editTitle" })
                  : intl.formatMessage({ id: "settings.mcp.form.createTitle" })}
              </h3>
              <p className="text-ui-base text-foreground-subtle">
                {editingServer
                  ? intl.formatMessage({
                      id: "settings.mcp.form.editDescription",
                    })
                  : intl.formatMessage({
                      id: "settings.mcp.form.createDescription",
                    })}
              </p>
            </div>
            <div className="shrink-0 self-end">
              <SettingsSegmentedTabs
                value={editorMode}
                items={[
                  {
                    value: "form",
                    label: intl.formatMessage({
                      id: "settings.mcp.form.mode.form",
                    }),
                  },
                  { value: "json", label: "JSON" },
                ]}
                onValueChange={setEditorMode}
              />
            </div>
          </div>

          <McpServerForm
            initial={editingServer ?? undefined}
            editingId={editingServer?.id}
            editorMode={editorMode}
            source={editingServer?.source ?? DEFAULT_MCP_SOURCE}
            scopeKey={formScopeKey}
            workspaceTabs={workspaceTabs}
            onScopeKeyChange={(nextScopeKey) => {
              setFormScopeKey(nextScopeKey);
              onFormScopeKeyChange?.(nextScopeKey);
            }}
            onEditorModeChange={setEditorMode}
            onSave={handleSave}
            onDelete={editingServer ? handleDelete : undefined}
            onCancel={closeFormView}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {dataSync.visible ? (
        <div className="flex justify-end">
          <ControlHintTooltip title={intl.formatMessage({ id: "settings.mcp.remoteSync.open" })}>
            <Button
              type="button"
              variant="outline"
              size="icon-lg"
              data-testid="data-sync-entry-mcp"
              disabled={dataSync.disabled}
              aria-label={intl.formatMessage({
                id: "settings.mcp.remoteSync.open",
              })}
              onClick={dataSync.open}
            >
              <UploadCloud className="size-3.5" aria-hidden="true" />
            </Button>
          </ControlHintTooltip>
        </div>
      ) : null}

      {connectedRemoteSyncTarget ? (
        <div className="rounded-lg border border-border bg-card px-3 py-2 text-ui-base text-foreground-subtle">
          {intl.formatMessage(
            { id: "settings.mcp.remoteContext" },
            { target: remoteMcpSyncTargetLabel },
          )}
        </div>
      ) : null}

      {!mcpProjectionReady ? (
        <PluginLoadingState label={intl.formatMessage({ id: "common.loading" })} />
      ) : hasEmptySearchResult ? (
        <PluginSearchEmptyState
          label={intl.formatMessage({
            id: "settings.plugin.mcp.searchEmpty",
          })}
        />
      ) : null}
      <div
        className={!mcpProjectionReady || hasEmptySearchResult ? "hidden" : "space-y-6"}
        data-mcp-list-layout="grouped"
      >
        <section
          className={hideInstalledGroup ? "hidden" : "space-y-4"}
          data-mcp-plugin-group="installed"
        >
          <div data-mcp-plugin-installed-actions="true">
            <SettingsResourceGroupHeader
              actions={
                <SettingsResourceHeaderActions
                  refreshTestId="mcp-settings-refresh"
                  onRefresh={() => void handleManualRefresh()}
                  refreshing={refreshingStatusList}
                  onImport={() => setImportDialogOpen(true)}
                  onNew={handleCreate}
                  importActionId="settings.mcp.import.open"
                  newActionId="settings.mcp.create.open"
                />
              }
              count={installedServers.length}
              title={intl.formatMessage({
                id: "settings.plugin.mcp.installed",
              })}
            />
          </div>
          {installedServers.length > 0 ? (
            <McpServerList
              hideMetadata
              servers={installedServers}
              onCreate={handleCreate}
              onEdit={handleEdit}
              onToggle={handleToggle}
              onOpenAuthorization={handleOpenAuthorization}
              onTrust={handleWorkspaceMcpTrust}
              emptyTitle={intl.formatMessage({ id: "settings.mcp.emptyTitle" })}
              emptyDescription={intl.formatMessage({
                id: "settings.mcp.emptyDescription",
              })}
            />
          ) : scopedServers.length === 0 && !query.trim() ? (
            <PluginInstallEmptyState
              title={intl.formatMessage({
                id: "settings.plugin.mcp.emptyInstalledTitle",
              })}
              description={intl.formatMessage({
                id: "settings.plugin.mcp.emptyInstalledDescription",
              })}
              actions={
                <>
                  <Button
                    type="button"
                    variant="default"
                    size="lg"
                    onClick={() => {
                      handleCreate();
                    }}
                  >
                    <Plus data-icon="inline-start" aria-hidden="true" />
                    {intl.formatMessage({
                      id: "settings.plugin.mcp.newServer",
                    })}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="lg"
                    onClick={() => setImportDialogOpen(true)}
                  >
                    <Import data-icon="inline-start" aria-hidden="true" />
                    {intl.formatMessage({ id: "settings.mcp.import.action" })}
                  </Button>
                </>
              }
            />
          ) : null}
        </section>
        {pluginMcpGroups.map((group) => (
          <section
            key={group.pluginId}
            className="space-y-4"
            data-mcp-plugin-group={group.pluginId}
          >
            <SettingsResourceGroupHeader
              count={group.items.length}
              title={resolvePluginDisplayName(
                {
                  name: group.pluginName,
                  listing: pluginListingById.get(group.pluginId),
                },
                locale,
              )}
            />
            <PluginMcpServerList
              items={group.items}
              pluginListingById={pluginListingById}
              onOpenAuthorization={handleOpenPluginAuthorization}
            />
          </section>
        ))}
      </div>
      <McpServersImportDialog
        // 对话框携带的是 mcpStore 的 currentProjectPath，只有它与当前 target
        // 一致时才和 services 的 host 同源；不一致的过渡帧不能让导入按 A 的 host 落盘 B 的路径。
        open={importDialogOpen && mcpStoreMatchesActiveWorkspace}
        workspacePath={currentProjectPath}
        workspaceIdentity={activeWorkspaceIdentity}
        settingsSyncService={services.settingsSyncService}
        onOpenChange={setImportDialogOpen}
        onImported={async () => {
          await loadMcpFromUserDirectory();
        }}
      />
      {dataSync.dialog}
    </div>
  );
}
