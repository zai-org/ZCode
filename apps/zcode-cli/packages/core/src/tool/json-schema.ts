// ============================================================
// Minimal JSON Schema validator for tool contract boundaries
// ============================================================

import type { JsonSchema } from "@zcode/contracts";
import {
  createInvalidTypeIssue,
  createInvalidUnionIssue,
  createInvalidValueIssue,
  createTooBigIssue,
  createTooSmallIssue,
  createUnrecognizedKeysIssue,
  type ToolInputValidationIssue,
  type ToolInputValidationPath,
} from "./tool-input-validation-issues.js";

export type {
  ToolInputValidationIssue,
  ToolInputValidationPath,
} from "./tool-input-validation-issues.js";

interface JsonSchemaValidationResult {
  valid: boolean;
  errors: string[];
  issues: ToolInputValidationIssue[];
}

interface ValidationCollector {
  errors: string[];
  issues: ToolInputValidationIssue[];
}

export function validateJsonSchemaValue(
  value: unknown,
  schema: JsonSchema | undefined,
): JsonSchemaValidationResult {
  if (!schema || Object.keys(schema).length === 0) {
    return { valid: true, errors: [], issues: [] };
  }

  const collector: ValidationCollector = {
    errors: [],
    issues: [],
  };
  validateNode(value, schema, "$", [], collector);
  return {
    valid: collector.errors.length === 0,
    errors: collector.errors,
    issues: collector.issues,
  };
}

function validateNode(
  value: unknown,
  schema: Record<string, unknown>,
  displayPath: string,
  issuePath: ToolInputValidationPath,
  collector: ValidationCollector,
): void {
  // anyOf 至少匹配一个分支，oneOf 恰好匹配一个分支，不满足时都报 invalid_union；两者是独立约束，同一节点都写时
  // 各查一次，同一节点的其他关键字也照常检查。
  // 修复原因：校验器原来只认 oneOf，工具契约的 union 与 nullable 改成 anyOf 后，hook / 权限改写后的输入与只靠
  // JSON Schema 的输出校验会跳过这些字段；它查完 union 还直接返回，MCP schema 里与 union 同级的 required /
  // additionalProperties 因此不检查。之后支持 anyOf 时又写成了 `anyOf ?? oneOf`，同一节点两个都写时 oneOf
  // 被跳过，不合契约的 MCP 入参会进入 hook、权限和 MCP 调用。
  validateUnion(value, schema, "anyOf", displayPath, issuePath, collector);
  validateUnion(value, schema, "oneOf", displayPath, issuePath, collector);

  let valueConstraintFailed = false;
  if ("const" in schema && !Object.is(value, schema.const)) {
    collector.errors.push(`${displayPath} must be ${JSON.stringify(schema.const)}`);
    collector.issues.push(createInvalidValueIssue([schema.const], issuePath));
    valueConstraintFailed = true;
  }

  const enumValues = Array.isArray(schema.enum) ? schema.enum : undefined;
  if (enumValues && !enumValues.some((item) => Object.is(item, value))) {
    collector.errors.push(
      `${displayPath} must be one of ${enumValues.map((item) => JSON.stringify(item)).join(", ")}`,
    );
    collector.issues.push(createInvalidValueIssue(enumValues, issuePath));
    valueConstraintFailed = true;
  }

  const type = schema.type;
  if (type !== undefined && !matchesType(value, type)) {
    collector.errors.push(`${displayPath} must be ${formatSchemaType(type)}`);
    // provider JSON Schema 会同时包含 enum/const 与推导出的 type，但目标
    // 校验行为在值约束失败时只产生 invalid_value；保留 legacy errors，同时避免
    // 重复的 invalid_type 改变 provider-visible 参数错误分类。
    if (!valueConstraintFailed) {
      if (Array.isArray(type)) {
        collector.issues.push(
          createInvalidUnionIssue(
            type.map((candidate) => [createInvalidTypeIssue(value, candidate, [])]),
            issuePath,
          ),
        );
      } else {
        collector.issues.push(createInvalidTypeIssue(value, type, issuePath));
      }
    }
    return;
  }

  if (typeof value === "string") {
    validateString(value, schema, displayPath, issuePath, collector);
  }

  if (typeof value === "number") {
    validateNumber(value, schema, displayPath, issuePath, collector);
  }

  if (Array.isArray(value)) {
    validateArray(value, schema, displayPath, issuePath, collector);
  }

  if (isRecord(value)) {
    validateObject(value, schema, displayPath, issuePath, collector);
  }
}

