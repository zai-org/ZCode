// 这些字段的插入顺序会直接进入 provider-visible JSON fallback，
// 必须保持稳定，不能改成只保证语义等价的通用错误对象。
export type ToolInputValidationPath = Array<string | number>;

export type ToolInputValidationIssue =
  | ToolInputCustomIssue
  | ToolInputInvalidFormatIssue
  | ToolInputInvalidTypeIssue
  | ToolInputInvalidValueIssue
  | ToolInputUnrecognizedKeysIssue
  | ToolInputTooSmallIssue
  | ToolInputTooBigIssue
  | ToolInputInvalidUnionIssue;

export interface ToolInputCustomIssue {
  code: "custom";
  path: ToolInputValidationPath;
  message: string;
}

export interface ToolInputInvalidFormatIssue {
  origin?: "string";
  code: "invalid_format";
  format: string;
  pattern?: string;
  path: ToolInputValidationPath;
  message: string;
}

export interface ToolInputInvalidTypeIssue {
  expected: string;
  format?: string;
  code: "invalid_type";
  received?: string;
  path: ToolInputValidationPath;
  message: string;
}

export interface ToolInputInvalidValueIssue {
  code: "invalid_value";
  values: unknown[];
  path: ToolInputValidationPath;
  message: string;
}

export interface ToolInputUnrecognizedKeysIssue {
  code: "unrecognized_keys";
  keys: string[];
  path: ToolInputValidationPath;
  message: string;
}

export interface ToolInputTooSmallIssue {
  origin: "array" | "number" | "string";
  code: "too_small";
  minimum: number;
  inclusive: boolean;
  exact?: true;
  path: ToolInputValidationPath;
  message: string;
}

export interface ToolInputTooBigIssue {
  origin: "array" | "number" | "string";
  code: "too_big";
  maximum: number;
  inclusive: boolean;
  exact?: true;
  path: ToolInputValidationPath;
  message: string;
}

export interface ToolInputInvalidUnionIssue {
  code: "invalid_union";
  errors: ToolInputValidationIssue[][];
  path: ToolInputValidationPath;
  message: "Invalid input";
}

export function createInvalidTypeIssue(
  value: unknown,
  schemaType: unknown,
  path: ToolInputValidationPath,
): ToolInputInvalidTypeIssue {
  const { expected, format } = expectedType(value, schemaType);
  const received = specialNumberReceived(value);
  const message = `Invalid input: expected ${expected}, received ${formatReceivedType(value)}`;

  if (format !== undefined) {
    return {
      expected,
      format,
      code: "invalid_type",
      path: [...path],
      message,
    };
  }
  if (received !== undefined) {
    return {
      expected,
      code: "invalid_type",
      received,
      path: [...path],
      message,
    };
  }
  return {
    expected,
    code: "invalid_type",
    path: [...path],
    message,
  };
}

export function createInvalidValueIssue(
  values: unknown[],
  path: ToolInputValidationPath,
): ToolInputInvalidValueIssue {
  return {
    code: "invalid_value",
    values: [...values],
    path: [...path],
    message:
      values.length === 1
        ? `Invalid input: expected ${formatIssueValue(values[0])}`
        : `Invalid option: expected one of ${formatIssueValues(values, "|")}`,
  };
}

export function createUnrecognizedKeysIssue(
  keys: string[],
  path: ToolInputValidationPath,
): ToolInputUnrecognizedKeysIssue {
  return {
    code: "unrecognized_keys",
    keys: [...keys],
    path: [...path],
    message: `Unrecognized key${keys.length > 1 ? "s" : ""}: ${formatIssueValues(keys, ", ")}`,
  };
}

// JSON Schema 校验器只检查 minimum / maximum / minLength / maxLength / minItems / maxItems，边界都含端点。
export function createTooSmallIssue(
  origin: ToolInputTooSmallIssue["origin"],
  minimum: number,
  path: ToolInputValidationPath,
): ToolInputTooSmallIssue {
  return {
    origin,
    code: "too_small",
    minimum,
    inclusive: true,
    path: [...path],
    message: formatSizeIssueMessage("too_small", origin, minimum),
  };
}

export function createTooBigIssue(
  origin: ToolInputTooBigIssue["origin"],
  maximum: number,
  path: ToolInputValidationPath,
): ToolInputTooBigIssue {
  return {
    origin,
    code: "too_big",
    maximum,
    inclusive: true,
    path: [...path],
    message: formatSizeIssueMessage("too_big", origin, maximum),
  };
}

export function createInvalidUnionIssue(
  errors: ToolInputValidationIssue[][],
  path: ToolInputValidationPath,
): ToolInputInvalidUnionIssue {
  return {
    code: "invalid_union",
    errors,
    path: [...path],
    message: "Invalid input",
  };
}

function expectedType(value: unknown, schemaType: unknown): { expected: string; format?: string } {
  if (schemaType === "integer") {
    if (typeof value === "number" && Number.isFinite(value)) {
      return { expected: "int", format: "safeint" };
    }
    return { expected: "number" };
  }
  return { expected: String(schemaType) };
}

function specialNumberReceived(value: unknown): string | undefined {
  if (typeof value !== "number") return undefined;
  if (Number.isNaN(value)) return "NaN";
  if (!Number.isFinite(value)) return "Infinity";
  return undefined;
}

function formatSizeIssueMessage(
  code: "too_big" | "too_small",
  origin: ToolInputTooBigIssue["origin"],
  limit: number,
): string {
  const comparison = code === "too_big" ? "<=" : ">=";
  const label = code === "too_big" ? "Too big" : "Too small";
  const unit = origin === "string" ? "characters" : origin === "array" ? "items" : undefined;
  if (unit) {
    return `${label}: expected ${origin} to have ${comparison}${limit.toString()} ${unit}`;
  }
  return `${label}: expected ${origin} to be ${comparison}${limit.toString()}`;
}

function formatIssueValues(values: unknown[], separator: string): string {
  return values.map(formatIssueValue).join(separator);
}

function formatIssueValue(value: unknown): string {
  if (typeof value === "bigint") return `${value.toString()}n`;
  if (typeof value === "string") return `"${value}"`;
  return `${String(value)}`;
}

function formatReceivedType(value: unknown): string {
  const valueType = typeof value;
  if (valueType === "number") return Number.isNaN(value) ? "NaN" : "number";
  if (typeof value === "object") {
    if (Array.isArray(value)) return "array";
    if (value === null) return "null";
    if (Object.getPrototypeOf(value) !== Object.prototype && value.constructor) {
      return value.constructor.name;
    }
  }
  return valueType;
}
