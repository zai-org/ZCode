// ============================================================
// AskUserQuestion Tool - user clarification questions
// ============================================================
// References: interactive clarification tool behavior

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const ASK_USER_QUESTION_TOOL_NAME = "AskUserQuestion";
export const ASK_USER_QUESTION_TOOL_CHIP_WIDTH = 12;

const HTML_PREVIEW_MARKER_PATTERN = /<!doctype\b|<!--|<\/?\s*[a-z][a-z0-9:-]*(?:\s[^<>]*)?>/i;
const HTML_PREVIEW_TAG_PATTERN = /<\/?\s*[a-z][a-z0-9:-]*(?:\s[^<>]*)?>/i;
const HTML_PREVIEW_DOCUMENT_PATTERN = /<!doctype\b|<\/?\s*(?:html|body)\b/i;
const HTML_PREVIEW_SCRIPT_STYLE_PATTERN = /<\/?\s*(?:script|style)\b/i;

export const AskUserQuestionOptionSchema = z
  .object({
    label: z
      .string()
      .describe(
        "The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice.",
      ),
    description: z
      .string()
      .describe(
        "Explanation of what this option means or what will happen if chosen. Useful for providing context about trade-offs or implications.",
      ),
    preview: z
      .string()
      .optional()
      .describe(
        "Optional preview content rendered when this option is focused. Use for mockups, code snippets, or visual comparisons that help users compare options. See the tool description for the expected content format.",
      ),
  })
  .strict()
  .superRefine((option, context) => {
    if (option.preview !== undefined) {
      validateAskUserQuestionPreview(option.preview, context);
    }
  });

export type AskUserQuestionOption = z.infer<typeof AskUserQuestionOptionSchema>;

export const AskUserQuestionSchema = z
  .object({
    question: z
      .string()
      .describe(
        'The complete question to ask the user. Should be clear, specific, and end with a question mark. Example: "Which library should we use for date formatting?" If multiSelect is true, phrase it accordingly, e.g. "Which features do you want to enable?"',
      ),
    header: z
      .string()
      .describe(
        'Very short label displayed as a chip/tag (max 12 chars). Examples: "Auth method", "Library", "Approach".',
      ),
    options: z
      .array(AskUserQuestionOptionSchema)
      .min(2)
      .max(4)
      .describe(
        "The available choices for this question. Must have 2-4 options. Each option should be a distinct, mutually exclusive choice (unless multiSelect is enabled). There should be no 'Other' option, that will be provided automatically.",
      ),
    multiSelect: z
      .boolean()
      .default(false)
      .describe(
        "Set to true to allow the user to select multiple options instead of just one. Use when choices are not mutually exclusive.",
      ),
  })
  .strict()
  .superRefine((question, context) => {
    // addIssue 按 code、path、message 书写：superRefine 的 issue 按对象 key 顺序原样发给模型，
    // 这个顺序与 refine 生成的 issue 相同（docs/model-tool-call-validation.md）。
    const labels = question.options.map((option) => option.label);
    if (labels.length !== new Set(labels).size) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options"],
        message: "Option labels must be unique within each question",
      });
    }

    if (labels.some((label) => label.trim().toLowerCase() === "other")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options"],
        message: "Do not include an Other option; clients provide it automatically",
      });
    }
  });

export type AskUserQuestion = z.infer<typeof AskUserQuestionSchema>;

export const AskUserQuestionAnnotationSchema = z
  .object({
    preview: z
      .string()
      .optional()
      .describe("The preview content of the selected option, if the question used previews."),
    notes: z.string().optional().describe("Free-text notes the user added to their selection."),
  })
  .strict();

export type AskUserQuestionAnnotation = z.infer<typeof AskUserQuestionAnnotationSchema>;

const AskUserQuestionMetadataSchema = z
  .object({
    source: z
      .string()
      .optional()
      .describe(
        'Optional identifier for the source of this question (e.g., "remember" for /remember command). Used for analytics tracking.',
      ),
  })
  .strict();

export const AskUserQuestionInputSchema = z
  .object({
    questions: z
      .array(AskUserQuestionSchema)
      .min(1)
      .max(4)
      .describe("Questions to ask the user (1-4 questions)"),
    answers: z
      .record(z.string(), z.string())
      .optional()
      .describe("User answers collected by the permission component"),
    annotations: z
      .record(z.string(), AskUserQuestionAnnotationSchema)
      .optional()
      .describe(
        "Optional per-question annotations from the user (e.g., notes on preview selections). Keyed by question text.",
      ),
    metadata: AskUserQuestionMetadataSchema.optional().describe(
      "Optional metadata for tracking and analytics purposes. Not displayed to user.",
    ),
  })
  .strict()
  .superRefine((input, context) => {
    const questions = input.questions.map((question) => question.question);
    if (questions.length !== new Set(questions).size) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["questions"],
        message: "Question texts must be unique",
      });
    }
  });

export type AskUserQuestionInput = z.infer<typeof AskUserQuestionInputSchema>;

export const AskUserQuestionAnsweredInputSchema = AskUserQuestionInputSchema.superRefine(
  (input, context) => {
    // 问题用于可选澄清，用户可以完整、部分或零回答；只有 answers 字段
    // 完全缺失才表示 permission 阶段尚未完成，必须阻止 handler 提前执行。
    if (input.answers === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["answers"],
        message: "Answers have not been collected yet",
      });
      return;
    }
    for (const [question, answer] of Object.entries(input.answers)) {
      if (answer.trim().length === 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["answers", question],
          message: `Blank answer is not allowed for question: ${question}`,
        });
      }
    }
  },
);

export const AskUserQuestionOutputSchema = z
  .object({
    questions: z.array(AskUserQuestionSchema).min(1).max(4),
    answers: z.record(z.string(), z.string()).describe("User answers keyed by question text."),
    annotations: z
      .record(z.string(), AskUserQuestionAnnotationSchema)
      .optional()
      .describe("Optional per-question annotations keyed by question text."),
  })
  .strict();

export type AskUserQuestionOutput = z.infer<typeof AskUserQuestionOutputSchema>;

export const AskUserQuestionInputJsonSchema = toToolJsonSchema(AskUserQuestionInputSchema);

export const AskUserQuestionOutputJsonSchema = toToolJsonSchema(AskUserQuestionOutputSchema);

function validateAskUserQuestionPreview(preview: string, context: z.RefinementCtx): void {
  if (!HTML_PREVIEW_MARKER_PATTERN.test(preview)) {
    return;
  }

  if (HTML_PREVIEW_DOCUMENT_PATTERN.test(preview)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["preview"],
      message: "HTML preview must be a fragment without html, body, or doctype",
    });
  }

  if (HTML_PREVIEW_SCRIPT_STYLE_PATTERN.test(preview)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["preview"],
      message: "HTML preview cannot contain script or style tags",
    });
  }

  if (!HTML_PREVIEW_TAG_PATTERN.test(preview)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["preview"],
      message: "HTML preview must contain an HTML tag",
    });
  }
}