function validateUnion(
  value: unknown,
  schema: Record<string, unknown>,
  keyword: "anyOf" | "oneOf",
  displayPath: string,
  issuePath: ToolInputValidationPath,
  collector: ValidationCollector,
): void {
  const branches = asSchemaArray(schema[keyword]);
  if (!branches) return;
  const candidates = branches.map((candidate) => {
    const candidateCollector: ValidationCollector = {
      errors: [],
      issues: [],
    };
    validateNode(value, candidate, "$", [], candidateCollector);
    return candidateCollector;
  });
  const matches = candidates.filter((candidate) => candidate.errors.length === 0).length;
  if (keyword === "anyOf" ? matches > 0 : matches === 1) return;
  collector.errors.push(
    keyword === "anyOf"
      ? `${displayPath} must match at least one anyOf schema`
      : `${displayPath} must match exactly one oneOf schema, matched ${matches}`,
  );
  collector.issues.push(
    createInvalidUnionIssue(
      candidates.map((candidate) => candidate.issues),
      issuePath,
    ),
  );
}

function validateObject(
  value: Record<string, unknown>,
  schema: Record<string, unknown>,
  displayPath: string,
  issuePath: ToolInputValidationPath,
  collector: ValidationCollector,
): void {
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === "string")
    : [];
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const requiredSet = new Set(required);
  for (const key of required) {
    if (!(key in value) || value[key] === undefined) {
      collector.errors.push(`${displayPath}.${key} is required`);
    }
  }

  for (const [key, propertySchema] of Object.entries(properties)) {
    if (!(key in value) || value[key] === undefined) {
      if (requiredSet.has(key)) {
        // 参数 fallback 会原样序列化 issues；必须像 schema parser 一样按
        // properties 顺序生成，不能把所有 required 问题提前到已有字段的约束问题之前。
        collector.issues.push(
          ...createMissingPropertyIssues(isRecord(propertySchema) ? propertySchema : undefined, [
            ...issuePath,
            key,
          ]),
        );
      }
      continue;
    }
    if (!isRecord(propertySchema)) continue;
    validateNode(
      value[key],
      propertySchema,
      `${displayPath}.${key}`,
      [...issuePath, key],
      collector,
    );
  }

  for (const key of required) {
    if (Object.prototype.hasOwnProperty.call(properties, key)) continue;
    if (!(key in value) || value[key] === undefined) {
      collector.issues.push(createInvalidTypeIssue(undefined, "unknown", [...issuePath, key]));
    }
  }

  if (schema.additionalProperties === false) {
    const allowed = new Set(Object.keys(properties));
    const unexpectedKeys: string[] = [];
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) {
        collector.errors.push(`${displayPath}.${key} is not allowed`);
        unexpectedKeys.push(key);
      }
    }
    if (unexpectedKeys.length > 0) {
      collector.issues.push(createUnrecognizedKeysIssue(unexpectedKeys, issuePath));
    }
  }
}

