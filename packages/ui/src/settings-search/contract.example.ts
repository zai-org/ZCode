import type { SettingsSearchResult } from "@/settings-search/contract.js";

/** 搜索结果交给 SettingsPage 原导航；设置行挂载后按 id 定位。 */
export const fontSizeSearchResult = {
  section: "appearance",
  setting: "settings.uiFontSize",
} satisfies SettingsSearchResult;
