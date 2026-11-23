import { markUnparsedToolInput, type Logger } from "@zcode/contracts";

interface NormalizeModelToolInputOptions {
  logger?: Logger;
  source: "generateText" | "streamText";
  toolName?: string;
}

export function normalizeModelToolInput(
  input: unknown,
  options: NormalizeModelToolInputOptions,
): unknown {
  if (input === undefined) {
    return {};
  }
  if (input === null) {
    // 上游会先把合法 JSON 字面量 "null" 解析成原生 null；
    // 这里必须与 string parse-null 使用相同恢复语义，且不能伪造原始长度。
    warnAndRecoverMalformedToolInput(new TypeError("Model tool input must not be null"), options, {
      inputType: "null",
    });
    return {};
  }
  if (typeof input !== "string") {
    return input;
  }
  // 只含空白与空串一样是“没给参数”，不按解析失败处理（否则同类输入一个报缺参、一个报无法解析 JSON）。
  if (input.trim().length === 0) {
    return {};
  }

  let normalizedInput: unknown;
  try {
    normalizedInput = JSON.parse(stripByteOrderMark(input));
  } catch (error) {
    warnAndRecoverMalformedToolInput(
      error,
      options,
      { inputLength: input.length },
      "unparsed_marker",
    );
    // AI SDK 已提供 final tool-call；此处抛 invalid_model_response
    // 会把参数错误错误地升级为整个模型请求失败。
    // 修复原因：原来降成普通的 {}，有必填参数的工具报“缺少参数”，没有必填参数的工具直接用空输入执行。
    // 现在返回带标记的 {}，executor 据此返回无法解析 JSON 的错误、不执行工具；标记不进 JSON，
    // provider 历史与持久化仍是 {}（docs/model-tool-call-validation.md「Malformed tool input JSON」）。
    return markUnparsedToolInput(input);
  }
  if (normalizedInput === null) {
    // JSON null 虽然语法合法，但不能表示工具参数。降级为空对象，让既有工具 schema 决定后续结果。
    warnAndRecoverMalformedToolInput(new TypeError("Model tool input must not be null"), options, {
      inputLength: input.length,
    });
    return {};
  }
  return normalizedInput;
}

/**
 * `recovery` 区分两种恢复：`unparsed_marker` 是 JSON 解析失败、返回带标记的 `{}`（executor 报解析错误）；
 * `empty_object` 是 `null`、返回普通 `{}`（走 schema）。看日志时据此区分。
 */
function warnAndRecoverMalformedToolInput(
  error: unknown,
  options: NormalizeModelToolInputOptions,
  inputContext: { inputLength: number } | { inputType: "null" },
  recovery: "empty_object" | "unparsed_marker" = "empty_object",
): void {
  options.logger?.warn("Model tool input JSON normalization failed", {
    event: "model.tool_input.normalize_failed",
    ...inputContext,
    module: "adapters.model.tool-input-normalization",
    parseErrorType: parseErrorType(error),
    recovery,
    source: options.source,
    status: "failed",
    toolName: options.toolName,
  });
}

function stripByteOrderMark(input: string): string {
  return input.startsWith("\uFEFF") ? input.slice(1) : input;
}

function parseErrorType(error: unknown): string {
  return error instanceof Error && error.name ? error.name : typeof error;
}
