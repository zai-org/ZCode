import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID } from "./plugin-marketplaces.js";

const RETIRED_STORE_PLUGIN_ID = `restore-legacy-sessions@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID}`;
/** 商店与 Agent 发现共用退役规则，避免隐藏入口后又从对话推荐恢复曝光。 */
export function isPluginStoreVisible(pluginId: string): boolean {
  return pluginId !== RETIRED_STORE_PLUGIN_ID;
}
const NODE_REPL_HOST_PLUGIN_ID = `node-repl-host@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID}`;
export function isUserFacingPlugin(pluginId: string): boolean {
  return pluginId !== NODE_REPL_HOST_PLUGIN_ID;
}
export function isDiscoverableOfficialPlugin(pluginId: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._-]*@zcode-plugins-official$/u.test(pluginId) &&
    isUserFacingPlugin(pluginId) &&
    isPluginStoreVisible(pluginId)
  );
}
