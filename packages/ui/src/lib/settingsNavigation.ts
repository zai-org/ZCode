/* eslint-disable max-lines -- 设置导航意图集中管理 sessionStorage、事件桥接和解析校验，拆分会让一次性意图消费顺序更难保证。 */
import { logger } from "@/logger.js";

export type SettingsSectionId =
  | "general"
  | "agentBehavior"
  | "appearance"
  | "migration"
  | "browser"
  | "modelProvider"
  | "remoteDevices"
  | "dataSync"
  | "personalization"
  | "memory"
  | "plugin"
  | "mcp"
  | "skill"
  | "plugins"
  | "projects"
  | "archives"
  | "shares"
  | "usage"
  | "subagents"
  | "commands"
  | "hooks"
  | "workspaceFileSearch"
  | "computerUse"
  | "automations"
  | "shortcuts";

export type SettingsUsageTabTarget = "app" | "codingPlan";
export type SettingsPluginTabTarget = "plugins" | "mcps" | "skills" | "commands";
export type SettingsPluginNavigationOrigin = "plugin-store";

const SETTINGS_SECTION_INTENT_KEY = "zcode-settings-section-intent",
  SETTINGS_USAGE_TAB_INTENT_KEY = "zcode-settings-usage-tab-intent",
  SETTINGS_PLUGIN_TAB_INTENT_KEY = "zcode-settings-plugin-tab-intent",
  SETTINGS_PLUGIN_ORIGIN_INTENT_KEY = "zcode-settings-plugin-origin-intent",
  SETTINGS_PLUGIN_SCOPE_KEY_INTENT_KEY = "zcode-settings-plugin-scope-key-intent";
const SETTINGS_SOURCE_SERVER_ID_INTENT_KEY = "zcode-settings-source-server-id-intent";
const SETTINGS_SOURCE_SERVER_DETAILS_INTENT_KEY = "zcode-settings-source-server-details-intent";
const SETTINGS_MODEL_PROVIDER_ID_INTENT_KEY = "zcode-settings-model-provider-id-intent";
const SETTINGS_SECTION_INTENT_EVENT = "zcode:settings-section-intent",
  SETTINGS_LAST_SECTION_STORAGE_KEY = "zcode-settings-last-section";
const HIDDEN_SETTINGS_SECTIONS = new Set<SettingsSectionId>([
  // 产品语义：定时任务是 workspace 主视图，不能再作为设置页分区出现。
  // 注意：hooks 已是正式设置页分区，不在此列。
  "automations",
  // 旧插件市场已迁出设置页；保留 id 只用于迁移历史偏好和旧调用。
  "plugins",
  // 工作区搜索（.zcodeignore）设置入口先隐藏：规则文件仍生效并可手动编辑，
  // 编辑页代码保留，放开时从这里移除即可。
  "workspaceFileSearch",
]);

export interface SettingsSectionIntentEventDetail {
  section: SettingsSectionId;
  pluginTab?: SettingsPluginTabTarget;
  pluginOrigin?: SettingsPluginNavigationOrigin;
  pluginScopeKey?: string;
  usageTab?: SettingsUsageTabTarget;
  modelProviderId?: string;
  sourceServerId?: string;
  sourceServerDetails?: boolean;
}

export interface SettingsModelProviderTarget {
  providerId: string;
}

function isSettingsSectionId(value: string): value is SettingsSectionId {
  return (
    value === "general" ||
    value === "agentBehavior" ||
    value === "appearance" ||
    value === "migration" ||
    value === "browser" ||
    value === "modelProvider" ||
    value === "remoteDevices" ||
    value === "dataSync" ||
    value === "personalization" ||
    value === "memory" ||
    value === "plugin" ||
    value === "mcp" ||
    value === "skill" ||
    value === "plugins" ||
    value === "projects" ||
    value === "archives" ||
    value === "shares" ||
    value === "usage" ||
    value === "subagents" ||
    value === "commands" ||
    value === "hooks" ||
    value === "workspaceFileSearch" ||
    value === "computerUse" ||
    value === "automations" ||
    value === "shortcuts"
  );
}

export function isSettingsSectionEnabled(section: SettingsSectionId): boolean {
  return !HIDDEN_SETTINGS_SECTIONS.has(section);
}

export function resolveSettingsSection(
  section: SettingsSectionId,
  fallbackSection: SettingsSectionId = "general",
): SettingsSectionId {
  if (section === "plugins") return "plugin";
  return isSettingsSectionEnabled(section) ? section : fallbackSection;
}

function getLocalStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage;
  } catch (error) {
    // 部分 WebView / 移动远控容器可能禁用 localStorage。
    // 设置页分区记忆只是 UI 偏好，存储不可用时回退默认入口，不应阻断打开设置页。
    logger.warn("[settingsNavigation] localStorage 不可用", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export function readLastSettingsSectionPreference(
  fallbackSection: SettingsSectionId = "general",
): SettingsSectionId {
  const storage = getLocalStorage();
  if (!storage) {
    return fallbackSection;
  }

  try {
    const raw = storage.getItem(SETTINGS_LAST_SECTION_STORAGE_KEY);
    // 旧 section id 已并入 plugin；迁移持久化值，避免继续传播历史路由语义。
    if (raw === "plugins") {
      storage.setItem(SETTINGS_LAST_SECTION_STORAGE_KEY, "plugin");
      setPendingPluginTab("plugins");
      return "plugin";
    }
    if (raw === "skills") {
      storage.setItem(SETTINGS_LAST_SECTION_STORAGE_KEY, "skill");
      return "skill";
    }
    // 旧版“代码预览”已并入“外观”，保留用户上次停留位置的迁移语义。
    if (raw === "codePreview") {
      storage.setItem(SETTINGS_LAST_SECTION_STORAGE_KEY, "appearance");
      return "appearance";
    }
    if (raw && isSettingsSectionId(raw)) {
      return resolveSettingsSection(raw, fallbackSection);
    }
    if (raw !== null) {
      storage.removeItem(SETTINGS_LAST_SECTION_STORAGE_KEY);
    }
  } catch (error) {
    logger.warn("[settingsNavigation] 读取上次设置分区失败", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return fallbackSection;
}

export function writeLastSettingsSectionPreference(section: SettingsSectionId): void {
  const resolvedSection = resolveSettingsSection(section);
  const storage = getLocalStorage();
  if (!storage) {
    return;
  }

  try {
    storage.setItem(SETTINGS_LAST_SECTION_STORAGE_KEY, resolvedSection);
  } catch (error) {
    logger.warn("[settingsNavigation] 写入上次设置分区失败", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function consumeInitialSettingsSection(
  fallbackSection: SettingsSectionId = "general",
): SettingsSectionId {
  const lastSection = readLastSettingsSectionPreference(fallbackSection);
  // 普通打开设置页以前把 consumePendingSettingsSection 的 fallback 写死为
  // modelProvider，导致没有显式跳转意图时也总进“模型供应商”。这里先读上次停留分区，
  // 再让 quickpick / 管理模型这类一次性意图覆盖它，保留显式入口的直达语义。
  return resolveSettingsSection(consumePendingSettingsSection(lastSection), lastSection);
}

export function setPendingSettingsSection(section: SettingsSectionId): void {
  setPendingSettingsSectionIntent(section);
}

export function setPendingSettingsUsageIntent(): void {
  // 使用统计入口只负责打开 Usage 分区，不强行覆盖用户要看的具体统计 tab。
  setPendingSettingsSectionIntent("usage");
}

export function setPendingSettingsUsageCodingPlanIntent(): void {
  // 剩余额度详情入口需要直达 Coding Plan 使用统计；
  // 头像菜单入口则只打开 Usage 分区，避免覆盖用户上次查看的统计 tab。
  setPendingSettingsSectionIntent("usage", { usageTab: "codingPlan" });
}

export function setPendingSettingsPluginIntent(
  tab: SettingsPluginTabTarget,
  options: {
    origin?: SettingsPluginNavigationOrigin;
    scopeKey?: string;
  } = {},
): void {
  const section =
    tab === "mcps"
      ? "mcp"
      : tab === "skills"
        ? "skill"
        : tab === "commands"
          ? "commands"
          : "plugin";
  setPendingSettingsSectionIntent(section, {
    pluginTab: tab === "plugins" ? tab : undefined,
    pluginOrigin: options.origin,
    pluginScopeKey: options.scopeKey,
  });
}

export function setPendingSettingsSectionIntent(
  section: SettingsSectionId,
  options: {
    pluginTab?: SettingsPluginTabTarget;
    pluginOrigin?: SettingsPluginNavigationOrigin;
    pluginScopeKey?: string;
    modelProviderId?: string;
    sourceServerId?: string;
    sourceServerDetails?: boolean;
    usageTab?: SettingsUsageTabTarget;
  } = {},
): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.setItem(SETTINGS_SECTION_INTENT_KEY, section);
    if (options.pluginTab) {
      window.sessionStorage.setItem(SETTINGS_PLUGIN_TAB_INTENT_KEY, options.pluginTab);
    } else {
      window.sessionStorage.removeItem(SETTINGS_PLUGIN_TAB_INTENT_KEY);
    }
    if (options.pluginOrigin) {
      window.sessionStorage.setItem(SETTINGS_PLUGIN_ORIGIN_INTENT_KEY, options.pluginOrigin);
    } else {
      window.sessionStorage.removeItem(SETTINGS_PLUGIN_ORIGIN_INTENT_KEY);
    }
    const normalizedPluginScopeKey = options.pluginScopeKey?.trim();
    if (normalizedPluginScopeKey) {
      window.sessionStorage.setItem(SETTINGS_PLUGIN_SCOPE_KEY_INTENT_KEY, normalizedPluginScopeKey);
    } else {
      window.sessionStorage.removeItem(SETTINGS_PLUGIN_SCOPE_KEY_INTENT_KEY);
    }
    if (options.usageTab) {
      window.sessionStorage.setItem(SETTINGS_USAGE_TAB_INTENT_KEY, options.usageTab);
    }
    if (section === "remoteDevices" && options.sourceServerId?.trim()) {
      window.sessionStorage.setItem(
        SETTINGS_SOURCE_SERVER_ID_INTENT_KEY,
        options.sourceServerId.trim(),
      );
    } else {
      window.sessionStorage.removeItem(SETTINGS_SOURCE_SERVER_ID_INTENT_KEY);
    }
    if (
      section === "remoteDevices" &&
      options.sourceServerId?.trim() &&
      options.sourceServerDetails
    ) {
      window.sessionStorage.setItem(SETTINGS_SOURCE_SERVER_DETAILS_INTENT_KEY, "true");
    } else {
      window.sessionStorage.removeItem(SETTINGS_SOURCE_SERVER_DETAILS_INTENT_KEY);
    }
    if (options.modelProviderId) {
      window.sessionStorage.setItem(SETTINGS_MODEL_PROVIDER_ID_INTENT_KEY, options.modelProviderId);
    } else {
      window.sessionStorage.removeItem(SETTINGS_MODEL_PROVIDER_ID_INTENT_KEY);
    }
  } catch {
    // 忽略浏览器存储异常，不影响主流程。
  }

  // 设置页已经打开时不会重新挂载，单纯写 sessionStorage 没有订阅者会响应。
  // 同窗口补发自定义事件，让已打开的 SettingsPage 也能即时跳到 quickpick 指定分区。
  window.dispatchEvent(
    new CustomEvent<SettingsSectionIntentEventDetail>(SETTINGS_SECTION_INTENT_EVENT, {
      detail: {
        section,
        pluginTab: options.pluginTab,
        pluginOrigin: options.pluginOrigin,
        pluginScopeKey: options.pluginScopeKey?.trim() || undefined,
        usageTab: options.usageTab,
        modelProviderId: options.modelProviderId,
        ...(section === "remoteDevices" && options.sourceServerId?.trim()
          ? {
              sourceServerId: options.sourceServerId.trim(),
              ...(options.sourceServerDetails ? { sourceServerDetails: true } : {}),
            }
          : {}),
      },
    }),
  );
}

function clearPendingSettingsSectionIntent(): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.removeItem(SETTINGS_SECTION_INTENT_KEY);
    window.sessionStorage.removeItem(SETTINGS_SOURCE_SERVER_ID_INTENT_KEY);
    window.sessionStorage.removeItem(SETTINGS_SOURCE_SERVER_DETAILS_INTENT_KEY);
    window.sessionStorage.removeItem(SETTINGS_USAGE_TAB_INTENT_KEY);
    window.sessionStorage.removeItem(SETTINGS_MODEL_PROVIDER_ID_INTENT_KEY);
    window.sessionStorage.removeItem(SETTINGS_PLUGIN_TAB_INTENT_KEY);
    window.sessionStorage.removeItem(SETTINGS_PLUGIN_ORIGIN_INTENT_KEY);
    window.sessionStorage.removeItem(SETTINGS_PLUGIN_SCOPE_KEY_INTENT_KEY);
  } catch {
    // 忽略浏览器存储异常，不影响主流程。
  }
}

export function consumePendingSettingsSection(
  fallbackSection: SettingsSectionId = "general",
): SettingsSectionId {
  if (typeof window === "undefined") {
    return fallbackSection;
  }

  try {
    const raw = window.sessionStorage.getItem(SETTINGS_SECTION_INTENT_KEY);
    if (raw !== null) {
      window.sessionStorage.removeItem(SETTINGS_SECTION_INTENT_KEY);
    }

    if (raw === "skills") {
      // 旧 Skills 使用复数 id；迁移到当前独立 skill 分区。
      return "skill";
    }
    if (raw && isSettingsSectionId(raw)) {
      return resolveSettingsSection(raw, fallbackSection);
    }
  } catch {
    // 忽略浏览器存储异常，不影响主流程。
  }

  return fallbackSection;
}

function setPendingPluginTab(tab: SettingsPluginTabTarget): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(SETTINGS_PLUGIN_TAB_INTENT_KEY, tab);
  } catch {
    // 忽略浏览器存储异常，不影响设置页打开。
  }
}

export function consumePendingSettingsPluginTab(): SettingsPluginTabTarget | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.sessionStorage.getItem(SETTINGS_PLUGIN_TAB_INTENT_KEY);
    window.sessionStorage.removeItem(SETTINGS_PLUGIN_TAB_INTENT_KEY);
    return raw === "plugins" || raw === "mcps" || raw === "skills" ? raw : undefined;
  } catch {
    return undefined;
  }
}

