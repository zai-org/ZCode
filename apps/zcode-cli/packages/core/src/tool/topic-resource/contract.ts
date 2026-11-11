import { z } from "zod";

// 会话工具设计 0.8：原 ReadSessionContext(topic, attachment) 的唯一后继，只读取当前会话
// 已接纳话题快照里的资源（A1、A2…），不读其他会话或未接纳的群消息。
export const READ_TOPIC_RESOURCE_TOOL_NAME = "ReadTopicResource";

export const ReadTopicResourceInputSchema = z
  .object({
    inputId: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe(
        "Snapshot inputId from the topic history file; selects only an admitted input in this task.",
      ),
    messageId: z
      .string()
      .min(1)
      .max(256)
      .describe("Message id of the resource in the topic history file resource index."),
    index: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Resource position inside that message, starting at zero. Defaults to 0."),
  })
  .strict();

export type ReadTopicResourceInput = z.infer<typeof ReadTopicResourceInputSchema>;

export const ReadTopicResourceInputJsonSchema = z.toJSONSchema(ReadTopicResourceInputSchema);

export const ReadTopicResourceOutputSchema = z
  .object({
    status: z.literal("success"),
    path: z.string().min(1),
    fileName: z.string(),
    mime: z.string(),
    bytes: z.number().int().nonnegative(),
    messageId: z.string(),
    index: z.number().int().nonnegative(),
  })
  .strict();

export type ReadTopicResourceOutput = z.infer<typeof ReadTopicResourceOutputSchema>;

export const ReadTopicResourceOutputJsonSchema = z.toJSONSchema(ReadTopicResourceOutputSchema);
