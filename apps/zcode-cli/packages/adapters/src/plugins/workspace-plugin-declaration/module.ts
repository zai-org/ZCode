/**
 * workspace-plugin-declaration 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const workspacePluginDeclarationModule = {
  id: "workspace-plugin-declaration",
  requires: ["plugin-discovery", "zcode-cli"],
  provides: ["workspace-plugin-declaration"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
