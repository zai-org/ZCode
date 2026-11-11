/** 资源管理器现有 Host 采样与 UI 展示边界；不创建新的运行时 owner。 */
export const resourceManagerModule = {
  id: "resource-manager",
  requires: ["shared", "ui"],
  provides: ["resource-manager"],
  publicEntrypoints: ["ResourceManagerApp.tsx", "contract.ts", "resourceUsageView.ts"],
} as const;
