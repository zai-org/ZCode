import type { ConversationShareAttempt } from "@/store/conversationShareSelectionStore.js";

export type { ConversationShareAttempt } from "@/store/conversationShareSelectionStore.js";

export interface ConversationShareAttemptIdFactory {
  now?: () => number;
  randomUUID?: () => string | undefined;
}

export function ensureConversationShareAttempt(
  current: ConversationShareAttempt | null,
  attemptKey: string,
  sessionId: string,
  factory: ConversationShareAttemptIdFactory = {},
): ConversationShareAttempt {
  if (current?.key === attemptKey) return current;

  const now = factory.now ?? Date.now;
  const disclosureAcceptedAt = now();
  const requestSuffix = factory.randomUUID?.() ?? `${sessionId}-${disclosureAcceptedAt}`;

  // 重试时必须复用同一份幂等请求体。之前只复用了 clientRequestId，
  // 却在 SessionPane 每次点击时重新生成 disclosureAcceptedAt，导致 payload_sha256 变化，
  // 服务端将同一个幂等键识别为请求体冲突并返回 409。
  return {
    key: attemptKey,
    clientRequestId: `share-${requestSuffix}`,
    disclosureAcceptedAt,
  };
}

/** 只有服务端明确确认记录失效才能换幂等键；超时和审核等待不能据此判断发布失败。 */
export function retainConversationShareAttemptAfterFailure(
  attempt: ConversationShareAttempt,
  code?: number,
): ConversationShareAttempt | null {
  // 3218：分享已被 owner 撤销，旧幂等键只会继续返回撤销错误。
  return code === 3211 || code === 3212 || code === 3218 ? null : attempt;
}
