import type {
  ConversationSharePreviewClientError,
  ConversationSharePreviewErrorKind,
} from "../share/conversationSharePreviewClient.js";

export function errorKindOf(error: unknown): ConversationSharePreviewErrorKind {
  return error && typeof error === "object" && "kind" in error
    ? (error as ConversationSharePreviewClientError).kind
    : "network";
}

export function logManageFailure(operation: string, error: unknown): void {
  // 只记录稳定字段：不记录 JWT、分享码或响应正文。
  const failure = error as Partial<ConversationSharePreviewClientError> | null;
  console.warn("[conversation-share-web]", "manage_operation_failed", {
    operation,
    kind: errorKindOf(error),
    status: typeof failure?.status === "number" ? failure.status : undefined,
    code: typeof failure?.code === "number" ? failure.code : undefined,
    requestId: typeof failure?.requestId === "string" ? failure.requestId : undefined,
  });
}
