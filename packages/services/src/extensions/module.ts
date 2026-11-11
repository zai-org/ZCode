/**
 * extensions-service 模块清单（architecture-governance managed 模块）。
 * app 层：Window Host 门面 IExtensionsService；插件访问 App 的唯一适配层（能力网关）；按代际连接扩展进程。
 */
export const extensionsServiceModule = {
  id: "extensions-service",
  requires: [
    "services",
    "shared",
    "rpc",
    "extension-host-protocol",
    "mcp-apps-protocol",
    "plugin-ui-bridge",
    "plugin-host-queries",
    "app-control",
    "session-control",
    "project",
  ],
  provides: ["extensions-service"],
  publicEntrypoints: ["index.ts", "contract.ts", "node.ts"],
} as const;
