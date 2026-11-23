/**
 * skill-live-catalog 模块清单（architecture-governance managed 模块）。
 * 层：app。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const skillLiveCatalogModule = {
  id: "skill-live-catalog",
  requires: ["zcode-cli", "shared", "live-config-watch"],
  provides: ["skill-live-catalog"],
  publicEntrypoints: ["listing.ts", "listing-metadata.ts", "contract.ts"],
} as const;
