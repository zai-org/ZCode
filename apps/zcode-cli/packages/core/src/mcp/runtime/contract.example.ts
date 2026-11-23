import type { McpPort } from "./contract.js";
/** 消费者同步读取内存；连接和工具列表刷新由生产侧推进。 */
export function readCurrentTools(port: McpPort) {
  return Object.values(port.getToolSnapshot()).flatMap((server) => server.tools ?? []);
}
