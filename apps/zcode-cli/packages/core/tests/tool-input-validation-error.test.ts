import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createErrorResult } from "../src/tool/executor/errors.js";
import { validateInitialModelToolInput, validateInput } from "../src/tool/executor/validation.js";
import { askUserQuestionToolEntry } from "../src/tool/handlers/ask-user-question.js";
import { bashToolEntry } from "../src/tool/handlers/bash.js";
import { listWorkflowRunsToolEntry } from "../src/tool/handlers/list-workflow-runs.js";
import { jsToolEntry } from "../src/tool/handlers/node-repl.js";
import { exitPlanModeToolEntry } from "../src/tool/handlers/plan-mode.js";
import { readToolEntry } from "../src/tool/handlers/read.js";
import { skillToolEntry } from "../src/tool/handlers/skill.js";
import { todoWriteToolEntry } from "../src/tool/handlers/todo.js";
import { webFetchToolEntry } from "../src/tool/handlers/webfetch.js";
import { workflowToolEntry } from "../src/tool/handlers/workflow.js";
import { formatToolInputValidationError } from "../src/tool/input-validation-model-content.js";
import { prepareInitialToolExecutionInput } from "../src/tool/input-normalization.js";
import { validateJsonSchemaValue } from "../src/tool/json-schema.js";
import type { ToolEntry } from "../src/tool/types.js";

