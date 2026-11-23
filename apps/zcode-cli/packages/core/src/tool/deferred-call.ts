import {
  DEFERRED_TOOL_CALL_NAME,
  DeferredToolCallInputSchema,
  TOOL_SEARCH_NAME,
  type ToolSearchExecutionContext,
} from "@zcode/contracts";
import type { ExecutableToolCall } from "./types.js";
import type { ToolRegistry } from "./registry.js";
import { deferredToolCallEntry } from "./handlers/deferred-tool-call.js";
import { createToolHandlerFailureError } from "./executor/errors.js";
import {
  createUnparsedToolInputError,
  validateInitialModelToolInput,
} from "./executor/validation.js";

/** 准入失败的错误码；executor 按 ToolHandlerFailure 包成 <tool_use_error>。 */
const DEFERRED_TOOL_CALL_REJECTED_CODE = 1;

// 调度、流式准入与 executor 共用同一解析边界；失败保持包装身份，不触发目标生命周期。
export function resolveDeferredToolCall<T extends ExecutableToolCall>(
  call: T,
  search: ToolSearchExecutionContext | undefined,
  registry: Pick<ToolRegistry, "get">,
): { call: T; error?: Error } {
  const original = call;
  if (original.name !== DEFERRED_TOOL_CALL_NAME) return { call };
  // 修复原因：准入失败与未知工具同类，原来是不带标签的普通错误；现在与未知工具一样包成 <tool_use_error>，文字不变。
  const reject = (message: string) => ({
    call: original,
    error: createToolHandlerFailureError(original, {
      result: false,
      errorCode: DEFERRED_TOOL_CALL_REJECTED_CODE,
      message,
    }),
  });
  if (
    !search?.enabled ||
    search.mode !== "local" ||
    !search.catalog.some((tool) => tool.name === DEFERRED_TOOL_CALL_NAME)
  )
    return reject("DeferredToolCall is not available for this request.");
  const validation =
    createUnparsedToolInputError(DEFERRED_TOOL_CALL_NAME, original.input) ??
    validateInitialModelToolInput(original.input, deferredToolCallEntry);
  if (validation) return { call: original, error: validation };
  const parsed = DeferredToolCallInputSchema.safeParse(original.input);
  if (!parsed.success) return reject("Invalid DeferredToolCall input.");
  const { name, input } = parsed.data;
  const candidate = search.catalog.find((tool) => tool.name === name);
  const entry = registry.get(name);
  if (!candidate || !entry) return reject(`Tool not available in this request: ${name}`);
  if (
    name === TOOL_SEARCH_NAME ||
    name === DEFERRED_TOOL_CALL_NAME ||
    entry.providerNative ||
    !candidate.deferred
  ) {
    return reject(
      `Call ${name} directly using its normal tool call; DeferredToolCall only accepts deferred tools.`,
    );
  }
  return {
    call: {
      ...original,
      name,
      input,
      modelCallWrapper: DEFERRED_TOOL_CALL_NAME,
    },
  };
}
