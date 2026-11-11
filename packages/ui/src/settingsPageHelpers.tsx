/* oxlint-disable eslint(max-lines) -- settings helper 聚合应用常规、Agent 行为与自动归档设置。 */
import type {
  AppToolSearchMode,
  IntegratedTerminalShellOption,
  IntegratedTerminalShellSelection,
  LocalePreference,
  ZCodeInteractionBehavior,
} from "@zcode/shared";
import {
  appToolSearchModeSchema,
  DEFAULT_APP_TOOL_SEARCH_MODE,
  LOCALE_NATIVE_NAMES,
  SUPPORTED_LOCALES,
} from "@zcode/shared";
import {
  TID_SETTINGS_ASK_USER_QUESTION_AUTO_RESOLUTION_SWITCH,
  TID_SETTINGS_NATIVE_SEARCH_SWITCH,
  TID_SETTINGS_TOOL_SEARCH_SELECT,
  TID_SETTINGS_TOOL_SEARCH_OPTION,
} from "@zcode/shared/test-ids";
import { useState, useCallback, useEffect } from "react";
import type { IPlatformService } from "@zcode/shared";
import {
  TID_SETTINGS_LOCALE_SELECT_ITEM,
  TID_SETTINGS_LOCALE_SELECT_TRIGGER,
  testId,
} from "@zcode/shared/test-ids";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Switch } from "@/components/ui/switch.js";
import { Input } from "@/components/ui/input.js";
import { Button } from "@/components/ui/button.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { DataBaseDirControl } from "@/settings/DataBaseDirControl.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { ProactiveSuggestionsSetting } from "@/settings/ProactiveSuggestionsSetting.js";
import { PluginAutoRecommendationSetting } from "@/settings/PluginAutoRecommendationSetting.js";
import { DynamicWorkflowModeSetting } from "@/settings/DynamicWorkflowModeSetting.js";
import { normalizeInterfaceMode, type InterfaceMode } from "@/lib/interfaceMode.js";
import {
  createSettingsPageConfig,
  resolveSettingsSectionForPlatform,
  SETTINGS_SECTION_GROUPS,
  SETTINGS_SECTIONS,
  isSettingsSectionAvailable,
  type SettingsSectionId,
} from "@/settings/settingsPageConfig.js";

export type { Locale, LocalePreference } from "@zcode/shared";
export { type SettingsSectionId };
export { createSettingsPageConfig, resolveSettingsSectionForPlatform };
export { SETTINGS_SECTION_GROUPS, SETTINGS_SECTIONS };
export { isSettingsSectionAvailable };

const TASK_AUTO_ARCHIVE_DAY_OPTIONS = [3, 7, 14, 30] as const;
const ZCODE_INTERACTION_BEHAVIOR_OPTIONS: readonly ZCodeInteractionBehavior[] = ["queue", "guide"];

/**
 * 归档偏好与归档列表集中展示，设置值和保存动作继续由 SettingsPage 持有。
 * Bugfix：关闭时禁用时长会迫使用户先开启归档，旧阈值可能立即生效；允许先保存时长再开启。
 */
