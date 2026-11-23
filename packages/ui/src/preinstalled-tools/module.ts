/**
 * ui-preinstalled-tools 模块清单（architecture-governance managed 模块）。
 * 层：ui。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const uiPreinstalledToolsModule = {
  id: "ui-preinstalled-tools",
  requires: ["ui", "shared", "preinstalled-tools-contract"],
  provides: ["ui-preinstalled-tools"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
