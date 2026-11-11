import type { PluginDiscoveryContext, PluginDiscoveryPort } from "./contract.js";
/** 搜索只读取官方目录；即使有命中，也需要另一个经用户确认的动作才能安装。 */
export function findPluginForTask(port: PluginDiscoveryPort, context: PluginDiscoveryContext) {
  return port.search({ query: "邮件" }, context);
}
