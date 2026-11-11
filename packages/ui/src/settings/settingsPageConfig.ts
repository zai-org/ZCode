import {
  Archive,
  Share2,
  Folders,
  Monitor,
  Moon,
  Settings,
  Settings2,
  SlidersHorizontal,
  Package,
  Bot,
  Palette,
  Sun,
  BarChart3,
  Terminal,
  AlarmClock,
  Anchor,
  Brain,
  Blocks,
  Globe2,
  Cable,
  WandSparkles,
  HardDrive,
  Keyboard,
  FileSearch,
  RefreshCw,
  User,
} from "lucide-react";
import { isSettingsSectionEnabled, type SettingsSectionId } from "@/lib/settingsNavigation.js";
import type { Theme } from "@/useTheme.js";

export const THEME_MODES: Array<{
  mode: Theme;
  icon: typeof Sun;
}> = [
  { mode: "system", icon: Monitor },
  { mode: "zai-dark", icon: Moon },
  { mode: "zai-light", icon: Sun },
];

export type SettingsSectionGroupId = "basics" | "agentCapabilities" | "dataAndStats";

interface SettingsSectionDefinition {
  id: SettingsSectionId;
  icon: typeof Settings;
  titleId: string;
  contentTitleId?: string;
  titleBadgeId?: string;
  groupId: SettingsSectionGroupId;
}

const BASE_SETTINGS_SECTION_GROUPS: Array<{
  id: SettingsSectionGroupId;
  titleId: string;
}> = [
  { id: "basics", titleId: "settings.sidebar.group.basics" },
  {
    id: "agentCapabilities",
    titleId: "settings.sidebar.group.agentCapabilities",
  },
  { id: "dataAndStats", titleId: "settings.sidebar.group.dataAndStats" },
];

const BASE_SETTINGS_SECTIONS: SettingsSectionDefinition[] = [
  {
    id: "general",
    icon: Settings2,
    titleId: "settings.systemTitle",
    groupId: "basics",
  },
  {
    id: "appearance",
    icon: Palette,
    titleId: "settings.appearanceTitle",
    groupId: "basics",
  },
  {
    id: "modelProvider",
    icon: Package,
    titleId: "settings.modelProviderTitle",
    groupId: "basics",
  },
  // 个性化（用户自定义指令）是 Agent 能力组的第一项：编辑 ~/.zcode/AGENTS.md，
  // 对所有会话生效（spec：docs/ui/settings-personalization.md）。
  {
    id: "personalization",
    icon: User,
    titleId: "settings.personalization.title",
    groupId: "agentCapabilities",
  },
  {
    id: "agentBehavior",
    icon: SlidersHorizontal,
    titleId: "settings.agentBehavior.title",
    groupId: "agentCapabilities",
  },
  {
    id: "memory",
    icon: Brain,
    titleId: "settings.memory",
    groupId: "agentCapabilities",
  },
  {
    id: "subagents",
    icon: Bot,
    titleId: "settings.subagents.title",
    groupId: "agentCapabilities",
  },
  {
    id: "plugin",
    icon: Blocks,
    titleId: "settings.plugins.title",
    groupId: "agentCapabilities",
  },
  {
    id: "mcp",
    icon: Cable,
    titleId: "settings.mcpTitle",
    groupId: "agentCapabilities",
  },
  {
    id: "skill",
    icon: WandSparkles,
    titleId: "settings.skills.title",
    groupId: "agentCapabilities",
  },
  {
    id: "commands",
    icon: Terminal,
    titleId: "settings.commands.title",
    groupId: "agentCapabilities",
  },
  {
    id: "automations",
    icon: AlarmClock,
    titleId: "settings.automations.title",
    titleBadgeId: "settings.automations.betaBadge",
    groupId: "agentCapabilities",
  },
  {
    id: "hooks",
    icon: Anchor,
    titleId: "settings.hooks.title",
    groupId: "agentCapabilities",
  },
  {
    id: "browser",
    icon: Globe2,
    titleId: "settings.browser.title",
    groupId: "basics",
  },
  // 原型导航顺序：浏览器之后才是远程设备；电脑控制继续紧随其后并受灰度门禁。
  {
    id: "remoteDevices",
    icon: HardDrive,
    titleId: "settings.remoteDevicesTitle",
    contentTitleId: "settings.remoteDevicesTitle",
    groupId: "basics",
  },
  // 电脑控制紧跟「浏览器」：两者都是给 Agent 用的本机操控入口，
  // 放在基础设置里让用户在同一处理解「控制浏览器 / 控制整台电脑」的关系。
  {
    id: "computerUse",
    icon: Monitor,
    titleId: "settings.computerUse.title",
    groupId: "basics",
  },
  // 键盘快捷键紧跟「电脑控制」：同属本机操控/效率配置，收纳在基础设置尾部。
  {
    id: "shortcuts",
    icon: Keyboard,
    titleId: "settings.shortcuts.title",
    groupId: "basics",
  },
  // 工作区搜索范围（.zcodeignore）：面向所有用户的基础工作区行为配置，收在基础设置末尾。
  {
    id: "workspaceFileSearch",
    icon: FileSearch,
    titleId: "settings.workspaceFileSearch.title",
    groupId: "basics",
  },
  // 数据同步是「数据与统计」的第一项（docs/remote/data-sync.md），仅桌面端显示。
  {
    id: "dataSync",
    icon: RefreshCw,
    titleId: "remoteSync.title",
    contentTitleId: "remoteSync.title",
    groupId: "dataAndStats",
  },
  {
    id: "usage",
    icon: BarChart3,
    titleId: "settings.usageTitle",
    groupId: "dataAndStats",
  },
  // 项目管理排在归档管理之前（docs/superpowers/specs/2026-10-24-project-management.md）。
  {
    id: "projects",
    icon: Folders,
    titleId: "projectManagement.nav",
    groupId: "dataAndStats",
  },
  {
    id: "archives",
    icon: Archive,
    titleId: "archives.nav",
    groupId: "dataAndStats",
  },
  // 分享管理排在归档管理之后，仅桌面端（docs/conversation-share-v1.md「设置页分享管理」）。
  {
    id: "shares",
    icon: Share2,
    titleId: "conversationShare.manage.nav",
    groupId: "dataAndStats",
  },
  // 暂时隐藏设置页里的 Migration 入口，只保留页面实现，后续可以直接恢复这一项。
  // {
  //   id: "migration",
  //   icon: ArrowLeftRight,
  //   titleId: "settings.migration.title",
  // },
];

