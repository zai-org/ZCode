const CONVERSATION_DRAFT_CONTENT_WIDTH_CLASS_NAME = "max-w-2xl";
const CONVERSATION_CONTENT_WIDTH_CLASS_NAME = "w-full max-w-6xl";

export function getConversationContentWidthClassName(params: {
  centeredEmptyLayout: boolean;
}): string {
  // 状态胶囊不占消息列侧边空间，不再保留旧摘要面板的布局偏移。
  return params.centeredEmptyLayout
    ? CONVERSATION_DRAFT_CONTENT_WIDTH_CLASS_NAME
    : CONVERSATION_CONTENT_WIDTH_CLASS_NAME;
}
