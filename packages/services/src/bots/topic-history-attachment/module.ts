/**
 * bot-topic-history-attachment 模块清单（architecture-governance managed 模块）。
 * 层：app。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const botTopicHistoryAttachmentModule = {
  id: "bot-topic-history-attachment",
  requires: ["shared"],
  provides: ["bot-topic-history-attachment"],
  publicEntrypoints: ["../topicHistoryAttachment.ts", "contract.ts"],
} as const;
