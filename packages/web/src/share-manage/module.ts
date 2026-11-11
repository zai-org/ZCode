/**
 * web-share-manage 模块清单（architecture-governance managed 模块）。
 * 层：ui。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const webShareManageModule = {
  id: "web-share-manage",
  requires: ["shared", "ui", "web", "web-auth"],
  provides: ["web-share-manage"],
  publicEntrypoints: ["index.ts", "contract.ts", "mockConversationShareManageClient.ts"],
} as const;
