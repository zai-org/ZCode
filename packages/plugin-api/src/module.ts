/**
 * plugin-api 模块清单（architecture-governance managed 模块）。
 * contract 层：插件作者用的类型包 `@zcode-dev/plugin-api`，只转出 extension-host-protocol 与 v4 协议的类型，
 * 不含运行时代码（docs/plugins/extension-host.md §17.9）。
 */
export const pluginApiModule = {
  id: "plugin-api",
  requires: ["extension-host-protocol", "shared"],
  provides: ["plugin-api"],
  publicEntrypoints: ["contract.ts", "manifest.ts", "sessions.ts", "protocol-v4.ts"],
} as const;
