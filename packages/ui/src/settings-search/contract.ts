import type { SettingsSectionId } from "@/lib/settingsNavigation.js";
import type { SettingsSearchId } from "@/settings-search/settingsSearchIndex.js";

/** 仅导航到分类或固定设置行；调用方不得据此修改设置值。 */
export interface SettingsSearchResult {
  section: SettingsSectionId;
  setting?: SettingsSearchId;
}

export type { SettingsSearchId } from "@/settings-search/settingsSearchIndex.js";
export { useSettingsSearchTarget } from "@/settings-search/SettingsSearchTarget.js";
