import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  IMemoryService,
  IServiceAccessor,
  ProjectMemoryWorkspaceSummary,
} from "@zcode/services";
import { Alert, AlertDescription } from "@/components/ui/alert.js";
import { Button } from "@/components/ui/button.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useSettings, updateSettingsAndRefreshSnapshot } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { runUserAction, runUserActionAsync } from "@/lib/userActionTelemetry.js";
import { logger } from "@/logger.js";
import {
  SettingsScopeBlockedNotice,
  resolveSettingsScopeBlock,
  useSettingsScope,
  type SettingsScopeDevice,
} from "@/settings-scope/index.js";
import { PluginScopeMenu } from "@/settings/PluginScopeMenu.js";

import { TID_SETTINGS_MEMORY_SWITCH } from "@zcode/shared/test-ids";
import { Switch } from "@/components/ui/switch.js";
import {
  MemorySettingsViewer,
  type MemoryViewerLoadingState,
} from "@/settings/MemorySettingsViewer.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

interface MemorySettingsPageProps {
  workspacePath?: string | null;
  workspaceIdentity?: string | null;
  isDesktop: boolean;
  workspaceDisplayNames: readonly string[];
}

const LOCAL_MEMORY_DEVICE = { kind: "local" } as const;

export function MemorySettingsPage(props: MemorySettingsPageProps) {
  const services = useBaseWorkspaceServices();
  // 手机保留当前 Host 的入口，不挂载桌面设备目录或申请 source-settings attachment。
  if (props.isDesktop) return <DesktopMemorySettingsPage {...props} />;
  return (
    <ServiceProvider services={services}>
      <MemoryDeviceSettings
        services={services}
        device={LOCAL_MEMORY_DEVICE}
        isDesktop={false}
        workspaceDisplayNames={props.workspaceDisplayNames}
      />
    </ServiceProvider>
  );
}

/** 设备选择与其他配置页同源；开关属于设备，不提供项目级选项。 */
function DesktopMemorySettingsPage({
  workspacePath,
  workspaceIdentity,
  isDesktop,
  workspaceDisplayNames,
}: MemorySettingsPageProps) {
  const scope = useSettingsScope({ workspacePath, workspaceIdentity });
  const groups = useMemo(
    () =>
      scope.groups
        .map((group) => ({
          ...group,
          options: group.options.filter((option) => option.kind === "user"),
        }))
        .filter((group) => group.options.length > 0),
    [scope.groups],
  );
  const blocked = resolveSettingsScopeBlock(scope, true);
  const user = scope.user.status === "ready" ? scope.user : null;

  return (
    <div className="space-y-6">
      {isDesktop ? (
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <PluginScopeMenu
            groups={groups}
            selectedScopeKey={scope.selectedScopeKey}
            selectedDevice={scope.device}
            triggerTestId="settings-memory-device-trigger"
            onScopeKeyChange={scope.setSelectedScopeKey}
          />
        </div>
      ) : null}
      {blocked ? (
        <SettingsScopeBlockedNotice state={blocked} device={scope.device} />
      ) : user ? (
        // 切换设备时卸载旧投影，防止旧开关、保存错误和 catalog 短暂显示在新设备下。
        <ServiceProvider services={user.unscopedServices} key={scope.selectedScopeKey}>
          <MemoryDeviceSettings
            services={user.unscopedServices}
            device={scope.device}
            isDesktop={isDesktop}
            workspaceDisplayNames={workspaceDisplayNames}
          />
        </ServiceProvider>
      ) : null}
    </div>
  );
}