describe("tool input validation provider content", () => {
  it("formats missing, unexpected, and wrong-type issues in the required order", () => {
    const validation = validateJsonSchemaValue(
      {
        extraOne: true,
        extraTwo: false,
        items: [{ count: "bad", nestedExtra: true }],
      },
      {
        additionalProperties: false,
        properties: {
          missingValue: { type: "string" },
          otherMissing: { type: "boolean" },
          items: {
            items: {
              additionalProperties: false,
              properties: {
                count: { type: "integer" },
              },
              required: ["count"],
              type: "object",
            },
            type: "array",
          },
        },
        required: ["missingValue", "otherMissing", "items"],
        type: "object",
      },
    );

    expect(validation.valid).toBe(false);
    expect(formatToolInputValidationError("ValidationTool", validation.issues)).toBe(
      [
        "ValidationTool failed due to the following issues:",
        "The required parameter `missingValue` is missing",
        "The required parameter `otherMissing` is missing",
        "An unexpected parameter `items[0].nestedExtra` was provided",
        "An unexpected parameter `extraOne` was provided",
        "An unexpected parameter `extraTwo` was provided",
        "The parameter `items[0].count` type is expected as `number` but provided as `string`",
      ].join("\n"),
    );
  });

  it("uses empty paths and unknown when the received type cannot be extracted", () => {
    expect(
      formatToolInputValidationError("RootTool", [
        {
          expected: "string",
          code: "invalid_type",
          path: [],
          message: "custom type mismatch",
        },
      ]),
    ).toBe(
      [
        "RootTool failed due to the following issue:",
        "The parameter `` type is expected as `string` but provided as `unknown`",
      ].join("\n"),
    );
  });

  it("lists the other issue kinds after the recognized ones", () => {
    expect(
      formatToolInputValidationError("MixedTool", [
        {
          code: "invalid_value",
          values: ["fast", "safe"],
          path: ["mode"],
          message: 'Invalid option: expected one of "fast"|"safe"',
        },
        {
          expected: "string",
          code: "invalid_type",
          path: ["name"],
          message: "Invalid input: expected string, received undefined",
        },
      ]),
    ).toBe(
      [
        "MixedTool failed due to the following issues:",
        "The required parameter `name` is missing",
        'The parameter `mode` is invalid: Invalid option: expected one of "fast"|"safe"',
      ].join("\n"),
    );
  });

  it("words other issues by path, union and empty message, and caps them at 20 lines", () => {
    const others = Array.from({ length: 22 }, (_, index) => ({
      code: "too_small",
      origin: "number",
      minimum: 1,
      inclusive: true,
      path: [`n${index}`],
      message: "Too small: expected number to be >=1",
    }));
    const lines = formatToolInputValidationError("OtherTool", [
      { code: "unrecognized_keys", keys: ["extra"], path: ["outer"], message: "Unrecognized key" },
      { code: "invalid_union", errors: [], path: ["choice"], message: "Invalid input" },
      { code: "custom", path: [], message: "Invalid input: provide one of a or b" },
      { code: "custom", path: ["long"], message: "x".repeat(510) },
      ...others,
    ]).split("\n");

    expect(lines.slice(0, 5)).toEqual([
      "OtherTool failed due to the following issues:",
      "An unexpected parameter `outer.extra` was provided",
      "The parameter `choice` matches none of the accepted forms",
      "The input is invalid: provide one of a or b",
      `The parameter \`long\` is invalid: ${"x".repeat(500)}\u2026 [+10 chars]`,
    ]);
    // 只列前 20 条 other：上面 3 条 + n0..n16，剩下 n17..n21 共 5 条。
    expect(lines.at(-2)).toBe(
      "The parameter `n16` is invalid: Too small: expected number to be >=1",
    );
    expect(lines.at(-1)).toBe("(5 more issues not listed)");
    expect(lines).toHaveLength(1 + 1 + 20 + 1);
  });

  it("serializes every non-parameter issue with source-compatible messages and layout", () => {
    const validation = validateJsonSchemaValue(
      {
        choice: true,
        count: 0,
        label: "",
        list: [],
        literal: "wrong",
        mode: "other",
      },
      {
        additionalProperties: false,
        properties: {
          mode: { enum: ["fast", "safe"] },
          label: { type: "string", minLength: 3 },
          count: { type: "number", minimum: 1 },
          list: { type: "array", minItems: 1 },
          literal: { const: "fixed" },
          choice: {
            oneOf: [{ type: "string" }, { type: "number" }],
          },
        },
        required: ["mode", "label", "count", "list", "literal", "choice"],
        type: "object",
      },
    );

    expect(validation.valid).toBe(false);
    expect(formatToolInputValidationError("ConstraintTool", validation.issues)).toBe(`[
  {
    "code": "invalid_value",
    "values": [
      "fast",
      "safe"
    ],
    "path": [
      "mode"
    ],
    "message": "Invalid option: expected one of \\"fast\\"|\\"safe\\""
  },
  {
    "origin": "string",
    "code": "too_small",
    "minimum": 3,
    "inclusive": true,
    "path": [
      "label"
    ],
    "message": "Too small: expected string to have >=3 characters"
  },
  {
    "origin": "number",
    "code": "too_small",
    "minimum": 1,
    "inclusive": true,
    "path": [
      "count"
    ],
    "message": "Too small: expected number to be >=1"
  },
  {
    "origin": "array",
    "code": "too_small",
    "minimum": 1,
    "inclusive": true,
    "path": [
      "list"
    ],
    "message": "Too small: expected array to have >=1 items"
  },
  {
    "code": "invalid_value",
    "values": [
      "fixed"
    ],
    "path": [
      "literal"
    ],
    "message": "Invalid input: expected \\"fixed\\""
  },
  {
    "code": "invalid_union",
    "errors": [
      [
        {
          "expected": "string",
          "code": "invalid_type",
          "path": [],
          "message": "Invalid input: expected string, received boolean"
        }
      ],
      [
        {
          "expected": "number",
          "code": "invalid_type",
          "path": [],
          "message": "Invalid input: expected number, received boolean"
        }
      ]
    ],
    "path": [
      "choice"
    ],
    "message": "Invalid input"
  }
]`);
  });

  it("keeps normalized enum type mismatches on the invalid-value JSON fallback", () => {
    const validation = validateJsonSchemaValue(
      {
        mode: 7,
      },
      {
        additionalProperties: false,
        properties: {
          mode: { type: "string", enum: ["fast", "safe"] },
        },
        required: ["mode"],
        type: "object",
      },
    );

    expect(formatToolInputValidationError("EnumTool", validation.issues)).toBe(`[
  {
    "code": "invalid_value",
    "values": [
      "fast",
      "safe"
    ],
    "path": [
      "mode"
    ],
    "message": "Invalid option: expected one of \\"fast\\"|\\"safe\\""
  }
]`);
  });

  it("preserves schema property order across present constraints and missing enums", () => {
    const validation = validateJsonSchemaValue(
      {
        todos: [
          {
            content: "",
            priority: "high",
          },
        ],
      },
      {
        additionalProperties: false,
        properties: {
          todos: {
            items: {
              additionalProperties: false,
              properties: {
                content: { type: "string", minLength: 1 },
                status: {
                  type: "string",
                  enum: ["pending", "in_progress", "completed"],
                },
                priority: {
                  type: "string",
                  enum: ["high", "medium", "low"],
                },
              },
              required: ["content", "status", "priority"],
              type: "object",
            },
            type: "array",
          },
        },
        required: ["todos"],
        type: "object",
      },
    );

    expect(formatToolInputValidationError("TodoWrite", validation.issues)).toBe(`[
  {
    "origin": "string",
    "code": "too_small",
    "minimum": 1,
    "inclusive": true,
    "path": [
      "todos",
      0,
      "content"
    ],
    "message": "Too small: expected string to have >=1 characters"
  },
  {
    "code": "invalid_value",
    "values": [
      "pending",
      "in_progress",
      "completed"
    ],
    "path": [
      "todos",
      0,
      "status"
    ],
    "message": "Invalid option: expected one of \\"pending\\"|\\"in_progress\\"|\\"completed\\""
  }
]`);
  });

  it("serializes bigint issue values as strings", () => {
    expect(
      formatToolInputValidationError("BigIntConstraintTool", [
        {
          code: "invalid_value",
          values: [1n],
          path: ["value"],
          message: "Invalid input: expected 1n",
        },
      ]),
    ).toBe(`[
  {
    "code": "invalid_value",
    "values": [
      "1"
    ],
    "path": [
      "value"
    ],
    "message": "Invalid input: expected 1n"
  }
]`);
  });

  it("attaches exact model content only to initial model input validation", () => {
    const entry = createValidationEntry("ValidationTool");
    const toolCall = {
      id: "call_initial_validation",
      input: {},
      name: "ValidationTool",
    };

    const initialError = validateInitialModelToolInput({}, entry);
    const initialResult = createErrorResult(toolCall, initialError!);
    expect(initialResult.error?.message).toBe("Tool input failed inputSchema validation");
    expect(initialResult.modelContent).toBe(
      [
        "<tool_use_error>InputValidationError: ValidationTool failed due to the following issue:",
        "The required parameter `value` is missing</tool_use_error>",
      ].join("\n"),
    );

    const laterError = validateInput({}, entry);
    expect(createErrorResult(toolCall, laterError!).modelContent).toBeUndefined();
  });

  it("keeps every provider issue when internal diagnostics exceed their limit", () => {
    const required = Array.from({ length: 25 }, (_, index) => `value${index.toString()}`);
    const entry = {
      inputSchema: {
        additionalProperties: false,
        properties: Object.fromEntries(required.map((name) => [name, { type: "string" }])),
        required,
        type: "object",
      },
      metadata: {
        name: "CompleteValidationTool",
      },
    } as ToolEntry;

    const error = validateInitialModelToolInput({}, entry);
    const result = createErrorResult(
      {
        id: "call_complete_validation",
        input: {},
        name: "CompleteValidationTool",
      },
      error!,
    );

    expect(result.modelContent?.match(/The required parameter/g)).toHaveLength(25);
    expect(result.modelContent).toContain("The required parameter `value24` is missing");
  });

  it("lets initial validation content take precedence over the Edit execution wrapper", () => {
    const entry = createValidationEntry("Edit");
    const error = validateInitialModelToolInput({}, entry);

    const result = createErrorResult(
      {
        id: "call_edit_validation",
        input: {},
        name: "Edit",
      },
      error!,
    );

    expect(result.modelContent).toBe(
      [
        "<tool_use_error>InputValidationError: Edit failed due to the following issue:",
        "The required parameter `value` is missing</tool_use_error>",
      ].join("\n"),
    );
  });
});

