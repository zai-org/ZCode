import { z } from "zod";
export const CONVERSATION_SELECTION_MAX_TEXT_LENGTH = 8_000;
export const CONVERSATION_SELECTION_MAX_COUNT = 8;
export const CONVERSATION_SELECTION_MAX_TOTAL_LENGTH = 16_000;
export const CONVERSATION_SELECTION_MAX_COMMENT_LENGTH = 2_000;
export const CONVERSATION_SELECTION_MAX_AGENT_LENGTH = 200;

export const conversationQuoteSchema = z.object({
  text: z.string().max(CONVERSATION_SELECTION_MAX_TEXT_LENGTH),
  path: z.string().optional(),
  senderName: z.string().optional(),
  senderId: z.string().optional(),
  messageId: z.string().optional(),
  sentAt: z.string().datetime({ offset: true }).optional(),
  // 用户对这段选区的批注；只有“批注”动作写入，普通引用缺省。
  comment: z.string().max(CONVERSATION_SELECTION_MAX_COMMENT_LENGTH).optional(),
  // 选区来自子 agent 输出时记录 agent 类型，让模型区分主对话与子 agent 的回答。
  agent: z.string().max(CONVERSATION_SELECTION_MAX_AGENT_LENGTH).optional(),
});
export const conversationQuotesSchema = z
  .array(conversationQuoteSchema)
  .max(CONVERSATION_SELECTION_MAX_COUNT)
  .refine(
    (quotes) =>
      quotes.reduce((sum, quote) => sum + quote.text.length, 0) <=
      CONVERSATION_SELECTION_MAX_TOTAL_LENGTH,
  );
export type ConversationSelectionText = z.infer<typeof conversationQuoteSchema>;

export function buildPromptWithConversationSelections(
  visibleContent: string,
  references: readonly ConversationSelectionText[],
): string {
  if (references.length === 0) return visibleContent;
  // 文件选段曾只发正文，导致模型与历史丢失文件来源；只保留路径，不发送内部身份字段。
  const block = [
    "# userselect:",
    "```userselect",
    JSON.stringify(
      references.map(({ text, path, comment, agent }) => ({
        ...(path?.trim() ? { path } : {}),
        text,
        ...(agent ? { agent } : {}),
        ...(comment?.trim() ? { comment } : {}),
      })),
    ),
    "```",
  ].join("\n");
  return visibleContent ? `${visibleContent}\n\n${block}` : block;
}