export function consumePendingSettingsPluginOrigin(): SettingsPluginNavigationOrigin | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.sessionStorage.getItem(SETTINGS_PLUGIN_ORIGIN_INTENT_KEY);
    return raw === "plugin-store" ? raw : undefined;
  } catch {
    return undefined;
  }
}

export function consumePendingSettingsPluginScopeKey(): string | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.sessionStorage.getItem(SETTINGS_PLUGIN_SCOPE_KEY_INTENT_KEY);
    return raw?.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function clearPendingSettingsPluginScopeKey(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(SETTINGS_PLUGIN_SCOPE_KEY_INTENT_KEY);
  } catch {
    // 忽略浏览器存储异常，不影响主流程。
  }
}

export function clearPendingSettingsPluginOrigin(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(SETTINGS_PLUGIN_ORIGIN_INTENT_KEY);
  } catch {
    // 忽略浏览器存储异常，不影响设置页打开。
  }
}

export function consumePendingSettingsUsageTab(): SettingsUsageTabTarget | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  try {
    const raw = window.sessionStorage.getItem(SETTINGS_USAGE_TAB_INTENT_KEY);
    if (raw !== null) {
      window.sessionStorage.removeItem(SETTINGS_USAGE_TAB_INTENT_KEY);
    }
    return raw === "app" || raw === "codingPlan" ? raw : undefined;
  } catch {
    // 忽略浏览器存储异常，不影响主流程。
    return undefined;
  }
}

