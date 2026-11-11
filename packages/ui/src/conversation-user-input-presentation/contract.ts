import type { ConversationUserInputBubble } from "@/v4/ConversationUserInputBubble.js";

/** 展示输入以实际组件为唯一类型源，调用方继续持有消息状态。 */
export type ConversationUserInputPresentationProps = Parameters<
  typeof ConversationUserInputBubble
>[0];
