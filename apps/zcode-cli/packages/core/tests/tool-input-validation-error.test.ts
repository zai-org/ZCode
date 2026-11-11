import { describe, expect, it } from "vitest";
import { createErrorResult } from "../src/tool/executor/errors.js";
import { validateInitialModelToolInput, validateInput } from "../src/tool/executor/validation.js";
import { askUserQuestionToolEntry } from "../src/tool/handlers/ask-user-question.js";
import { bashToolEntry } from "../src/tool/handlers/bash.js";
import { jsToolEntry } from "../src/tool/handlers/node-repl.js";
import { exitPlanModeToolEntry } from "../src/tool/handlers/plan-mode.js";
import { readToolEntry } from "../src/tool/handlers/read.js";
import { skillToolEntry } from "../src/tool/handlers/skill.js";
import { todoWriteToolEntry } from "../src/tool/handlers/todo.js";
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
        "An unexpected parameter `nestedExtra` was provided",
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

  it("omits unrecognized issue kinds when a recognized issue exists", () => {
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
        "MixedTool failed due to the following issue:",
        "The required parameter `name` is missing",
      ].join("\n"),
    );
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
