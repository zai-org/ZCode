/**
 * topic-resource-tool 模块清单（architecture-governance managed 模块）。
 * 层：app。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const topicResourceToolModule = {
  id: "topic-resource-tool",
  requires: ["shared", "zcode-cli"],
  provides: ["topic-resource-tool"],
  publicEntrypoints: ["../handlers/read-topic-resource.ts", "contract.ts"],
} as const;
