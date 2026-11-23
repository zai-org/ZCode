import { z } from "zod";
import { dropTrailingHighSurrogate } from "../interfaces/shared.js";
import { toToolJsonSchema } from "./json-schema.js";

export const SEND_MESSAGE_TOOL_NAME = "SendMessage";
export const SEND_MESSAGE_MAX_CONTENT_CHARS = 20_000;
const SEND_MESSAGE_MAX_SUMMARY_CHARS = 200;
const SEND_MESSAGE_SUMMARY_ELLIPSIS = "…";

const SEND_MESSAGE_SUMMARY_DESCRIPTION = `A 5-10 word summary shown as a one-line preview in the UI. Defaults to the first line of a plain-text message; longer summaries are truncated to ${SEND_MESSAGE_MAX_SUMMARY_CHARS} characters rather than rejected.`;

// summary 可选；provider schema 声明上限，运行时超长截断而不是拒绝。
export const SendMessageInputSchema = z
  .object({
    to: z
      .string()
      .min(1)
      .max(200)
      .describe("Recipient: local agent ID returned by Agent (format agent_<uuid>)."),
    summary: z
      .string()
      .max(SEND_MESSAGE_MAX_SUMMARY_CHARS)
      .optional()
      .describe(SEND_MESSAGE_SUMMARY_DESCRIPTION),
    message: z
      .string()
      .min(1)
      .max(SEND_MESSAGE_MAX_CONTENT_CHARS)
      .describe("Plain text message content"),
  })
  .strict();

export type SendMessageInput = z.infer<typeof SendMessageInputSchema>;

export const SendMessageInputJsonSchema = toToolJsonSchema(SendMessageInputSchema);

export const SendMessageRuntimeInputSchema = SendMessageInputSchema.extend({
  // 只有空白的 message 由 SendMessage validateInput 拒绝（07-subagent.md），不写成 refine——
  // runtime schema 失败会先返回 InputValidationError，固定文字会变成 JSON。
  summary: z
    .string()
    .optional()
    .transform((summary) =>
      // 超长时留一位给省略号；修复原因：直接 slice 会切断 emoji 等代理对，留下孤立的高位代理。
      summary !== undefined && summary.length > SEND_MESSAGE_MAX_SUMMARY_CHARS
        ? `${dropTrailingHighSurrogate(summary.slice(0, SEND_MESSAGE_MAX_SUMMARY_CHARS - 1))}${SEND_MESSAGE_SUMMARY_ELLIPSIS}`
        : summary,
    ),
});

export const SendMessageOutputSchema = z
  .object({
    status: z.enum(["success", "failed"]),
    messageId: z.string(),
    agentId: z.string().optional(),
    delivery: z.enum(["queued", "steered", "resumed_background"]).optional(),
    error: z.string().optional(),
    message: z.string().optional(),
    outputFile: z.string().optional(),
    taskId: z.string().optional(),
  })
  .strict();

export type SendMessageOutput = z.infer<typeof SendMessageOutputSchema>;

export const SendMessageOutputJsonSchema = toToolJsonSchema(SendMessageOutputSchema);