function validateArray(
  value: unknown[],
  schema: Record<string, unknown>,
  displayPath: string,
  issuePath: ToolInputValidationPath,
  collector: ValidationCollector,
): void {
  let minimumIssue: ToolInputValidationIssue | undefined;
  if (typeof schema.minItems === "number" && value.length < schema.minItems) {
    collector.errors.push(`${displayPath} must contain at least ${schema.minItems} items`);
    minimumIssue = createTooSmallIssue("array", schema.minItems, issuePath);
  }
  let maximumIssue: ToolInputValidationIssue | undefined;
  if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
    collector.errors.push(`${displayPath} must contain at most ${schema.maxItems} items`);
    maximumIssue = createTooBigIssue("array", schema.maxItems, issuePath);
  }

  if (isRecord(schema.items)) {
    value.forEach((item, index) => {
      validateNode(
        item,
        schema.items as Record<string, unknown>,
        `${displayPath}[${index}]`,
        [...issuePath, index],
        collector,
      );
    });
  }

  // parser 会先产生元素问题，再产生数组自身的长度问题；legacy errors
  // 仍保持原顺序，只调整 provider-visible issues，避免改变 UI / 日志诊断。
  if (minimumIssue) collector.issues.push(minimumIssue);
  if (maximumIssue) collector.issues.push(maximumIssue);
}

function validateString(
  value: string,
  schema: Record<string, unknown>,
  displayPath: string,
  issuePath: ToolInputValidationPath,
  collector: ValidationCollector,
): void {
  if (typeof schema.minLength === "number" && value.length < schema.minLength) {
    collector.errors.push(`${displayPath} must be at least ${schema.minLength} characters`);
    collector.issues.push(createTooSmallIssue("string", schema.minLength, issuePath));
  }
  if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
    collector.errors.push(`${displayPath} must be at most ${schema.maxLength} characters`);
    collector.issues.push(createTooBigIssue("string", schema.maxLength, issuePath));
  }
}

function validateNumber(
  value: number,
  schema: Record<string, unknown>,
  displayPath: string,
  issuePath: ToolInputValidationPath,
  collector: ValidationCollector,
): void {
  if (typeof schema.minimum === "number" && value < schema.minimum) {
    collector.errors.push(`${displayPath} must be >= ${schema.minimum}`);
    collector.issues.push(createTooSmallIssue("number", schema.minimum, issuePath));
  }
  if (typeof schema.maximum === "number" && value > schema.maximum) {
    collector.errors.push(`${displayPath} must be <= ${schema.maximum}`);
    collector.issues.push(createTooBigIssue("number", schema.maximum, issuePath));
  }
}

function createMissingPropertyIssues(
  propertySchema: Record<string, unknown> | undefined,
  path: ToolInputValidationPath,
): ToolInputValidationIssue[] {
  if (propertySchema) {
    const collector: ValidationCollector = {
      errors: [],
      issues: [],
    };
    validateNode(undefined, propertySchema, "$", path, collector);
    if (collector.issues.length > 0) return collector.issues;
  }

  return [createInvalidTypeIssue(undefined, inferSchemaType(propertySchema), path)];
}

function inferSchemaType(schema: Record<string, unknown> | undefined): string {
  if (!schema) return "unknown";
  if (typeof schema.type === "string") return schema.type;
  if (isRecord(schema.properties) || Array.isArray(schema.required)) return "object";
  if (isRecord(schema.items)) return "array";
  return "unknown";
}

function matchesType(value: unknown, type: unknown): boolean {
  if (Array.isArray(type)) {
    return type.some((item) => matchesType(value, item));
  }

  switch (type) {
    case "array":
      return Array.isArray(value);
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return Number.isInteger(value);
    case "null":
      return value === null;
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "object":
      return isRecord(value);
    case "string":
      return typeof value === "string";
    default:
      return true;
  }
}

function asSchemaArray(value: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(value)) return undefined;
  const schemas = value.filter(isRecord);
  return schemas.length === value.length ? schemas : undefined;
}

function formatSchemaType(type: unknown): string {
  if (Array.isArray(type)) {
    return type.map((item) => String(item)).join(" or ");
  }
  return String(type);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
