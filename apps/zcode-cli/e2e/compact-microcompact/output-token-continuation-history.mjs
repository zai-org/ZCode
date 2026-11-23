import { modelContentToText } from "./case-utils.mjs";

export function captureRuntimeHistory(app) {
  const entries = app.runtime.messageHistory.borrowReadOnlyRuntimeEntries();
  return entries.map((entry) => ({
    content:
      entry.kind === "attachment" ? entry.content : modelContentToText(entry.message?.content),
    kind: entry.kind ?? "message",
    role: entry.kind === "attachment" ? undefined : entry.message?.role,
  }));
}

export function assistantContents(history) {
  return history
    .filter((entry) => entry.role === "assistant")
    .map((entry) => entry.content)
    .filter((content) => content.length > 0);
}

export async function captureDurableAssistantHistory(app) {
  const messages = await app.runtime.sessionStore.messages({ sessionID: app.sessionId });
  return messages
    .filter((message) => message.info?.role === "assistant")
    .map((message) => ({
      content: message.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join(""),
      error: message.info.error,
      id: message.info.id,
      tokens: message.info.tokens,
    }));
}

/** 写库的 Continue 隐藏提醒条数。 */
export async function captureDurableContinueCount(app) {
  const messages = await app.runtime.sessionStore.messages({ sessionID: app.sessionId });
  return messages.filter(
    (message) => message.info?.semantics?.source === "output_token_continuation",
  ).length;
}