// 兼容既有只读消费者：默认配置代表不带桌面平台能力的 Web 视图；
// macOS/Windows/Linux 必须继续通过 createSettingsPageConfig 动态加入 Computer Use。
export const SETTINGS_SECTIONS = BASE_SETTINGS_SECTIONS.filter(
  (section) => section.id !== "computerUse" && isSettingsSectionEnabled(section.id),
);

export interface SettingsPageConfigOptions {
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
}

export function createSettingsPageConfig({
  isDesktop = false,
  isMacDesktop = false,
  isWindowsDesktop = false,
}: SettingsPageConfigOptions = {}) {
  const showComputerUse = isDesktop || isMacDesktop || isWindowsDesktop;
  const settingsSections = BASE_SETTINGS_SECTIONS.filter((section) => {
    if (section.id === "computerUse" && !showComputerUse) return false;
    return isSettingsSectionEnabled(section.id);
  });
  const settingsSectionGroups = BASE_SETTINGS_SECTION_GROUPS.map((group) => ({
    ...group,
    sections: settingsSections.filter((section) => section.groupId === group.id),
  })).filter((group) => group.sections.length > 0);

  return { settingsSectionGroups, settingsSections };
}

export function resolveSettingsSectionForPlatform(
  section: SettingsSectionId,
  visibleSections: ReadonlyArray<Pick<SettingsSectionDefinition, "id">>,
  fallbackSection: SettingsSectionId = "general",
): SettingsSectionId {
  if (visibleSections.some((candidate) => candidate.id === section)) return section;
  if (visibleSections.some((candidate) => candidate.id === fallbackSection)) {
    return fallbackSection;
  }
  return visibleSections[0]?.id ?? "general";
}

export const SETTINGS_SECTION_GROUPS = BASE_SETTINGS_SECTION_GROUPS.map((group) => ({
  ...group,
  sections: SETTINGS_SECTIONS.filter((section) => section.groupId === group.id),
})).filter((group) => group.sections.length > 0);

export type { SettingsSectionId };

/** 依赖本机 Source Server 管理与设备连接的设置页，Web 与手机远控不显示。 */
const DESKTOP_ONLY_SETTINGS_SECTIONS = new Set<SettingsSectionId>([
  "remoteDevices",
  "dataSync",
  "shares",
]);

export function isSettingsSectionAvailable(
  section: SettingsSectionId,
  isDesktop: boolean,
): boolean {
  return isDesktop || !DESKTOP_ONLY_SETTINGS_SECTIONS.has(section);
}