export function consumePendingSettingsModelProviderTarget():
  | SettingsModelProviderTarget
  | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  try {
    const providerId = window.sessionStorage.getItem(SETTINGS_MODEL_PROVIDER_ID_INTENT_KEY);
    window.sessionStorage.removeItem(SETTINGS_MODEL_PROVIDER_ID_INTENT_KEY);
    if (!providerId?.trim()) {
      return undefined;
    }
    return {
      providerId: providerId.trim(),
    };
  } catch {
    // 忽略浏览器存储异常，不影响主流程。
    return undefined;
  }
}

export function shouldFallbackSettingsUsageTabToApp({
  activeTab,
  checkingCodingPlanTab,
  loadingModelProviders,
  showCodingPlanTab,
}: {
  activeTab: SettingsUsageTabTarget;
  checkingCodingPlanTab: boolean;
  loadingModelProviders: boolean;
  showCodingPlanTab: boolean;
}): boolean {
  // Coding Plan 跳转意图可能先于 provider/entitlement 数据完成加载。
  // 只有确认不再 loading 且仍没有有效套餐时才回退到 App Usage，避免“更多”点击后被首帧误改回默认 tab。
  return (
    activeTab === "codingPlan" &&
    !showCodingPlanTab &&
    !loadingModelProviders &&
    !checkingCodingPlanTab
  );
}

export function addPendingSettingsSectionListener(
  listener: (section: SettingsSectionId, detail?: SettingsSectionIntentEventDetail) => void,
): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }

  const handleIntent = (event: Event) => {
    const detail = (event as CustomEvent<SettingsSectionIntentEventDetail>).detail;
    if (detail?.section && isSettingsSectionId(detail.section)) {
      // 设置页已打开时，事件已经承载了这次跳转意图。
      // 这里同步清掉 sessionStorage，避免用户随后切到别的分区并退出后，
      // 下次挂载又被陈旧 pending 意图覆盖“上次停留分区”。
      clearPendingSettingsSectionIntent();
      listener(detail.section, detail);
    }
  };

  window.addEventListener(SETTINGS_SECTION_INTENT_EVENT, handleIntent);
  return () => {
    window.removeEventListener(SETTINGS_SECTION_INTENT_EVENT, handleIntent);
  };
}

/** 设置页先消费分区，再消费卡片目标；已挂载页面由同一导航事件直接接收。 */
export function consumePendingSettingsSourceServerId(): string | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const id = window.sessionStorage.getItem(SETTINGS_SOURCE_SERVER_ID_INTENT_KEY);
    window.sessionStorage.removeItem(SETTINGS_SOURCE_SERVER_ID_INTENT_KEY);
    return id?.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function consumePendingSettingsSourceServerDetails(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const details = window.sessionStorage.getItem(SETTINGS_SOURCE_SERVER_DETAILS_INTENT_KEY);
    window.sessionStorage.removeItem(SETTINGS_SOURCE_SERVER_DETAILS_INTENT_KEY);
    return details === "true";
  } catch {
    return false;
  }
}
