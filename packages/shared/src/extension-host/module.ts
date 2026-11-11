/**
 * extension-host-protocol 模块清单（architecture-governance managed 模块）。
 * domain 层：扩展进程、Window Host、Renderer 三方共用的纯 schema、类型与纯函数，不依赖任何进程。
 */
export const extensionHostProtocolModule = {
  id: "extension-host-protocol",
  requires: ["context-composition", "plugin-host-queries", "session-control", "shared"],
  provides: ["extension-host-protocol"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
