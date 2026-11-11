// 上游请求体里的 token 预算提醒（apps/zcode-cli/docs/design/v2/loop/meta-user-context.md「Total-tokens reminder」）。
type Block = Record<string, unknown> & { type?: string };
type Message = { role: string; content: unknown };
type RequestShape = { messages: Message[]; system?: unknown };

export const TOTAL_TOKENS_BUDGET = 15_000_000;
export const TOTAL_TOKENS_LINE = `<total_tokens>${TOTAL_TOKENS_BUDGET} tokens left</total_tokens>`;
const TAG = /<total_tokens>(\d+) tokens left<\/total_tokens>/g;

export interface TotalTokensReminder {
  message: number;
  role: string;
  container: string;
  value: number;
  text: string;
}

/** 消息 content 统一成块数组：字符串视为一个文本块。 */
export function blocksOf(content: unknown): Block[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? (content as Block[]) : [];
}

/** 列出 messages 里的每个预算提醒；tool_result 内的块逐个列出。chat completions 的 system 在 messages[0]，不算。 */
export function totalTokensReminders(requestJson: unknown): TotalTokensReminder[] {
  const request = requestJson as RequestShape;
  const skipFirst = request.system === undefined && request.messages[0]?.role === "system";
  return request.messages.flatMap((message, index) => {
    if (skipFirst && index === 0) return [];
    return blocksOf(message.content).flatMap((block) => {
      const container = block.type === "tool_result" ? "tool_result" : message.role;
      const texts =
        block.type === "tool_result"
          ? blocksOf(block.content).map((inner) => String(inner.text ?? ""))
          : [String(block.text ?? "")];
      return texts.flatMap((text) =>
        [...text.matchAll(TAG)].map((match) => ({
          message: index,
          role: message.role,
          container,
          value: Number(match[1]),
          text,
        })),
      );
    });
  });
}

/** 最后一条 assistant 之后的提醒：本请求新追加的一条，或 compaction 保留下来的那一条。 */
export function totalTokensAfterLastAssistant(requestJson: unknown): number[] {
  const request = requestJson as RequestShape;
  const lastAssistant = request.messages.findLastIndex((message) => message.role === "assistant");
  return totalTokensReminders(request)
    .filter((item) => item.message > lastAssistant)
    .map((item) => item.value);
}

/**
 * 去掉 messages 里的全部预算提醒，用于检查提醒以外的内容是否只追加。
 * 提醒和相邻内容用 \n\n 分隔（并进 tool_result、合进 system 消息、或单独一块），按段删掉。
 * 只有因为删掉提醒而变空的块和消息才去掉；原本为空的内容保留，以免掩盖别的差异。
 */
export function withoutTotalTokensReminders<T>(requestJson: T): T {
  const request = structuredClone(requestJson) as RequestShape;
  request.messages = request.messages.flatMap((message) => {
    const content = stripContent(message.content);
    return content === undefined ? [] : [{ ...message, content }];
  });
  return request as T;
}

// 一段提醒只有两种完整形态：包一对 system-reminder 标签（user 侧），或裸行（MCS 合进 system）。
// 不接受只有半边标签的片段，否则删掉后会留下残缺的包裹，掩盖形态变化。
const REMINDER_PART =
  /^(?:<system-reminder>\n<total_tokens>\d+ tokens left<\/total_tokens>\n<\/system-reminder>|<total_tokens>\d+ tokens left<\/total_tokens>)$/;

/**
 * 去掉一段文本里的预算提醒段，用于按原样断言工具结果的模型面文字。
 * 工具批次后的提醒以 `\n\n` 段并进 tool_result 的文本，按完整形态整段删掉；没有提醒时原样返回。
 */
export function withoutTotalTokensReminderText(text: string): string {
  return stripText(text).text;
}

function stripText(text: string): { text: string; removed: boolean } {
  const parts = text.split("\n\n");
  const kept = parts.filter((part) => !REMINDER_PART.test(part.trim()));
  return kept.length === parts.length
    ? { text, removed: false }
    : { text: kept.join("\n\n"), removed: true };
}

/** 返回去掉提醒后的内容；只有删掉提醒后变空时返回 undefined。 */
function stripContent(content: unknown): unknown {
  if (typeof content === "string") {
    const { text, removed } = stripText(content);
    return removed && !text.trim() ? undefined : text;
  }
  if (!Array.isArray(content)) return content;
  let removedBlock = false;
  const blocks = (content as Block[]).flatMap((block) => {
    if (block.type === "text" && typeof block.text === "string") {
      const { text, removed } = stripText(block.text);
      if (removed && !text.trim()) {
        removedBlock = true;
        return [];
      }
      return [{ ...block, text }];
    }
    // 没有 content 的 tool_result 原样保留，不补出空串。
    if (block.type === "tool_result" && block.content !== undefined)
      return [{ ...block, content: stripContent(block.content) ?? "" }];
    return [block];
  });
  return removedBlock && blocks.length === 0 ? undefined : blocks;
}
