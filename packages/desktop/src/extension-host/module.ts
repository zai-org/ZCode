/**
 * extension-host 模块清单（architecture-governance managed 模块）。
 * adapters 层：扩展进程入口、注册表、ctx 运行时；Main 侧监管器（崩溃预算、存活探测、环境变量白名单、重新加载）。
 */
export const extensionHostModule = {
  id: "extension-host",
  requires: ["extension-host-protocol", "mcp-apps-protocol", "rpc", "desktop"],
  provides: ["extension-host-process", "extension-host-supervisor"],
  publicEntrypoints: ["index.ts", "contract.ts", "../main/extensionHostSupervisor.ts"],
} as const;
