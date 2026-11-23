import type { Logger } from "@zcode/contracts";
import type { ToolInputValidationIssue } from "./tool-input-validation-issues.js";
import type { ToolEntry } from "./types.js";

interface NormalizeToolExecutionInputOptions {
  entry: ToolEntry;
  input: unknown;
  logger?: Logger;
  source: "initial" | "hook" | "permission";
}

export interface PreparedInitialToolExecutionInput {
  input: unknown;
  runtimeValidationIssues?: readonly ToolInputValidationIssue[];
}

type SafeParseResult<T = unknown> =
  | { success: true; data: T }
  | { success: false; error?: unknown };

interface SafeParseSchema<T = unknown> {
  safeParse(value: unknown): SafeParseResult<T>;
}

// Note: some model adapters and hook/broker paths can surface tool
// inputs as JSON strings instead of objects. We normalize safely here so bad
// input degrades into a recoverable validation error rather than crashing the
// executor before it can return a structured tool failure.
export function normalizeToolExecutionInput(
  options: NormalizeToolExecutionInputOptions,
): unknown {
  return prepareToolExecutionInput(options).input;
}

export function prepareInitialToolExecutionInput(
  options: Omit<NormalizeToolExecutionInputOptions, "source">,
): PreparedInitialToolExecutionInput {
  return prepareToolExecutionInput({ ...options, source: "initial" });
}

function prepareToolExecutionInput(
  options: NormalizeToolExecutionInputOptions,
): PreparedInitialToolExecutionInput {
  const jsonNormalized = normalizeTopLevelJsonString(options.input, options);
  const runtimeSchema = asSafeParseSchema(options.entry.runtimeInputSchema);
  if (!runtimeSchema) {
    return { input: jsonNormalized };
  }

  const parsed = runtimeSchema.safeParse(jsonNormalized);
  if (!parsed.success) {
    // runtime schema 已经完成默认值、preprocess 和约束判断；失败时若只
    // 返回 raw input，后续 JSON Schema 会重新推导一份不完整且顺序不同的错误。
    const runtimeValidationIssues = readRuntimeValidationIssues(parsed.error);
    return {
      input: jsonNormalized,
      ...(runtimeValidationIssues.length === 0 ? {} : { runtimeValidationIssues }),
    };
  }

  return { input: parsed.data };
}

function normalizeTopLevelJsonString(
  input: unknown,
  options: NormalizeToolExecutionInputOptions,
): unknown {
  if (typeof input !== "string") {
    return input;
  }

  try {
    return JSON.parse(input);
  } catch {
    options.logger?.warn("Tool execution input JSON normalization failed", {
      event: "tool.input.normalize_failed",
      inputLength: input.length,
      module: "core.tool.input-normalization",
      source: options.source,
      status: "failed",
      toolName: options.entry.metadata.name,
    });
    return input;
  }
}

function asSafeParseSchema(value: unknown): SafeParseSchema | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const safeParse = (value as { safeParse?: unknown }).safeParse;
  return typeof safeParse === "function" ? ({ safeParse } as SafeParseSchema) : undefined;
}

function readRuntimeValidationIssues(error: unknown): ToolInputValidationIssue[] {
  if (!error || typeof error !== "object") return [];
  const issues = (error as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return [];
  // 只保留可读 issue（带 path 数组、字符串 code 与 message）：首次输入校验按“有可读 issues”提前返回并原样输出
  // （docs/model-tool-call-validation.md），其余 issue 留下会让模型收到 `InputValidationError: []`。
  // 内置工具的 runtime schema 都是 zod 4，它的 issue 就是目标结构。
  return issues.filter(isReadableIssue);
}

function isReadableIssue(issue: unknown): issue is ToolInputValidationIssue {
  if (typeof issue !== "object" || issue === null || Array.isArray(issue)) return false;
  const { code, message, path } = issue as { code?: unknown; message?: unknown; path?: unknown };
  return (
    typeof code === "string" &&
    typeof message === "string" &&
    Array.isArray(path) &&
    path.every((segment) => typeof segment === "string" || typeof segment === "number")
  );
}
