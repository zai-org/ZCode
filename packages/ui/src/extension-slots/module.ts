/**
 * extension-slots 模块清单（architecture-governance managed 模块）。
 * Renderer：贡献表快照 store、composer.status 插槽、启动页「扩展」分区、扩展视图标签页、屏幕会话报告。
 * 层序 domain → app → adapters → components。
 */
export const extensionSlotsModule = {
  id: "extension-slots",
  requires: [
    "ui",
    "shared",
    "services",
    "plugin-ui",
    "extension-host-protocol",
    "mcp-apps-protocol",
  ],
  provides: ["extension-slots-components"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