describe("production runtime schema validation issues", () => {
  it("does not report a defaulted field when another AskUserQuestion constraint fails", () => {
    const content = initialValidationModelContent(askUserQuestionToolEntry, {
      questions: [
        {
          header: "Choice",
          options: [],
          question: "Which option?",
        },
      ],
    });

    expect(content).toContain('"code": "too_small"');
    expect(content).toContain('"path": [\n      "questions",\n      0,\n      "options"\n    ]');
    expect(content).not.toContain("multiSelect");
  });

  it("places nested item constraints before outer array constraints", () => {
    const questions = Array.from({ length: 5 }, (_, index) => validQuestion(index));
    questions[0] = { ...questions[0], options: [] };

    const content = initialValidationModelContent(askUserQuestionToolEntry, { questions });
    const nestedIssue = content.indexOf(
      '"path": [\n      "questions",\n      0,\n      "options"\n    ]',
    );
    const outerIssue = content.indexOf('"path": [\n      "questions"\n    ]');

    expect(nestedIssue).toBeGreaterThanOrEqual(0);
    expect(outerIssue).toBeGreaterThan(nestedIssue);
  });

  it("keeps runtime custom issues instead of reconstructing a default-field error", () => {
    const question = validQuestion(0);
    const content = initialValidationModelContent(askUserQuestionToolEntry, {
      questions: [
        { ...question, multiSelect: undefined },
        { ...question, multiSelect: undefined },
      ],
    });

    expect(content).toBe(`<tool_use_error>InputValidationError: [
  {
    "code": "custom",
    "path": [
      "questions"
    ],
    "message": "Question texts must be unique"
  }
]</tool_use_error>`);
  });

  it("does not report fields accepted by runtime preprocessing when a sibling fails", () => {
    expect(
      initialValidationModelContent(bashToolEntry, {
        command: 1,
        run_in_background: "true",
        timeout: "10",
      }),
    ).toBe(
      [
        "<tool_use_error>InputValidationError: Bash failed due to the following issue:",
        "The parameter `command` type is expected as `string` but provided as `number`</tool_use_error>",
      ].join("\n"),
    );
  });

  it.each([
    {
      entry: jsToolEntry,
      input: { code: 1 },
      expected: [
        "The required parameter `title` is missing",
        "The parameter `code` type is expected as `string` but provided as `number`",
      ],
    },
    {
      entry: skillToolEntry,
      input: { args: 1, name: "existing-skill" },
      expected: [
        "The required parameter `skill` is missing",
        "An unexpected parameter `name` was provided",
        "The parameter `args` type is expected as `string` but provided as `number`",
      ],
    },
    {
      entry: readToolEntry,
      input: { file_path: 1, pages: "1" },
      expected: [
        "An unexpected parameter `pages` was provided",
        "The parameter `file_path` type is expected as `string` but provided as `number`",
      ],
    },
  ])(
    "keeps provider-only structural issues for $entry.metadata.name",
    ({ entry, input, expected }) => {
      const content = initialValidationModelContent(entry, input);
      for (const line of expected) {
        expect(content).toContain(line);
      }
    },
  );

  it("keeps a single invalid-value issue for production enum schemas", () => {
    const content = initialValidationModelContent(todoWriteToolEntry, {
      todos: [
        {
          content: "Check result",
          priority: "urgent",
          status: "pending",
        },
      ],
    });

    expect(content.match(/"code": "invalid_value"/gu)).toHaveLength(1);
    expect(content).not.toContain('"code": "invalid_type"');
  });

  it("keeps a field refinement before a later enum issue", () => {
    expect(
      initialValidationModelContent(exitPlanModeToolEntry, {
        allowedPrompts: [{ prompt: "", tool: "bad" }],
        plan: "   ",
      }),
    ).toBe(`<tool_use_error>InputValidationError: [
  {
    "code": "custom",
    "path": [
      "plan"
    ],
    "message": "String must contain at least 1 character(s)"
  },
  {
    "code": "invalid_value",
    "values": [
      "Bash"
    ],
    "path": [
      "allowedPrompts",
      0,
      "tool"
    ],
    "message": "Invalid input: expected \\"Bash\\""
  }
]</tool_use_error>`);
  });
});

