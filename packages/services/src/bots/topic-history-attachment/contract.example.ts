import { createTopicHistoryAttachment } from "#src/bots/topicHistoryAttachment.js";
import type { CreateTopicHistoryAttachment } from "#src/bots/topic-history-attachment/contract.js";

/** 调用方只依赖附件结果，不解析正文格式。 */
export const exampleCreateTopicHistoryAttachment: CreateTopicHistoryAttachment =
  createTopicHistoryAttachment;
