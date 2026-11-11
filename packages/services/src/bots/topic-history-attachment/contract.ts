import type { BotTopicHistoryBatch, ZCodePromptFileAttachment } from "@zcode/shared";

/**
 * 把一次话题增量写成随用户消息发送的 text/plain 附件；没有消息且没有缺口时返回 undefined。
 * 附件末尾的资源索引（A1、A2…）每项即 ReadTopicResource 的输入对象。纯函数，无 IO。
 */
export type CreateTopicHistoryAttachment = (
  batch: BotTopicHistoryBatch,
  inputId: string,
  title: string,
) => ZCodePromptFileAttachment | undefined;
