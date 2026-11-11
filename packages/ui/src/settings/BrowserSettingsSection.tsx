/* oxlint-disable eslint(max-lines) -- Browser Plugin、Chrome 数据导入与清理共享同一平台状态机，拆分会扩大 pending/失败回收边界。 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import type { ChromeBrowserDataImportResult } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.js";
import { Switch } from "@/components/ui/switch.js";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { invalidateDeferredDraftSessionForSkillChange } from "@/lib/zcodeDraftSkillInvalidation.js";
import { logger } from "@/logger.js";
import { startUserAction } from "@/lib/userActionTelemetry.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { FileTreeHtmlOpenSetting } from "@/settings/FileTreeHtmlOpenSetting.js";
import { usePluginManagementStore } from "@/store/pluginManagementStore.js";
import { useSkillStore } from "@/store/skillStore.js";
import { clearBrowserRecentVisits } from "@/store/browserRecentVisitsStore.js";
import { formatImportSummary } from "./browserImportSummary.js";

const OFFICIAL_BROWSER_USE_PLUGIN_ID = "browser-use@zcode-plugins-official";

interface BrowserSettingsSectionProps {
  isDesktop: boolean;
  isWindowsDesktop?: boolean;
  workspacePath?: string | null;
  workspaceIdentity?: string;
  embeddedBrowserAllowInsecureCertificates?: boolean;
  onEmbeddedBrowserAllowInsecureCertificatesChange?: (enabled: boolean) => Promise<void>;
}

type BrowserDataOperation = "import" | "clear-cache" | "clear-all" | null;

function BrowserOperationButton({
  children,
  disabled,
  operation,
  pendingOperation,
  variant = "outline",
  onClick,
}: {
  children: ReactNode;
  disabled: boolean;
  operation: Exclude<BrowserDataOperation, null>;
  pendingOperation: BrowserDataOperation;
  variant?: "outline" | "destructive";
  onClick: () => void;
}) {
  const pending = pendingOperation === operation;
  return (
    <Button
      type="button"
      size="lg"
      variant={variant}
      disabled={disabled || pendingOperation !== null}
      onClick={onClick}
      className="min-w-24"
    >
      {pending ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : null}
      {children}
    </Button>
  );
}

export function BrowserSettingsSection({
  isDesktop,
  isWindowsDesktop = false,
  workspacePath,
  workspaceIdentity,
  embeddedBrowserAllowInsecureCertificates = false,
  onEmbeddedBrowserAllowInsecureCertificatesChange = async () => {},
}: BrowserSettingsSectionProps) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const { pluginManagementService, skillsService } = useServices();
  const browserUsePlugin = usePluginManagementStore((state) =>
    state.plugins.find((plugin) => plugin.id === OFFICIAL_BROWSER_USE_PLUGIN_ID),
  );
  const loading = usePluginManagementStore((state) => state.loading);
  const pluginError = usePluginManagementStore((state) => state.error);
  const togglingPluginId = usePluginManagementStore((state) => state.togglingPluginId);
  const initializePlugins = usePluginManagementStore((state) => state.initialize);
  const setPluginEnabled = usePluginManagementStore((state) => state.setEnabled);
  const refreshSkills = useSkillStore((state) => state.refresh);
  const skillStoreWorkspacePath = useSkillStore((state) => state.workspacePath);
  const skillStoreWorkspaceIdentity = useSkillStore((state) => state.workspaceIdentity);
  const [pendingOperation, setPendingOperation] = useState<BrowserDataOperation>(null);
  const [confirmClearAll, setConfirmClearAll] = useState(false);
  const [lastImportResult, setLastImportResult] = useState<ChromeBrowserDataImportResult | null>(
    null,
  );
  const normalizedWorkspaceIdentity = workspaceIdentity?.trim() || null;
  const nativeActionsAvailable =
    isDesktop &&
    typeof platform.importChromeBrowserData === "function" &&
    typeof platform.clearEmbeddedBrowserData === "function";

  useEffect(() => {
    if (!workspacePath) return;
    void initializePlugins({
      workspacePath,
      workspaceIdentity,
      pluginService: pluginManagementService,
    });
  }, [initializePlugins, pluginManagementService, workspaceIdentity, workspacePath]);

  const refreshAfterPluginChange = useCallback(async () => {
    await invalidateDeferredDraftSessionForSkillChange({
      workspacePath,
      workspaceIdentity: normalizedWorkspaceIdentity ?? undefined,
      reason: "settings-browser-use-plugin-enabled",
    });
    if (
      workspacePath &&
      skillStoreWorkspacePath === workspacePath &&
      skillStoreWorkspaceIdentity === normalizedWorkspaceIdentity
    ) {
      await refreshSkills(skillsService, normalizedWorkspaceIdentity ?? undefined);
    }
  }, [
    normalizedWorkspaceIdentity,
    refreshSkills,
    skillStoreWorkspaceIdentity,
    skillStoreWorkspacePath,
    skillsService,
    workspacePath,
  ]);

  const handleBrowserEnabledChange = useCallback(
    async (enabled: boolean) => {
      const trace = startUserAction({
        featureId: "settings.browser",
        action: "toggle_browser_use",
        trigger: "switch",
      });
      try {
        await setPluginEnabled(OFFICIAL_BROWSER_USE_PLUGIN_ID, enabled, pluginManagementService);
        const refreshedPlugin = usePluginManagementStore
          .getState()
          .plugins.find((plugin) => plugin.id === OFFICIAL_BROWSER_USE_PLUGIN_ID);
        if (refreshedPlugin?.enabled === enabled) {
          await refreshAfterPluginChange();
          toast(
            intl.formatMessage({
              id: enabled
                ? "settings.browser.control.enabledToast"
                : "settings.browser.control.disabledToast",
            }),
          );
        }
        trace.complete({
          resultSource: "platform_result",
          stateAfter: enabled ? "enabled" : "disabled",
        });
      } catch (error) {
        trace.fail({ failureStage: "plugin_update" });
        throw error;
      }
    },
    [intl, pluginManagementService, refreshAfterPluginChange, setPluginEnabled],
  );

  const handleImport = useCallback(async () => {
    if (!platform.importChromeBrowserData) return;
    setPendingOperation("import");
    const trace = startUserAction({
      featureId: "settings.browser",
      action: "import_browser_data",
      trigger: "button",
    });
    try {
      const result = await platform.importChromeBrowserData();
      trace.complete({ resultSource: "platform_result" });
      setLastImportResult(result);
      toast(formatImportSummary(result, intl.formatMessage), {
        durationMs: 5000,
      });
    } catch (error) {
      trace.fail({ failureStage: "browser_data_import" });
      logger.error("[browser-settings] 导入 Chrome 数据失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      toast(intl.formatMessage({ id: "settings.browser.import.failed" }));
    } finally {
      setPendingOperation(null);
    }
  }, [intl, platform]);

  const handleClear = useCallback(
    async (mode: "cache" | "all") => {
      if (!platform.clearEmbeddedBrowserData) return;
      setPendingOperation(mode === "cache" ? "clear-cache" : "clear-all");
      const trace = startUserAction({
        featureId: "settings.browser",
        action: mode === "cache" ? "clear_cache" : "clear_all_data",
        trigger: "button",
      });
      try {
        const result = await platform.clearEmbeddedBrowserData(mode);
        if (result.success && mode === "all") clearBrowserRecentVisits();
        trace.complete({ resultSource: "platform_result" });
        toast(
          intl.formatMessage({
            id: result.success
              ? mode === "cache"
                ? "settings.browser.clearCache.success"
                : "settings.browser.clearAll.success"
              : "settings.browser.clear.failed",
          }),
        );
      } catch (error) {
        trace.fail({ failureStage: "browser_data_clear" });
        logger.error("[browser-settings] 清理内置浏览器数据失败", {
          error: error instanceof Error ? error.message : String(error),
          mode,
        });
        toast(intl.formatMessage({ id: "settings.browser.clear.failed" }));
      } finally {
        setPendingOperation(null);
        setConfirmClearAll(false);
      }
    },
    [intl, platform],
  );

  const pluginTogglePending = togglingPluginId === OFFICIAL_BROWSER_USE_PLUGIN_ID;
  const pluginUnavailable = !workspacePath || loading || !browserUsePlugin;
  const operationDisabled = !nativeActionsAvailable;

  return (
    <div className="space-y-5">
      <section className="space-y-3">
        <SettingsGroupCard>
          <SettingsRow
            searchId="settings.browser.control.title"
            label={intl.formatMessage({ id: "settings.browser.control.title" })}
            description={intl.formatMessage({
              id: "settings.browser.control.description",
            })}
            control={
              <Switch
                aria-label={intl.formatMessage({
                  id: "settings.browser.control.title",
                })}
                checked={browserUsePlugin?.enabled === true}
                disabled={pluginUnavailable || pluginTogglePending}
                onCheckedChange={(checked) => void handleBrowserEnabledChange(checked)}
              />
            }
            detail={
              pluginError ? (
                <div className="text-ui-base text-destructive">{pluginError}</div>
              ) : undefined
            }
          />
          {/* 导入登录状态是“开启内置浏览器控制”之后的配套动作，与开关同卡片表达先后关系；
              清除类破坏性操作仍留在“浏览器数据”分组。
              Windows App-Bound 导入链路暂未开放，先隐藏入口但保留底层实现和清理能力。*/}
          {!isWindowsDesktop ? (
            <SettingsRow
              searchId="settings.browser.import.title"
              label={intl.formatMessage({ id: "settings.browser.import.title" })}
              description={intl.formatMessage({
                id: "settings.browser.import.description",
              })}
              control={
                <BrowserOperationButton
                  operation="import"
                  pendingOperation={pendingOperation}
                  disabled={operationDisabled}
                  onClick={() => void handleImport()}
                >
                  {intl.formatMessage({ id: "settings.browser.import.action" })}
                </BrowserOperationButton>
              }
              detail={
                lastImportResult ? (
                  <div className="text-ui-base text-foreground-subtle">
                    {formatImportSummary(lastImportResult, intl.formatMessage)}
                  </div>
                ) : undefined
              }
            />
          ) : null}
        </SettingsGroupCard>
      </section>

      {/* 文件树 HTML 打开方式只在桌面端有内置浏览器时有意义。 */}
      {isDesktop ? (
        <section className="space-y-3">
          <div className="text-ui-base font-medium text-foreground-subtle">
            {intl.formatMessage({ id: "settings.browser.open.section" })}
          </div>
          <SettingsGroupCard>
            <FileTreeHtmlOpenSetting />
          </SettingsGroupCard>
        </section>
      ) : null}

      {/* 证书策略只在桌面端有内置浏览器时可配；改动由 main 在启动时装到 Session，需重启生效。 */}
      {isDesktop ? (
        <section className="space-y-3">
          <div className="text-ui-base font-medium text-foreground-subtle">
            {intl.formatMessage({ id: "settings.browser.security.section" })}
          </div>
          <SettingsGroupCard>
            <SettingsRow
              searchId="settings.embeddedBrowserAllowInsecureCertificates"
              label={intl.formatMessage({
                id: "settings.embeddedBrowserAllowInsecureCertificates",
              })}
              description={intl.formatMessage({
                id: "settings.embeddedBrowserAllowInsecureCertificatesDescription",
              })}
              control={
                <Switch
                  aria-label={intl.formatMessage({
                    id: "settings.embeddedBrowserAllowInsecureCertificates",
                  })}
                  checked={embeddedBrowserAllowInsecureCertificates}
                  onCheckedChange={(checked) => {
                    void onEmbeddedBrowserAllowInsecureCertificatesChange(checked);
                  }}
                />
              }
            />
          </SettingsGroupCard>
        </section>
      ) : null}

      <section className="space-y-3">
        <div className="text-ui-base font-medium text-foreground-subtle">
          {intl.formatMessage({ id: "settings.browser.data.section" })}
        </div>
        {!nativeActionsAvailable ? (
          <div className="rounded-lg border border-border bg-surface px-4 py-3 text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "settings.browser.desktopOnly" })}
          </div>
        ) : null}
        <SettingsGroupCard>
          <SettingsRow
            searchId="settings.browser.clearCache.title"
            label={intl.formatMessage({
              id: "settings.browser.clearCache.title",
            })}
            description={intl.formatMessage({
              id: "settings.browser.clearCache.description",
            })}
            control={
              <BrowserOperationButton
                operation="clear-cache"
                pendingOperation={pendingOperation}
                disabled={operationDisabled}
                onClick={() => void handleClear("cache")}
              >
                {intl.formatMessage({
                  id: "settings.browser.clearCache.action",
                })}
              </BrowserOperationButton>
            }
          />
          <SettingsRow
            searchId="settings.browser.clearAll.title"
            label={intl.formatMessage({
              id: "settings.browser.clearAll.title",
            })}
            description={intl.formatMessage({
              id: "settings.browser.clearAll.description",
            })}
            control={
              <BrowserOperationButton
                operation="clear-all"
                pendingOperation={pendingOperation}
                disabled={operationDisabled}
                variant="destructive"
                onClick={() => setConfirmClearAll(true)}
              >
                {intl.formatMessage({ id: "settings.browser.clearAll.action" })}
              </BrowserOperationButton>
            }
          />
        </SettingsGroupCard>
      </section>

      <AlertDialog open={confirmClearAll} onOpenChange={setConfirmClearAll}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {intl.formatMessage({
                id: "settings.browser.clearAll.confirmTitle",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {intl.formatMessage({
                id: "settings.browser.clearAll.confirmDescription",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pendingOperation !== null}>
              {intl.formatMessage({ id: "common.cancel" })}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={pendingOperation !== null}
              onClick={(event) => {
                event.preventDefault();
                void handleClear("all");
              }}
            >
              {pendingOperation === "clear-all" ? (
                <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
              ) : null}
              {intl.formatMessage({
                id: "settings.browser.clearAll.confirmAction",
              })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
