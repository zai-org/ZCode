/** 用户消息正文组合的展示层归属；不拥有消息或队列状态。 */
export const conversationUserInputPresentationModule = {
  id: "conversation-user-input-presentation",
  requires: ["ui", "shared", "image-preview-editor"],
  provides: ["conversation-user-input-presentation"],
  publicEntrypoints: ["contract.ts", "../v4/ConversationUserInputBubble.tsx"],
} as const;