// 规则见根目录 docs/model-tool-call-validation.md：JSON Schema 通过、runtime schema 失败时也返回
// InputValidationError，runtime-only issue 不丢弃；需要友好文字的检查留给 validateInput。
describe("runtime-only issues after the JSON Schema passes", () => {
  it("reports an invalid URL before permission instead of a raw ZodError", () => {
    expect(initialValidationModelContent(webFetchToolEntry, { url: "not a url", prompt: "x" }))
      .toBe(`<tool_use_error>InputValidationError: [
  {
    "code": "invalid_format",
    "format": "url",
    "path": [
      "url"
    ],
    "message": "Invalid URL"
  }
]</tool_use_error>`);
  });

  it("keeps Zod 4 issues in their own structure instead of an empty list", () => {
    const entry = zodFourEntry(
      "SessionIdFixture",
      z.object({
        sessionId: z.string().regex(/^sess_[a-z]+$/, "Session id must look like sess_…"),
      }),
      { sessionId: { type: "string" } },
    );
    expect(initialValidationModelContent(entry, { sessionId: "dummy" })).toBe(
      `<tool_use_error>InputValidationError: [
  {
    "origin": "string",
    "code": "invalid_format",
    "format": "regex",
    "pattern": "/^sess_[a-z]+$/",
    "path": [
      "sessionId"
    ],
    "message": "Session id must look like sess_…"
  }
]</tool_use_error>`,
    );
  });

  it("keeps a Zod 4 trimmed length issue", () => {
    const entry = zodFourEntry("TitleFixture", z.object({ title: z.string().trim().min(1) }), {
      title: { type: "string" },
    });
    expect(initialValidationModelContent(entry, { title: "   " })).toBe(
      `<tool_use_error>InputValidationError: [
  {
    "origin": "string",
    "code": "too_small",
    "minimum": 1,
    "inclusive": true,
    "path": [
      "title"
    ],
    "message": "Too small: expected string to have >=1 characters"
  }
]</tool_use_error>`,
    );
  });

  it("formats a record value type issue as a parameter line", () => {
    const question = validQuestion(0);
    expect(
      initialValidationModelContent(askUserQuestionToolEntry, {
        questions: [question],
        answers: { [question.question]: 1 },
      }),
    ).toBe(
      [
        "<tool_use_error>InputValidationError: AskUserQuestion failed due to the following issue:",
        `The parameter \`answers.${question.question}\` type is expected as \`string\` but provided as \`number\`</tool_use_error>`,
      ].join("\n"),
    );
  });

  // 枚举收到错误类型时，runtime 报 invalid_value，原样输出。runtime 接受的值（limit 会被钳到 [1, 50]）
  // 不报错，即使 JSON Schema 认为它越界。
  it("keeps the runtime invalid value for an enum type mismatch", () => {
    expect(
      initialValidationModelContent(listWorkflowRunsToolEntry, { limit: 0, statuses: [123] }),
    ).toBe(`<tool_use_error>InputValidationError: [
  {
    "code": "invalid_value",
    "values": [
      "completed",
      "errored",
      "pending",
      "running",
      "stopped"
    ],
    "path": [
      "statuses",
      0
    ],
    "message": "Invalid option: expected one of \\"completed\\"|\\"errored\\"|\\"pending\\"|\\"running\\"|\\"stopped\\""
  }
]</tool_use_error>`);
  });

  it("keeps a runtime-only Zod 4 issue when the JSON Schema also fails", () => {
    const entry = zodFourEntry(
      "SessionPageFixture",
      z.object({
        sessionId: z.string().regex(/^sess_[a-z]+$/, "Session id must look like sess_…"),
        limit: z.number().int().min(1).max(200),
      }),
      { sessionId: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 200 } },
    );
    expect(initialValidationModelContent(entry, { sessionId: "dummy", limit: 0 })).toBe(
      `<tool_use_error>InputValidationError: [
  {
    "origin": "string",
    "code": "invalid_format",
    "format": "regex",
    "pattern": "/^sess_[a-z]+$/",
    "path": [
      "sessionId"
    ],
    "message": "Session id must look like sess_…"
  },
  {
    "origin": "number",
    "code": "too_small",
    "minimum": 1,
    "inclusive": true,
    "path": [
      "limit"
    ],
    "message": "Too small: expected number to be >=1"
  }
]</tool_use_error>`,
    );
  });

  it("keeps the runtime union issue when the JSON Schema also fails the union", () => {
    const schema = z.object({ mode: z.union([z.literal("fast"), z.number()]) });
    // JSON 的第二个分支故意与 runtime 不同（array 对 number）：换成 JSON issues 时输出会不同。
    const entry = zodFourEntry("ModeFixture", schema, {
      mode: { anyOf: [{ type: "string", const: "fast" }, { type: "array" }] },
    });
    const runtimeIssues = schema.safeParse({ mode: true }).error!.issues;
    expect(initialValidationModelContent(entry, { mode: true })).toBe(
      `<tool_use_error>InputValidationError: ${JSON.stringify(runtimeIssues, null, 2)}</tool_use_error>`,
    );
  });

  it("writes custom issues as code, path, message even without an explicit path", () => {
    expect(initialValidationModelContent(workflowToolEntry, {})).toBe(
      `<tool_use_error>InputValidationError: [
  {
    "code": "custom",
    "path": [],
    "message": "Workflow requires scriptPath, script, name, or resumeFromRunId."
  }
]</tool_use_error>`,
    );
  });
});

