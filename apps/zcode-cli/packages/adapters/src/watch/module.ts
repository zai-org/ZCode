/**
 * live-config-watch 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const liveConfigWatchModule = {
  id: "live-config-watch",
  requires: ["zcode-cli", "plugin-discovery", "workspace-plugin-declaration"],
  provides: ["live-config-watch"],
  publicEntrypoints: ["watched-source.ts", "contract.ts", "../plugins/live-inventory.ts"],
} as const;