function MemoryDeviceSettings({
  services,
  device,
  isDesktop,
  workspaceDisplayNames,
}: {
  services: IServiceAccessor;
  device: SettingsScopeDevice;
  isDesktop: boolean;
  workspaceDisplayNames: readonly string[];
}) {
  const { intl } = useZCodeIntl();
  const { settings, loading, error, refresh } = useSettings({ services });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const isLocal = device.kind === "local";
  const onMemoryEnabledChange = useCallback(
    async (enabled: boolean) => {
      setSaving(true);
      setSaveError(null);
      try {
        await runUserActionAsync({
          input: { featureId: "settings.memory", action: "toggle_memory", trigger: "switch" },
          operation: async () => {
            // 原先开关固定写 base Host，远端因此无效。整次写入绑定所选设备，不同步本机设置。
            await updateSettingsAndRefreshSnapshot({
              settingService: services.settingService,
              patch: { memoryEnabled: enabled },
            });
            if (isLocal) {
              await services.onboardingRecordService
                ?.updateRecordPreferences({ memoryEnabled: enabled })
                .catch((cause: unknown) =>
                  logger.warn("[memory-settings] 回写引导记录失败", cause),
                );
            }
          },
          completed: {
            resultSource: "shared_settings",
            stateAfter: enabled ? "enabled" : "disabled",
          },
          failureStage: "settings_commit",
        });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        setSaveError(message);
        logger.warn("[memory-settings] 保存设备记忆开关失败", { device, error: message });
      } finally {
        setSaving(false);
      }
    },
    [device, isLocal, services],
  );
  const readError = error instanceof Error ? error.message : error ? String(error) : null;

  return (
    <div className="space-y-6">
      {readError || saveError ? (
        <Alert data-testid="settings-memory-error">
          <AlertDescription>{readError || saveError}</AlertDescription>
          {readError ? (
            <Button variant="outline" onClick={() => void refresh()}>
              {intl.formatMessage({ id: "common.retry" })}
            </Button>
          ) : null}
        </Alert>
      ) : null}
      {!settings && !readError ? (
        <SettingsScopeBlockedNotice state="connecting" device={device} />
      ) : settings ? (
        <MemorySettingsSection
          memoryEnabled={settings.memoryEnabled === true}
          memoryService={services.memoryService}
          onMemoryEnabledChange={onMemoryEnabledChange}
          disabled={loading || saving || Boolean(readError)}
          projectMemoryViewerAvailable={isDesktop && isLocal}
          remoteDevice={!isLocal}
          workspaceDisplayNames={workspaceDisplayNames}
        />
      ) : null}
    </div>
  );
}

type MemoryCatalogService = Pick<IMemoryService, "listProjectMemories">;

function normalizeWorkspaceDisplayName(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "project";
}