function zodFourEntry(
  name: string,
  runtimeInputSchema: z.ZodType,
  properties: Record<string, unknown>,
): ToolEntry {
  return {
    inputSchema: {
      additionalProperties: false,
      properties,
      required: Object.keys(properties),
      type: "object",
    },
    metadata: { name },
    runtimeInputSchema,
  } as ToolEntry;
}

function createValidationEntry(name: string): ToolEntry {
  return {
    inputSchema: {
      additionalProperties: false,
      properties: {
        value: { type: "string" },
      },
      required: ["value"],
      type: "object",
    },
    metadata: {
      name,
    },
  } as ToolEntry;
}

function initialValidationModelContent(entry: ToolEntry, input: unknown): string {
  const prepared = prepareInitialToolExecutionInput({ entry, input });
  const error = validateInitialModelToolInput(
    prepared.input,
    entry,
    prepared.runtimeValidationIssues,
  );
  const result = createErrorResult(
    {
      id: `call_${entry.metadata.name}`,
      input,
      name: entry.metadata.name,
    },
    error!,
  );
  expect(typeof result.modelContent).toBe("string");
  return result.modelContent as string;
}

function validQuestion(index: number): {
  header: string;
  multiSelect: boolean;
  options: Array<{ description: string; label: string }>;
  question: string;
} {
  return {
    header: `Q${index.toString()}`,
    multiSelect: false,
    options: [
      { description: "First choice", label: "First" },
      { description: "Second choice", label: "Second" },
    ],
    question: `Question ${index.toString()}?`,
  };
}
