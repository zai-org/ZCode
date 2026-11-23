import {
  CoreErrorType,
  createCoreError,
  isCoreError,
  readUnparsedToolInput,
} from "@zcode/contracts";
import {
  createInitialInputValidationModelContent,
  createUnparsedToolInputModelContent,
  formatToolInputValidationError,
  selectRuntimeFailureIssues,
} from "../input-validation-model-content.js";
import { validateJsonSchemaValue } from "../json-schema.js";
import type { ToolInputValidationIssue } from "../tool-input-validation-issues.js";
import type { ToolEntry } from "../types.js";

const INITIAL_INPUT_VALIDATION_MODEL_CONTENT_KEY = "initialInputValidationModelContent";
const HOOK_REWRITE_INVALID_NOTE =
  "The tool input from the model was valid; the hook's rewrite of it was not.";

export function validateOutput(output: unknown, entry: ToolEntry): void {
  const runtimeSchemaValidation = validateRuntimeSchema(output, entry.runtimeOutputSchema);
  if (runtimeSchemaValidation === true) return;
  if (Array.isArray(runtimeSchemaValidation)) {
    throw createCoreError(
      CoreErrorType.ToolExecutionFailed,
      "Tool output failed runtimeOutputSchema validation",
      {
        context: {
          errors: runtimeSchemaValidation.slice(0, 20),
          toolName: entry.metadata.name,
        },
        recoverable: false,
      },
    );
  }

  const validation = validateJsonSchemaValue(output, entry.outputSchema);
  if (validation.valid) return;

  throw createCoreError(
    CoreErrorType.ToolExecutionFailed,
    "Tool output failed outputSchema validation",
    {
      context: {
        errors: validation.errors.slice(0, 20),
        toolName: entry.metadata.name,
      },
      recoverable: false,
    },
  );
}

function validateRuntimeSchema(output: unknown, schema: unknown): true | string[] | undefined {
  if (!isSafeParseSchema(schema)) return undefined;
  const parsed = schema.safeParse(output);
  if (parsed.success) return true;
  return parsed.error.issues.map((issue) => issue.message);
}

function isSafeParseSchema(schema: unknown): schema is {
  safeParse: (
    value: unknown,
  ) =>
    | { success: true; data: unknown }
    | { success: false; error: { issues: Array<{ message: string }> } };
} {
  return (
    typeof schema === "object" &&
    schema !== null &&
    "safeParse" in schema &&
    typeof (schema as { safeParse?: unknown }).safeParse === "function"
  );
}

export function validateInput(input: unknown, entry: ToolEntry): Error | undefined {
  const validation = validateJsonSchemaValue(input, entry.inputSchema);
  if (validation.valid) return undefined;

  return createInputValidationError(entry, validation.errors);
}

/**
 * 模型发出的入参不是合法 JSON（adapter 留下的标记，docs/model-tool-call-validation.md「Malformed tool input JSON」）
 * 时返回错误：在 schema 校验、validateInput、hook 与权限之前，工具不执行。必须看模型原始的 input 对象：
 * runtime schema 解析后会得到新对象，标记就没有了。
 */
export function createUnparsedToolInputError(
  toolName: string,
  modelInput: unknown,
): Error | undefined {
  const unparsed = readUnparsedToolInput(modelInput);
  if (!unparsed) return undefined;
  return createCoreError(
    CoreErrorType.ToolExecutionFailed,
    "Tool input could not be parsed as JSON",
    {
      context: {
        inputLength: unparsed.length,
        toolName,
        [INITIAL_INPUT_VALIDATION_MODEL_CONTENT_KEY]: createUnparsedToolInputModelContent(
          toolName,
          unparsed,
        ),
      },
      recoverable: true,
    },
  );
}

/**
 * PreToolUse hook 改写后的输入不符合 schema。结果不加 <tool_use_error>，与 hook 拒绝相同。
 * 修复原因：原来只有 `Tool input failed inputSchema validation`，模型以为是自己的输入错了，会改输入重试。
 * 多个 hook 的结果合并后不知道改写来自哪一个，所以不写 hook 来源。
 */
export function validateHookUpdatedInput(input: unknown, entry: ToolEntry): Error | undefined {
  const validation = validateJsonSchemaValue(input, entry.inputSchema);
  if (validation.valid) return undefined;
  const toolName = entry.metadata.name;
  return createCoreError(
    CoreErrorType.ToolExecutionFailed,
    `PreToolUse hook for ${toolName} returned updatedInput that failed schema validation: ${formatToolInputValidationError(
      toolName,
      validation.issues,
    )}\n${HOOK_REWRITE_INVALID_NOTE}`,
    {
      context: { errors: validation.errors.slice(0, 20), toolName },
      recoverable: true,
    },
  );
}

export function validateInitialModelToolInput(
  input: unknown,
  entry: ToolEntry,
  runtimeValidationIssues?: readonly ToolInputValidationIssue[],
  describeFailure?: () => string,
): Error | undefined {
  const validation = validateJsonSchemaValue(input, entry.inputSchema);
  // 修复原因：JSON Schema 查不了 URL / regex 格式、exclusiveMinimum、去空白长度和 refine。原来这里只看
  // JSON Schema，这些输入一路通过 validateInput、hook 和权限（有的还弹确认窗），到 handler 才抛出原始
  // ZodError JSON。runtime parser 报了可读 issues 时在这里返回，规则见 docs/model-tool-call-validation.md。
  if (runtimeValidationIssues && runtimeValidationIssues.length > 0) {
    const issues = selectRuntimeFailureIssues(
      entry.inputSchema,
      runtimeValidationIssues,
      validation.valid ? [] : validation.issues,
    );
    return createInitialInputValidationError(
      entry,
      issues,
      issues.map((issue) => issue.message),
      describeFailure,
    );
  }
  if (validation.valid) return undefined;
  return createInitialInputValidationError(
    entry,
    validation.issues,
    validation.errors,
    describeFailure,
  );
}

// 模型原始参数的首次 schema 失败需要把具体问题回传给模型；Hook 或权限
// 修改后的输入属于不同生命周期，不能复用这段 provider-visible 内容。
// describeFailure 是调用方补充的纠错说明，只在失败时生成，放在包装之内。
function createInitialInputValidationError(
  entry: ToolEntry,
  issues: readonly ToolInputValidationIssue[],
  errors: string[],
  describeFailure: (() => string) | undefined,
): Error {
  const modelContent = createInitialInputValidationModelContent(entry, issues, describeFailure?.());
  return createInputValidationError(entry, errors, modelContent);
}

export function getInitialInputValidationModelContent(error: Error): string | undefined {
  if (!isCoreError(error) || error.type !== CoreErrorType.ToolExecutionFailed) {
    return undefined;
  }
  const modelContent = error.context?.[INITIAL_INPUT_VALIDATION_MODEL_CONTENT_KEY];
  return typeof modelContent === "string" ? modelContent : undefined;
}

function createInputValidationError(
  entry: ToolEntry,
  errors: string[],
  modelContent?: string,
): Error {
  return createCoreError(
    CoreErrorType.ToolExecutionFailed,
    "Tool input failed inputSchema validation",
    {
      context: {
        errors: errors.slice(0, 20),
        toolName: entry.metadata.name,
        ...(modelContent === undefined
          ? {}
          : { [INITIAL_INPUT_VALIDATION_MODEL_CONTENT_KEY]: modelContent }),
      },
      recoverable: true,
    },
  );
}