export function TaskAutoArchiveSettings({
  taskAutoArchiveEnabled,
  taskAutoArchiveOlderThanDays,
  onTaskAutoArchiveEnabledChange,
  onTaskAutoArchiveOlderThanDaysChange,
}: {
  taskAutoArchiveEnabled: boolean;
  taskAutoArchiveOlderThanDays: number;
  onTaskAutoArchiveEnabledChange: (enabled: boolean) => Promise<void>;
  onTaskAutoArchiveOlderThanDaysChange: (days: number) => Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  return (
    <SettingsGroupCard>
      <SettingsRow
        searchId="settings.taskAutoArchive"
        controlLayout="wide"
        label={intl.formatMessage({ id: "settings.taskAutoArchive" })}
        description={intl.formatMessage({
          id: "settings.taskAutoArchiveDescription",
        })}
        control={
          <Switch
            data-testid="archive-auto-archive-switch"
            aria-label={intl.formatMessage({ id: "settings.taskAutoArchive" })}
            checked={taskAutoArchiveEnabled}
            onCheckedChange={(checked) => {
              void onTaskAutoArchiveEnabledChange(checked);
            }}
          />
        }
      />
      <SettingsRow
        searchId="settings.taskAutoArchiveDays"
        controlLayout="wide"
        label={intl.formatMessage({ id: "settings.taskAutoArchiveDays" })}
        description={intl.formatMessage({
          id: "settings.taskAutoArchiveDaysDescription",
        })}
        control={
          <Select
            value={String(taskAutoArchiveOlderThanDays)}
            onValueChange={(value) => {
              void onTaskAutoArchiveOlderThanDaysChange(Number(value));
            }}
          >
            <SelectTrigger
              data-testid="archive-auto-archive-days"
              aria-label={intl.formatMessage({ id: "settings.taskAutoArchiveDays" })}
              size="lg"
              className="w-full min-w-0 justify-between"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TASK_AUTO_ARCHIVE_DAY_OPTIONS.map((days) => (
                <SelectItem key={days} value={String(days)}>
                  {intl.formatMessage({
                    id: `settings.taskAutoArchiveDays.option.${days}`,
                  })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
    </SettingsGroupCard>
  );
}

export function GeneralSectionContent({
  localePreference,
  interfaceMode = "coding",
  setInterfaceMode = () => {},
  notificationEnabled,
  notificationSoundEnabled,
  closeToTrayOnWindows,
  keepAwakeWhileRunning = false,
  mobilePushEnabled = true,
  onMobilePushEnabledChange = async () => {},
  desktopChromiumHardwareAccelerationEnabled = true,
  receivePreviewUpdates,
  autoDownloadAndInstallUpdates,
  dataBaseDir,
  terminalInheritSystemProfile = true,
  terminalFontFamily = "",
  integratedTerminalShell = { mode: "auto" },
  integratedTerminalShellOptions = [],
  httpProxy = "",
  httpProxyNoProxy = "",
  httpProxyCaCertPath = "",
  defaultHomeDir,
  isDesktop,
  isWindowsDesktop,
  isLinuxDesktop,
  linuxCloseToTray,
  showIntegratedTerminalShell = false,
  setLocalePreference,
  setNotificationEnabled,
  setNotificationSoundEnabled,
  onDataBaseDirChange,
  onSelectDataBaseDir,
  onTerminalInheritSystemProfileChange = async () => {},
  onTerminalFontFamilyChange = async () => {},
  onIntegratedTerminalShellChange = async () => {},
  onHttpProxyChange = async () => {},
  onHttpProxyNoProxyChange = async () => {},
  onHttpProxyCaCertPathChange = async () => {},
  onCloseToTrayOnWindowsChange,
  onKeepAwakeWhileRunningChange = async () => {},
  onDesktopChromiumHardwareAccelerationChange = async () => {},
  onReceivePreviewUpdatesChange,
  onAutoDownloadAndInstallUpdatesChange,
  onOpenOnboardingDialog,
}: {
  localePreference: LocalePreference;
  interfaceMode?: InterfaceMode;
  setInterfaceMode?: (mode: InterfaceMode) => void;
  notificationEnabled: boolean;
  notificationSoundEnabled: boolean;
  closeToTrayOnWindows: boolean;
  keepAwakeWhileRunning?: boolean;
  /** 本机 offline push 上报开关（spec：docs/web-remote-control/mobile-event-push.md 6.4），仅桌面端展示 */
  mobilePushEnabled?: boolean;
  onMobilePushEnabledChange?: (enabled: boolean) => Promise<void>;
  desktopChromiumHardwareAccelerationEnabled?: boolean;
  receivePreviewUpdates: boolean;
  autoDownloadAndInstallUpdates: boolean;
  dataBaseDir: string;
  terminalInheritSystemProfile: boolean;
  terminalFontFamily: string;
  integratedTerminalShell?: IntegratedTerminalShellSelection;
  integratedTerminalShellOptions?: IntegratedTerminalShellOption[];
  httpProxy?: string;
  httpProxyNoProxy?: string;
  httpProxyCaCertPath?: string;
  defaultHomeDir: string;
  isDesktop?: boolean;
  isWindowsDesktop?: boolean;
  /** Linux 桌面端（isDesktop 且非 win/mac）；关闭驻留托盘设置在 Linux 上按能力自适应展示 */
  isLinuxDesktop?: boolean;
  /** Linux 关闭驻留托盘能力状态（spec：docs/desktop/linux-close-to-tray.md）；Windows 不传 */
  linuxCloseToTray?: {
    /** 能力探测中或确认不可用，开关锁定 */
    disabled: boolean;
    /** 确认不可用（描述文案切换为"未提供系统托盘"） */
    unavailable: boolean;
    /** GNOME 系桌面且无托盘（追加 AppIndicator 扩展安装提示） */
    gnomeLikeHint: boolean;
  };
  showIntegratedTerminalShell?: boolean;
  platform?: IPlatformService;
  setLocalePreference: (locale: LocalePreference) => void;
  setNotificationEnabled: (enabled: boolean) => void;
  setNotificationSoundEnabled: (enabled: boolean) => void;
  onDataBaseDirChange: (dir: string) => Promise<void>;
  onSelectDataBaseDir: () => Promise<string | null>;
  onTerminalInheritSystemProfileChange: (enabled: boolean) => Promise<void>;
  onTerminalFontFamilyChange: (fontFamily: string) => Promise<void>;
  onIntegratedTerminalShellChange?: (selection: IntegratedTerminalShellSelection) => Promise<void>;
  onHttpProxyChange?: (httpProxy: string) => Promise<void>;
  onHttpProxyNoProxyChange?: (noProxy: string) => Promise<void>;
  onHttpProxyCaCertPathChange?: (caCertPath: string) => Promise<void>;
  onCloseToTrayOnWindowsChange: (enabled: boolean) => Promise<void>;
  onKeepAwakeWhileRunningChange?: (enabled: boolean) => Promise<void>;
  onDesktopChromiumHardwareAccelerationChange?: (enabled: boolean) => Promise<void>;
  onReceivePreviewUpdatesChange: (enabled: boolean) => Promise<void>;
  onAutoDownloadAndInstallUpdatesChange: (enabled: boolean) => Promise<void>;
  onOpenOnboardingDialog: () => void;
}) {
  const { intl } = useZCodeIntl();
  const hasServices = Boolean(useOptionalServices());
  // 部分 SSR 单测会用精简 props 直接渲染本组件，新增终端设置项后旧 helper 未必同步传值。
  // 这里把运行时缺省值兜到“继承系统 profile”，避免 undefined.trim() 把无关测试打断。
  const [localTerminalFontFamily, setLocalTerminalFontFamily] = useState(terminalFontFamily);

  useEffect(() => {
    setLocalTerminalFontFamily(terminalFontFamily);
  }, [terminalFontFamily]);

  const normalizedTerminalFontFamily = localTerminalFontFamily.trim();
  const isTerminalFontFamilyDirty = normalizedTerminalFontFamily !== terminalFontFamily;
  const integratedTerminalShellValue =
    integratedTerminalShell.mode === "shell" ? integratedTerminalShell.id : "auto";
  const selectedIntegratedTerminalShellOption =
    integratedTerminalShell.mode === "shell"
      ? (integratedTerminalShellOptions.find(
          (option) => option.id === integratedTerminalShell.id,
        ) ?? {
          dialect: integratedTerminalShell.dialect,
          id: integratedTerminalShell.id,
          label: integratedTerminalShell.label,
          path: integratedTerminalShell.path,
          source: "system" as const,
        })
      : undefined;
  const visibleIntegratedTerminalShellOptions = selectedIntegratedTerminalShellOption
    ? [
        selectedIntegratedTerminalShellOption,
        ...integratedTerminalShellOptions.filter(
          (option) => option.id !== selectedIntegratedTerminalShellOption.id,
        ),
      ]
    : integratedTerminalShellOptions;

  const handleTerminalFontFamilySave = useCallback(async () => {
    await onTerminalFontFamilyChange(normalizedTerminalFontFamily);
  }, [normalizedTerminalFontFamily, onTerminalFontFamilyChange]);

  const handleIntegratedTerminalShellChange = useCallback(
    async (value: string) => {
      if (value === "auto") {
        await onIntegratedTerminalShellChange({ mode: "auto" });
        return;
      }
      const option = visibleIntegratedTerminalShellOptions.find(
        (candidate) => candidate.id === value,
      );
      if (!option) {
        return;
      }
      await onIntegratedTerminalShellChange({
        mode: "shell",
        dialect: option.dialect,
        id: option.id,
        label: option.label,
        path: option.path,
      });
    },
    [onIntegratedTerminalShellChange, visibleIntegratedTerminalShellOptions],
  );

  const [localHttpProxy, setLocalHttpProxy] = useState(httpProxy);

  useEffect(() => {
    setLocalHttpProxy(httpProxy);
  }, [httpProxy]);

  const normalizedHttpProxy = localHttpProxy.trim();
  const isHttpProxyDirty = normalizedHttpProxy !== httpProxy;

  const handleHttpProxySave = useCallback(async () => {
    await onHttpProxyChange(normalizedHttpProxy);
  }, [normalizedHttpProxy, onHttpProxyChange]);

  const [localHttpProxyNoProxy, setLocalHttpProxyNoProxy] = useState(httpProxyNoProxy);

  useEffect(() => {
    setLocalHttpProxyNoProxy(httpProxyNoProxy);
  }, [httpProxyNoProxy]);

  const normalizedHttpProxyNoProxy = localHttpProxyNoProxy
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean)
    .join(",");
  const isHttpProxyNoProxyDirty = normalizedHttpProxyNoProxy !== httpProxyNoProxy;

  const handleHttpProxyNoProxySave = useCallback(async () => {
    await onHttpProxyNoProxyChange(normalizedHttpProxyNoProxy);
  }, [normalizedHttpProxyNoProxy, onHttpProxyNoProxyChange]);

  const [localHttpProxyCaCertPath, setLocalHttpProxyCaCertPath] = useState(httpProxyCaCertPath);

  useEffect(() => {
    setLocalHttpProxyCaCertPath(httpProxyCaCertPath);
  }, [httpProxyCaCertPath]);

  const normalizedHttpProxyCaCertPath = localHttpProxyCaCertPath.trim();
  const isHttpProxyCaCertPathDirty = normalizedHttpProxyCaCertPath !== httpProxyCaCertPath;

  const handleHttpProxyCaCertPathSave = useCallback(async () => {
    await onHttpProxyCaCertPathChange(normalizedHttpProxyCaCertPath);
  }, [normalizedHttpProxyCaCertPath, onHttpProxyCaCertPathChange]);

  return (
    <div className="space-y-4">
      <SettingsGroupCard>
        <SettingsRow
          searchId="settings.locale"
          label={intl.formatMessage({ id: "settings.locale" })}
          description={intl.formatMessage({ id: "settings.localeDescription" })}
          control={
            <Select
              value={localePreference}
              onValueChange={(value) => setLocalePreference(value as LocalePreference)}
            >
              <SelectTrigger
                size="lg"
                className="w-[260px] min-w-0 justify-between"
                data-testid={TID_SETTINGS_LOCALE_SELECT_TRIGGER}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem
                  value="system"
                  data-testid={testId(TID_SETTINGS_LOCALE_SELECT_ITEM, "system")}
                >
                  {intl.formatMessage({ id: "settings.locale.system" })}
                </SelectItem>
                {/* 语言选项显示各语言本名（LOCALE_NATIVE_NAMES），不随界面语言翻译。 */}
                {SUPPORTED_LOCALES.map((locale) => (
                  <SelectItem
                    key={locale}
                    value={locale}
                    lang={locale}
                    data-testid={testId(TID_SETTINGS_LOCALE_SELECT_ITEM, locale)}
                  >
                    {LOCALE_NATIVE_NAMES[locale]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
      </SettingsGroupCard>

      <SettingsGroupCard>
        <SettingsRow
          searchId="settings.interfaceMode"
          controlLayout="wide"
          label={intl.formatMessage({ id: "settings.interfaceMode" })}
          description={intl.formatMessage({ id: "settings.interfaceMode.description" })}
          control={
            <Select
              value={interfaceMode}
              onValueChange={(value) => setInterfaceMode(normalizeInterfaceMode(value))}
            >
              <SelectTrigger
                size="lg"
                className="w-full min-w-0 sm:w-64"
                aria-label={intl.formatMessage({ id: "settings.interfaceMode" })}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="coding">
                  {intl.formatMessage({ id: "settings.interfaceMode.coding" })}
                </SelectItem>
                <SelectItem value="office">
                  {intl.formatMessage({ id: "settings.interfaceMode.office" })}
                </SelectItem>
              </SelectContent>
            </Select>
          }
        />
        {hasServices ? <ProactiveSuggestionsSetting /> : null}
      </SettingsGroupCard>

      <SettingsGroupCard>
        <SettingsRow
          searchId="settings.terminalProfile"
          label={intl.formatMessage({ id: "settings.terminalProfile" })}
          description={intl.formatMessage({ id: "settings.terminalProfileDescription" })}
          control={
            <Switch
              checked={terminalInheritSystemProfile}
              onCheckedChange={(checked) => {
                void onTerminalInheritSystemProfileChange(checked);
              }}
            />
          }
        />
        <SettingsRow
          searchId="settings.terminalFontFamily"
          label={intl.formatMessage({ id: "settings.terminalFontFamily" })}
          description={intl.formatMessage({ id: "settings.terminalFontFamilyDescription" })}
          control={
            <Button
              type="button"
              size="lg"
              disabled={!isTerminalFontFamilyDirty}
              onClick={() => void handleTerminalFontFamilySave()}
            >
              {intl.formatMessage({ id: "settings.dataBaseDirSave" })}
            </Button>
          }
          detail={
            <Input
              size="lg"
              value={localTerminalFontFamily}
              placeholder={intl.formatMessage({
                id: "settings.terminalFontFamilyPlaceholder",
              })}
              onChange={(event) => {
                setLocalTerminalFontFamily(event.currentTarget.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && isTerminalFontFamilyDirty) {
                  void handleTerminalFontFamilySave();
                }
              }}
              className="max-w-[520px] font-mono"
            />
          }
        />
        {showIntegratedTerminalShell ? (
          <SettingsRow
            searchId="settings.integratedTerminalShell"
            label={intl.formatMessage({ id: "settings.integratedTerminalShell" })}
            description={intl.formatMessage({
              id: "settings.integratedTerminalShellDescription",
            })}
            control={
              <Select
                value={integratedTerminalShellValue}
                onValueChange={(value) => {
                  void handleIntegratedTerminalShellChange(value);
                }}
              >
                <SelectTrigger size="lg" className="w-[260px] min-w-0 justify-between">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">
                    {intl.formatMessage({ id: "settings.integratedTerminalShell.auto" })}
                  </SelectItem>
                  {visibleIntegratedTerminalShellOptions.map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          />
        ) : null}
      </SettingsGroupCard>

      <SettingsGroupCard>
        <SettingsRow
          searchId="settings.httpProxy"
          label={intl.formatMessage({ id: "settings.httpProxy" })}
          description={intl.formatMessage({ id: "settings.httpProxyDescription" })}
          control={
            <Button
              type="button"
              size="lg"
              disabled={!isHttpProxyDirty}
              onClick={() => void handleHttpProxySave()}
            >
              {intl.formatMessage({ id: "settings.dataBaseDirSave" })}
            </Button>
          }
          detail={
            <Input
              size="lg"
              value={localHttpProxy}
              placeholder={intl.formatMessage({
                id: "settings.httpProxyPlaceholder",
              })}
              onChange={(event) => {
                setLocalHttpProxy(event.currentTarget.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && isHttpProxyDirty) {
                  void handleHttpProxySave();
                }
              }}
              className="max-w-[520px] font-mono"
            />
          }
        />
        {/* No Proxy 与 HTTP 代理共同决定同一出口策略，必须贴在代理地址下面。*/}
        <SettingsRow
          searchId="settings.httpProxyNoProxy"
          label={intl.formatMessage({ id: "settings.httpProxyNoProxy" })}
          description={intl.formatMessage({
            id: "settings.httpProxyNoProxyDescription",
          })}
          control={
            <Button
              type="button"
              size="lg"
              disabled={!isHttpProxyNoProxyDirty}
              onClick={() => void handleHttpProxyNoProxySave()}
            >
              {intl.formatMessage({ id: "settings.dataBaseDirSave" })}
            </Button>
          }
          detail={
            <Input
              size="lg"
              value={localHttpProxyNoProxy}
              placeholder={intl.formatMessage({
                id: "settings.httpProxyNoProxyPlaceholder",
              })}
              onChange={(event) => {
                setLocalHttpProxyNoProxy(event.currentTarget.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && isHttpProxyNoProxyDirty) {
                  void handleHttpProxyNoProxySave();
                }
              }}
              className="max-w-[520px] font-mono"
            />
          }
        />
        {/* 自定义 CA 属于 HTTP 代理的同一网络出口策略，必须跟代理输入放在同一卡片里。*/}
        <SettingsRow
          searchId="settings.httpProxyCaCertPath"
          label={intl.formatMessage({ id: "settings.httpProxyCaCertPath" })}
          description={intl.formatMessage({
            id: "settings.httpProxyCaCertPathDescription",
          })}
          control={
            <Button
              type="button"
              size="lg"
              disabled={!isHttpProxyCaCertPathDirty}
              onClick={() => void handleHttpProxyCaCertPathSave()}
            >
              {intl.formatMessage({ id: "settings.dataBaseDirSave" })}
            </Button>
          }
          detail={
            <Input
              size="lg"
              value={localHttpProxyCaCertPath}
              placeholder={intl.formatMessage({
                id: "settings.httpProxyCaCertPathPlaceholder",
              })}
              onChange={(event) => {
                setLocalHttpProxyCaCertPath(event.currentTarget.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && isHttpProxyCaCertPathDirty) {
                  void handleHttpProxyCaCertPathSave();
                }
              }}
              className="max-w-[520px] font-mono"
            />
          }
        />
      </SettingsGroupCard>

      <SettingsGroupCard>
        {isDesktop ? (
          <>
            <SettingsRow
              searchId="settings.desktopChromiumHardwareAcceleration"
              label={intl.formatMessage({
                id: "settings.desktopChromiumHardwareAcceleration",
              })}
              description={intl.formatMessage({
                id: "settings.desktopChromiumHardwareAccelerationDescription",
              })}
              control={
                <Switch
                  aria-label={intl.formatMessage({
                    id: "settings.desktopChromiumHardwareAcceleration",
                  })}
                  checked={desktopChromiumHardwareAccelerationEnabled}
                  onCheckedChange={(checked) => {
                    void onDesktopChromiumHardwareAccelerationChange(checked);
                  }}
                />
              }
            />
            <SettingsRow
              searchId="settings.receivePreviewUpdates"
              label={intl.formatMessage({ id: "settings.receivePreviewUpdates" })}
              description={intl.formatMessage({
                id: "settings.receivePreviewUpdatesDescription",
              })}
              control={
                <Switch
                  aria-label={intl.formatMessage({ id: "settings.receivePreviewUpdates" })}
                  checked={receivePreviewUpdates}
                  onCheckedChange={(checked) => {
                    void onReceivePreviewUpdatesChange(checked);
                  }}
                />
              }
            />
            <SettingsRow
              searchId="settings.autoDownloadAndInstallUpdates"
              label={intl.formatMessage({
                id: "settings.autoDownloadAndInstallUpdates",
              })}
              description={intl.formatMessage({
                id: "settings.autoDownloadAndInstallUpdatesDescription",
              })}
              control={
                <Switch
                  aria-label={intl.formatMessage({
                    id: "settings.autoDownloadAndInstallUpdates",
                  })}
                  checked={autoDownloadAndInstallUpdates}
                  onCheckedChange={(checked) => {
                    void onAutoDownloadAndInstallUpdatesChange(checked);
                  }}
                />
              }
            />
          </>
        ) : null}
        <SettingsRow
          searchId="settings.notification"
          label={intl.formatMessage({ id: "settings.notification" })}
          description={intl.formatMessage({
            id: "settings.notificationDescription",
          })}
          control={
            <Switch checked={notificationEnabled} onCheckedChange={setNotificationEnabled} />
          }
        />
        <SettingsRow
          searchId="settings.notificationSound"
          label={intl.formatMessage({ id: "settings.notificationSound" })}
          description={intl.formatMessage({
            id: "settings.notificationSoundDescription",
          })}
          control={
            <Switch
              checked={notificationSoundEnabled}
              disabled={!notificationEnabled}
              onCheckedChange={setNotificationSoundEnabled}
            />
          }
        />
        {isDesktop ? (
          <SettingsRow
            searchId="settings.mobilePush"
            label={intl.formatMessage({ id: "settings.mobilePush" })}
            description={intl.formatMessage({ id: "settings.mobilePushDescription" })}
            control={
              <Switch
                aria-label={intl.formatMessage({ id: "settings.mobilePush" })}
                data-testid="settings-mobile-push-switch"
                checked={mobilePushEnabled}
                onCheckedChange={(checked) => {
                  void onMobilePushEnabledChange(checked);
                }}
              />
            }
          />
        ) : null}
        {isWindowsDesktop || isLinuxDesktop ? (
          <SettingsRow
            searchId="settings.closeToTrayOnWindows"
            label={intl.formatMessage({ id: "settings.closeToTrayOnWindows" })}
            description={
              linuxCloseToTray?.unavailable
                ? linuxCloseToTray.gnomeLikeHint
                  ? `${intl.formatMessage({ id: "settings.closeToTrayUnavailable" })} ${intl.formatMessage({ id: "settings.closeToTrayGnomeHint" })}`
                  : intl.formatMessage({ id: "settings.closeToTrayUnavailable" })
                : intl.formatMessage({
                    id: "settings.closeToTrayOnWindowsDescription",
                  })
            }
            control={
              <Switch
                checked={closeToTrayOnWindows}
                // Linux 上托盘能力未知（探测中）或确认不可用时都锁定，防止误开导致关窗失联
                //（spec：docs/desktop/linux-close-to-tray.md）。
                disabled={Boolean(linuxCloseToTray?.disabled)}
                onCheckedChange={(checked) => {
                  void onCloseToTrayOnWindowsChange(checked);
                }}
              />
            }
          />
        ) : null}
        {isDesktop ? (
          <SettingsRow
            searchId="settings.keepAwakeWhileRunning"
            label={intl.formatMessage({ id: "settings.keepAwakeWhileRunning" })}
            description={intl.formatMessage({
              id: "settings.keepAwakeWhileRunningDescription",
            })}
            control={
              <Switch
                aria-label={intl.formatMessage({
                  id: "settings.keepAwakeWhileRunning",
                })}
                checked={keepAwakeWhileRunning}
                onCheckedChange={(checked) => {
                  void onKeepAwakeWhileRunningChange(checked);
                }}
              />
            }
          />
        ) : null}
      </SettingsGroupCard>

      <SettingsGroupCard>
        <SettingsRow
          searchId="settings.dataBaseDir"
          label={intl.formatMessage({ id: "settings.dataBaseDir" })}
          description={intl.formatMessage({
            id: "settings.dataBaseDirDescription",
          })}
          control={
            <DataBaseDirControl
              dataBaseDir={dataBaseDir}
              defaultHomeDir={defaultHomeDir}
              onDataBaseDirChange={onDataBaseDirChange}
              onSelectDataBaseDir={onSelectDataBaseDir}
            />
          }
        />
      </SettingsGroupCard>

      <SettingsGroupCard>
        <SettingsRow
          searchId="settings.onboarding"
          label={intl.formatMessage({ id: "settings.onboarding" })}
          description={intl.formatMessage({
            id: "settings.onboardingDescription",
          })}
          control={
            <Button type="button" size="lg" variant="outline" onClick={onOpenOnboardingDialog}>
              {intl.formatMessage({ id: "settings.onboardingOpen" })}
            </Button>
          }
        />
      </SettingsGroupCard>
    </div>
  );
}

export function AgentBehaviorSectionContent({
  toolSearchMode = DEFAULT_APP_TOOL_SEARCH_MODE,
  onToolSearchModeChange,
  nativeSearchEnhancementsEnabled,
  messageStreamShowReasoning,
  messageStreamShowTodos,
  zcodeInteractionBehavior,
  askUserQuestionAutoResolutionEnabled = true,
  modelIoFullRetentionEnabled = false,
  onNativeSearchEnhancementsEnabledChange,
  onMessageStreamShowReasoningChange,
  onMessageStreamShowTodosChange,
  onZCodeInteractionBehaviorChange,
  onAskUserQuestionAutoResolutionEnabledChange = async () => {},
  onModelIoFullRetentionEnabledChange = async () => {},
}: {
  toolSearchMode?: AppToolSearchMode;
  onToolSearchModeChange: (mode: AppToolSearchMode) => Promise<void>;
  nativeSearchEnhancementsEnabled: boolean;
  messageStreamShowReasoning: boolean;
  messageStreamShowTodos: boolean;
  zcodeInteractionBehavior: ZCodeInteractionBehavior;
  askUserQuestionAutoResolutionEnabled?: boolean;
  modelIoFullRetentionEnabled?: boolean;
  onNativeSearchEnhancementsEnabledChange: (enabled: boolean) => Promise<void>;
  onMessageStreamShowReasoningChange: (enabled: boolean) => Promise<void>;
  onMessageStreamShowTodosChange: (enabled: boolean) => Promise<void>;
  onZCodeInteractionBehaviorChange: (behavior: ZCodeInteractionBehavior) => Promise<void>;
  onAskUserQuestionAutoResolutionEnabledChange?: (enabled: boolean) => Promise<void>;
  onModelIoFullRetentionEnabledChange?: (enabled: boolean) => Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const hasServices = Boolean(useOptionalServices());

  return (
    <div className="space-y-4">
      <SettingsGroupCard>
        <SettingsRow
          searchId="settings.toolSearch"
          label={intl.formatMessage({ id: "settings.toolSearch" })}
          description={intl.formatMessage({ id: "settings.toolSearchDescription" })}
          detail={
            <p className="text-ui-sm leading-5 text-foreground-subtle">
              {intl.formatMessage({ id: "settings.toolSearchExperimentalNotice" })}
            </p>
          }
          control={
            <Select
              value={toolSearchMode}
              onValueChange={(value) => {
                void onToolSearchModeChange(appToolSearchModeSchema.parse(value));
              }}
            >
              <SelectTrigger
                size="lg"
                className="w-[260px] min-w-0 justify-between"
                data-testid={TID_SETTINGS_TOOL_SEARCH_SELECT}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {appToolSearchModeSchema.options.map((mode) => (
                  <SelectItem
                    key={mode}
                    value={mode}
                    data-testid={testId(TID_SETTINGS_TOOL_SEARCH_OPTION, mode)}
                  >
                    {intl.formatMessage({ id: `settings.toolSearch.${mode}` })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
        <SettingsRow
          searchId="settings.nativeSearchEnhancements"
          label={intl.formatMessage({
            id: "settings.nativeSearchEnhancements",
          })}
          description={intl.formatMessage({
            id: "settings.nativeSearchEnhancementsDescription",
          })}
          control={
            <Switch
              aria-label={intl.formatMessage({
                id: "settings.nativeSearchEnhancements",
              })}
              checked={nativeSearchEnhancementsEnabled}
              data-testid={TID_SETTINGS_NATIVE_SEARCH_SWITCH}
              onCheckedChange={(checked) => {
                void onNativeSearchEnhancementsEnabledChange(checked);
              }}
            />
          }
        />
      </SettingsGroupCard>

      <SettingsGroupCard>
        <SettingsRow
          searchId="settings.zcodeInteractionBehavior"
          label={intl.formatMessage({ id: "settings.zcodeInteractionBehavior" })}
          description={intl.formatMessage({
            id: "settings.zcodeInteractionBehaviorDescription",
          })}
          control={
            <Select
              value={zcodeInteractionBehavior}
              onValueChange={(value) => {
                void onZCodeInteractionBehaviorChange(value as ZCodeInteractionBehavior);
              }}
            >
              <SelectTrigger size="lg" className="w-[260px] min-w-0 justify-between">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ZCODE_INTERACTION_BEHAVIOR_OPTIONS.map((behavior) => (
                  <SelectItem key={behavior} value={behavior}>
                    {intl.formatMessage({
                      id: `settings.zcodeInteractionBehavior.option.${behavior}`,
                    })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
        <SettingsRow
          searchId="settings.askUserQuestionAutoResolution"
          label={intl.formatMessage({
            id: "settings.askUserQuestionAutoResolution",
          })}
          description={intl.formatMessage({
            id: "settings.askUserQuestionAutoResolutionDescription",
          })}
          control={
            <Switch
              aria-label={intl.formatMessage({
                id: "settings.askUserQuestionAutoResolution",
              })}
              checked={askUserQuestionAutoResolutionEnabled}
              data-testid={TID_SETTINGS_ASK_USER_QUESTION_AUTO_RESOLUTION_SWITCH}
              onCheckedChange={(checked) => {
                void onAskUserQuestionAutoResolutionEnabledChange(checked);
              }}
            />
          }
        />
        {/* docs/dynamic-workflow/launch.md「The user's choice」：服务端未提供时整行不渲染。 */}
        {hasServices ? <PluginAutoRecommendationSetting /> : null}
        {hasServices ? <DynamicWorkflowModeSetting /> : null}
        <SettingsRow
          searchId="settings.modelIoFullRetention"
          label={intl.formatMessage({ id: "settings.modelIoFullRetention" })}
          description={intl.formatMessage({
            id: "settings.modelIoFullRetentionDescription",
          })}
          control={
            <Switch
              aria-label={intl.formatMessage({ id: "settings.modelIoFullRetention" })}
              checked={modelIoFullRetentionEnabled}
              onCheckedChange={(checked) => {
                void onModelIoFullRetentionEnabledChange(checked);
              }}
            />
          }
        />
        <SettingsRow
          searchId="settings.messageStreamShowReasoning"
          label={intl.formatMessage({ id: "settings.messageStreamShowReasoning" })}
          description={intl.formatMessage({
            id: "settings.messageStreamShowReasoningDescription",
          })}
          control={
            <Switch
              aria-label={intl.formatMessage({ id: "settings.messageStreamShowReasoning" })}
              checked={messageStreamShowReasoning}
              onCheckedChange={(checked) => {
                void onMessageStreamShowReasoningChange(checked);
              }}
            />
          }
        />
        <SettingsRow
          searchId="settings.messageStreamShowTodos"
          label={intl.formatMessage({ id: "settings.messageStreamShowTodos" })}
          description={intl.formatMessage({
            id: "settings.messageStreamShowTodosDescription",
          })}
          control={
            <Switch
              aria-label={intl.formatMessage({ id: "settings.messageStreamShowTodos" })}
              checked={messageStreamShowTodos}
              onCheckedChange={(checked) => {
                void onMessageStreamShowTodosChange(checked);
              }}
            />
          }
        />
      </SettingsGroupCard>
    </div>
  );
}
