import { isDeepStrictEqual } from "node:util";
import { toolSearchComparisonMessages } from "./tool-search-comparison.js";
import type { JsonObject, OpenAiMessage, TrajectoryDerivationOptions } from "./types.js";

export function isAppendOnly(
  previous: readonly OpenAiMessage[],
  next: readonly OpenAiMessage[],
  options: TrajectoryDerivationOptions = {},
): boolean {
  if (options.ignoreToolSearchChanges) {
    previous = toolSearchComparisonMessages(previous);
    next = toolSearchComparisonMessages(next);
  }
  if (next.length < previous.length) return false;
  return previous.every(
    (message, index) =>
      isTrajectoryMessageEqual(message, next[index]) ||
      (index === previous.length - 1 && isUserContentAppend(message, next[index])),
  );
}

export function completeAssistantMessage(
  summary: OpenAiMessage,
  previous: readonly OpenAiMessage[],
  next: unknown,
  options: TrajectoryDerivationOptions,
): OpenAiMessage {
  if (!Array.isArray(next) || !next.every(isMessage)) return summary;
  const before = options.ignoreToolSearchChanges
    ? toolSearchComparisonMessages(previous)
    : previous;
  const after = options.ignoreToolSearchChanges ? toolSearchComparisonMessages(next) : next;
  if (!isAppendOnly(before, after)) return summary;
  const recorded = after[before.length];
  if (recorded?.role !== "assistant" || !Array.isArray(recorded.content)) return summary;
  // response 摘要没有 thinking/签名；公告过滤可能改变索引，必须在同一比较视图中定位回复。
  // 摘要的 text 是所有文字块直接拼接、排在工具之前，请求里每个文字块单独一块，比较前按同样方式折叠。
  const comparable = {
    ...recorded,
    content: foldTextBlocksFirst(
      recorded.content.filter((block: unknown) => {
        if (!block || typeof block !== "object") return true;
        const { type } = block as JsonObject;
        return type !== "thinking" && type !== "redacted_thinking";
      }),
      summaryText(summary),
    ),
  };
  return isTrajectoryMessageEqual(summary, comparable) ? structuredClone(recorded) : summary;
}

function isTextBlock(block: unknown): block is { text: string } {
  return !!block && typeof block === "object" && (block as JsonObject).type === "text";
}

function summaryText(summary: OpenAiMessage): string {
  return Array.isArray(summary.content) ? (summary.content.find(isTextBlock)?.text ?? "") : "";
}

function foldTextBlocksFirst(content: unknown[], summary: string): unknown[] {
  const texts = content.filter(isTextBlock).map((block) => block.text);
  // 请求规则会删掉纯空白文字块（docs/design/v2/model/assistant-block-order.md「空白文字过滤」），
  // 摘要仍含这些空白。请求里的文字块依次出现在摘要中、其间只差空白时，按摘要文字比较。
  const text = droppedOnlyWhitespace(summary, texts) ? summary : texts.join("");
  return [
    ...(text.length > 0 ? [{ type: "text", text }] : []),
    ...content.filter((block) => !isTextBlock(block)),
  ];
}

function droppedOnlyWhitespace(summary: string, texts: readonly string[]): boolean {
  let cursor = 0;
  for (const text of texts) {
    const index = summary.indexOf(text, cursor);
    if (index < 0 || summary.slice(cursor, index).trim() !== "") return false;
    cursor = index + text.length;
  }
  return summary.slice(cursor).trim() === "";
}

function isMessage(value: unknown): value is OpenAiMessage {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as JsonObject).role === "string"
  );
}

function isUserContentAppend(previous: OpenAiMessage, next: OpenAiMessage): boolean {
  if (previous.role !== "user" || next.role !== "user") return false;
  const { content: before, ...previousFields } = previous;
  const { content: after, ...nextFields } = next;
  if (!Array.isArray(before) || !Array.isArray(after) || after.length <= before.length)
    return false;
  // 相邻 user 合并会扩展最后一条消息；仅接受旧 block 原样保留的追加，不能掩盖历史改写。
  return (
    isTrajectoryMessageEqual(previousFields, nextFields) &&
    isDeepStrictEqual(removeCacheControl(before), removeCacheControl(after.slice(0, before.length)))
  );
}

export function isTrajectoryMessageEqual(previous: OpenAiMessage, next: OpenAiMessage): boolean {
  // Anthropic 缓存标记会漂移；只在比较时忽略，输出仍保留最新请求的原始值。
  return isDeepStrictEqual(removeCacheControl(previous), removeCacheControl(next));
}

function removeCacheControl(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(removeCacheControl);
  const result: JsonObject = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (key !== "cache_control") result[key] = removeCacheControl(nestedValue);
  }
  return result;
}