function buildWorkspaceDisplayNameMap(names: readonly string[]): ReadonlyMap<string, string> {
  const matches = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const candidate of names) {
    const displayName = candidate.trim();
    const slug = normalizeWorkspaceDisplayName(displayName);
    if (!displayName || !slug || ambiguous.has(slug)) continue;
    const existing = matches.get(slug);
    if (existing && existing !== displayName) {
      matches.delete(slug);
      ambiguous.add(slug);
      continue;
    }
    matches.set(slug, displayName);
  }
  return matches;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function MemorySettingsSection({
  memoryEnabled,
  memoryService,
  onMemoryEnabledChange,
  disabled = false,
  projectMemoryViewerAvailable,
  remoteDevice = false,
  workspaceDisplayNames = [],
}: {
  memoryEnabled: boolean;
  memoryService: MemoryCatalogService;
  onMemoryEnabledChange: (enabled: boolean) => Promise<void>;
  disabled?: boolean;
  projectMemoryViewerAvailable: boolean;
  remoteDevice?: boolean;
  workspaceDisplayNames?: readonly string[];
}) {
  const { intl } = useZCodeIntl();
  const catalogRequestIdRef = useRef(0);
  const [catalogState, setCatalogState] = useState<MemoryViewerLoadingState>("idle");
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<ProjectMemoryWorkspaceSummary[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);

  const refreshCatalog = useCallback(async (): Promise<ProjectMemoryWorkspaceSummary[] | null> => {
    const requestId = catalogRequestIdRef.current + 1;
    catalogRequestIdRef.current = requestId;
    setCatalogState("loading");
    setCatalogError(null);
    try {
      const result = await memoryService.listProjectMemories();
      if (catalogRequestIdRef.current !== requestId) {
        return null;
      }
      setWorkspaces(result);
      setCatalogState("ready");
      return result;
    } catch (error) {
      if (catalogRequestIdRef.current !== requestId) {
        return null;
      }
      setWorkspaces([]);
      setSelectedWorkspaceId(null);
      setCatalogError(getErrorMessage(error));
      setCatalogState("error");
      return null;
    }
  }, [memoryService]);

  useEffect(() => {
    if (memoryEnabled && projectMemoryViewerAvailable) {
      void refreshCatalog();
      return;
    }

    catalogRequestIdRef.current += 1;
    setCatalogState("idle");
    setCatalogError(null);
    setWorkspaces([]);
    setSelectedWorkspaceId(null);
  }, [memoryEnabled, projectMemoryViewerAvailable, refreshCatalog]);

  const displayWorkspaces = useMemo(() => {
    const displayNameBySlug = buildWorkspaceDisplayNameMap(workspaceDisplayNames);
    const orderBySlug = new Map<string, number>();
    for (const [index, name] of workspaceDisplayNames.entries()) {
      const slug = normalizeWorkspaceDisplayName(name);
      if (!orderBySlug.has(slug)) orderBySlug.set(slug, index);
    }
    return workspaces
      .map((workspace, catalogIndex) => {
        const slug = normalizeWorkspaceDisplayName(workspace.label);
        return {
          catalogIndex,
          order: orderBySlug.get(slug) ?? Number.POSITIVE_INFINITY,
          workspace: {
            ...workspace,
            label: displayNameBySlug.get(slug) ?? workspace.label,
          },
        };
      })
      .sort((left, right) => left.order - right.order || left.catalogIndex - right.catalogIndex)
      .map(({ workspace }) => workspace);
  }, [workspaceDisplayNames, workspaces]);
  const selectedWorkspace = useMemo(
    () => displayWorkspaces.find((workspace) => workspace.id === selectedWorkspaceId),
    [displayWorkspaces, selectedWorkspaceId],
  );

  useEffect(() => {
    const firstWorkspace = displayWorkspaces[0];
    if (!firstWorkspace) {
      setSelectedWorkspaceId(null);
      return;
    }
    if (
      !selectedWorkspaceId ||
      !displayWorkspaces.some((workspace) => workspace.id === selectedWorkspaceId)
    ) {
      setSelectedWorkspaceId(firstWorkspace.id);
    }
  }, [displayWorkspaces, selectedWorkspaceId]);

  const handleRefresh = useCallback(async () => {
    await runUserActionAsync({
      input: { featureId: "settings.memory", action: "refresh_memory", trigger: "button" },
      operation: refreshCatalog,
      completed: { resultSource: "platform_result" },
      failureStage: "catalog_refresh",
    });
  }, [refreshCatalog]);

  return (
    <div className="space-y-6">
      <SettingsGroupCard>
        <SettingsRow
          searchId="settings.memory.workspaceMemory"
          label={intl.formatMessage({
            id: "settings.memory.workspaceMemory",
          })}
          description={intl.formatMessage({
            id: "settings.memoryDescription",
          })}
          control={
            <Switch
              aria-label={intl.formatMessage({
                id: "settings.memory.workspaceMemory",
              })}
              checked={memoryEnabled}
              disabled={disabled}
              data-testid={TID_SETTINGS_MEMORY_SWITCH}
              onCheckedChange={(checked) => {
                void onMemoryEnabledChange(checked);
              }}
            />
          }
        />
      </SettingsGroupCard>

      {!projectMemoryViewerAvailable ? (
        <div
          data-testid={remoteDevice ? "settings-memory-remote-details" : undefined}
          className="rounded-xl border border-dashed border-border bg-transparent px-4 py-8 text-center text-ui-base text-foreground-subtle"
        >
          {intl.formatMessage({
            id: remoteDevice
              ? "settings.memory.viewer.remoteUnavailable"
              : "settings.memory.viewer.localOnly",
          })}
        </div>
      ) : !memoryEnabled ? null : (
        <MemorySettingsViewer
          catalogError={catalogError}
          catalogState={catalogState}
          selectedWorkspace={selectedWorkspace}
          workspaces={displayWorkspaces}
          onRefresh={handleRefresh}
          onScopeKeyChange={(workspaceId) =>
            runUserAction({
              input: {
                featureId: "settings.memory",
                action: "change_memory_scope",
                trigger: "select",
              },
              operation: () => setSelectedWorkspaceId(workspaceId),
              completed: { resultSource: "local_commit" },
              failureStage: "local_commit",
            })
          }
        />
      )}
    </div>
  );
}
