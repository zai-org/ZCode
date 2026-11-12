import type { SettingsSectionId } from "@/lib/settingsNavigation.js";

export interface SettingsSearchAvailability {
  desktop: boolean;
  macDesktop: boolean;
  windowsHost: boolean;
  tray: boolean;
  notWindows: boolean;
  workflow: boolean;
  computerUse: boolean;
}

// 翻译 key 同时作为稳定定位 id；索引只描述入口，不持有任何配置值。
export const SETTINGS_SEARCH_ITEMS = [
  {
    id: "settings.taskAutoArchive",
    section: "archives",
    description: "settings.taskAutoArchiveDescription",
    visibility: "all",
  },
  {
    id: "settings.taskAutoArchiveDays",
    section: "archives",
    description: "settings.taskAutoArchiveDaysDescription",
    visibility: "all",
  },
  {
    id: "settings.locale",
    section: "general",
    description: "settings.localeDescription",
    visibility: "all",
  },
  {
    id: "settings.interfaceMode",
    section: "general",
    description: "settings.interfaceMode.description",
    visibility: "all",
  },
  {
    id: "settings.terminalProfile",
    section: "general",
    description: "settings.terminalProfileDescription",
    visibility: "all",
  },
  {
    id: "settings.terminalFontFamily",
    section: "general",
    description: "settings.terminalFontFamilyDescription",
    visibility: "all",
  },
  {
    id: "settings.integratedTerminalShell",
    section: "general",
    description: "settings.integratedTerminalShellDescription",
    visibility: "windowsHost",
  },
  {
    id: "settings.httpProxy",
    section: "general",
    description: "settings.httpProxyDescription",
    visibility: "all",
  },
  {
    id: "settings.httpProxyNoProxy",
    section: "general",
    description: "settings.httpProxyNoProxyDescription",
    visibility: "all",
  },
  {
    id: "settings.httpProxyCaCertPath",
    section: "general",
    description: "settings.httpProxyCaCertPathDescription",
    visibility: "all",
  },
  {
    id: "settings.desktopChromiumHardwareAcceleration",
    section: "general",
    description: "settings.desktopChromiumHardwareAccelerationDescription",
    visibility: "desktop",
  },
  {
    id: "settings.receivePreviewUpdates",
    section: "general",
    description: "settings.receivePreviewUpdatesDescription",
    visibility: "desktop",
  },
  {
    id: "settings.autoDownloadAndInstallUpdates",
    section: "general",
    description: "settings.autoDownloadAndInstallUpdatesDescription",
    visibility: "desktop",
  },
  {
    id: "settings.notification",
    section: "general",
    description: "settings.notificationDescription",
    visibility: "all",
  },
  {
    id: "settings.notificationSound",
    section: "general",
    description: "settings.notificationSoundDescription",
    visibility: "all",
  },
  {
    id: "settings.mobilePush",
    section: "general",
    description: "settings.mobilePushDescription",
    visibility: "desktop",
  },
  {
    id: "settings.closeToTrayOnWindows",
    section: "general",
    description: "settings.closeToTrayUnavailable",
    visibility: "tray",
  },
  {
    id: "settings.keepAwakeWhileRunning",
    section: "general",
    description: "settings.keepAwakeWhileRunningDescription",
    visibility: "desktop",
  },
  {
    id: "settings.dataBaseDir",
    section: "general",
    description: "settings.dataBaseDirDescription",
    visibility: "all",
  },
  {
    id: "settings.onboarding",
    section: "general",
    description: "settings.onboardingDescription",
    visibility: "all",
  },
  {
    id: "settings.toolSearch",
    section: "agentBehavior",
    description: "settings.toolSearchDescription",
    visibility: "all",
  },
  {
    id: "settings.nativeSearchEnhancements",
    section: "agentBehavior",
    description: "settings.nativeSearchEnhancementsDescription",
    visibility: "all",
  },
  {
    id: "settings.zcodeInteractionBehavior",
    section: "agentBehavior",
    description: "settings.zcodeInteractionBehaviorDescription",
    visibility: "all",
  },
  {
    id: "settings.askUserQuestionAutoResolution",
    section: "agentBehavior",
    description: "settings.askUserQuestionAutoResolutionDescription",
    visibility: "all",
  },
  {
    id: "settings.modelIoFullRetention",
    section: "agentBehavior",
    description: "settings.modelIoFullRetentionDescription",
    visibility: "all",
  },
  {
    id: "settings.messageStreamShowReasoning",
    section: "agentBehavior",
    description: "settings.messageStreamShowReasoningDescription",
    visibility: "all",
  },
  {
    id: "settings.messageStreamShowTodos",
    section: "agentBehavior",
    description: "settings.messageStreamShowTodosDescription",
    visibility: "all",
  },
  {
    id: "settings.themeMode",
    section: "appearance",
    description: "settings.themeModeDescription",
    visibility: "all",
  },
  {
    id: "settings.fontSmoothing",
    section: "appearance",
    description: "settings.fontSmoothingDescription",
    visibility: "macDesktop",
  },
  {
    id: "settings.uiFontSize",
    section: "appearance",
    description: "settings.uiFontSizeDescription",
    visibility: "all",
  },
  {
    id: "settings.lightTheme",
    section: "appearance",
    description: "settings.lightThemeDescription",
    visibility: "all",
  },
  {
    id: "settings.darkTheme",
    section: "appearance",
    description: "settings.darkThemeDescription",
    visibility: "all",
  },
  {
    id: "settings.showLineNumbers",
    section: "appearance",
    description: "settings.showLineNumbersDescription",
    visibility: "all",
  },
  {
    id: "settings.wrapLongLines",
    section: "appearance",
    description: "settings.wrapLongLinesDescription",
    visibility: "all",
  },
  {
    id: "settings.fontSize",
    section: "appearance",
    description: "settings.fontSizeDescription",
    visibility: "all",
  },
  {
    id: "settings.browser.control.title",
    section: "browser",
    description: "settings.browser.control.description",
    visibility: "all",
  },
  {
    id: "settings.browser.import.title",
    section: "browser",
    description: "settings.browser.import.description",
    visibility: "notWindows",
  },
  {
    id: "settings.embeddedBrowserAllowInsecureCertificates",
    section: "browser",
    description: "settings.embeddedBrowserAllowInsecureCertificatesDescription",
    visibility: "desktop",
  },
  {
    id: "settings.browser.clearCache.title",
    section: "browser",
    description: "settings.browser.clearCache.description",
    visibility: "all",
  },
  {
    id: "settings.browser.clearAll.title",
    section: "browser",
    description: "settings.browser.clearAll.description",
    visibility: "all",
  },
  {
    id: "settings.computerUse.toggleLabel",
    section: "computerUse",
    description: "settings.computerUse.toggleDescription",
    visibility: "computerUse",
  },
  {
    id: "settings.computerUse.composerEntry.label",
    section: "computerUse",
    description: "settings.computerUse.composerEntry.description",
    visibility: "computerUse",
  },
  {
    id: "settings.memory.workspaceMemory",
    section: "memory",
    description: "settings.memoryDescription",
    visibility: "all",
  },
  {
    id: "settings.pluginAutoRecommendation",
    section: "agentBehavior",
    description: "settings.pluginAutoRecommendationDescription",
    visibility: "all",
  },
  {
    id: "settings.dynamicWorkflow",
    section: "agentBehavior",
    description: "settings.dynamicWorkflowDescription",
    visibility: "workflow",
  },
  {
    id: "chat.officeSuggestions.setting",
    section: "general",
    description: "chat.officeSuggestions.settingDescription",
    visibility: "all",
  },
  {
    id: "settings.browser.htmlClickOpensBrowser",
    section: "browser",
    description: "settings.browser.htmlClickOpensBrowserDescription",
    visibility: "desktop",
  },
] as const satisfies readonly {
  id: string;
  section: SettingsSectionId;
  description: string | undefined;
  visibility: "all" | keyof SettingsSearchAvailability;
}[];

export type SettingsSearchId = (typeof SETTINGS_SEARCH_ITEMS)[number]["id"];
