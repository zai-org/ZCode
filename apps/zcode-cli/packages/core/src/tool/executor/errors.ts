import { CoreErrorType, createCoreError, isCoreError } from "@zcode/contracts";
import {
  projectExecutionErrorPayload,
  selectExecutionErrorMessage,
} from "../../errors/error-payload.js";
import { truncateMiddleForModel } from "../result-persistence-format.js";
import type { ExecutableToolCall, ToolExecutionResult, ToolHandlerFailure } from "../types.js";
import { getInitialInputValidationModelContent } from "./validation.js";

export function createErrorResult(
  toolCall: ExecutableToolCall,
  error: Error,
  durationMs?: number,
  options?: {
    /** 工具补充给模型的说明，接在模型可见原文之后；不改 `error.message`。 */
    modelNote?: string;
    preserveReasonFormatting?: boolean;
  },
): ToolExecutionResult {
  const handlerFailure =
    isCoreError(error) && isToolHandlerFailure(error.context?.toolHandlerFailure)
      ? error.context.toolHandlerFailure
      : undefined;
  // subagent/turn/model 错误常把真实 provider 原因包在 cause 链里；
  // tool result 是父模型和 UI hover 的共同来源，必须在这里统一投影成可读摘要。
  const projectedError = projectExecutionErrorPayload(error);
  const reasonSource =
    isCoreError(error) &&
    (error.context?.reasonSource === "plan_approval_feedback" ||
      error.context?.reasonSource === "workflow_refine_feedback")
      ? error.context.reasonSource
      : undefined;
  const preservesReason = reasonSource !== undefined || options?.preserveReasonFormatting === true;
  // ExitPlanMode / workflow Refine 的用户反馈会暂存在 PermissionDenied.message，
  // 后续还要原样转成 steer 输入；这里不能被展示摘要器截断，否则超长反馈不会触发 input_too_large。
  // 普通拒绝附带的自由文本反馈（preserveReasonFormatting）同理原样保留。
  const message = preservesReason ? error.message : projectedError.message;
  // 根因：通用错误层按 tool name 拼接 provider 文案会反向依赖具体工具。
  // handler 只返回自己的 code/message；这里统一组装 envelope，并保留裸 message 给 UI 和日志。
  // 其他错误给模型的是同一 frame 的原文：保留换行，超过 1 万字符才截掉中间；与摘要相同时不另存。
  // 修复原因：模型收到 UI 摘要时，空白被折叠、500 字符截断，多行错误的细节丢失。
  const errorText = preservesReason
    ? undefined
    : truncateMiddleForModel(selectExecutionErrorMessage(error));
  const errorModelContent =
    getInitialInputValidationModelContent(error) ??
    (handlerFailure ? `<tool_use_error>${handlerFailure.message}</tool_use_error>` : undefined) ??
    (errorText !== undefined && errorText !== message ? errorText : undefined);
  // 工具补充的说明接在模型可见原文之后：没有单独的模型原文时，模型看到的就是 message。
  const modelContent = options?.modelNote
    ? `${errorModelContent ?? message}\n\n${options.modelNote}`
    : errorModelContent;
  return {
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    success: false,
    output: null,
    error: {
      type: isCoreError(error) ? error.type : error.name,
      message,
      ...(handlerFailure
        ? { code: String(handlerFailure.errorCode) }
        : projectedError.code
          ? { code: projectedError.code }
          : {}),
      ...(projectedError.detail ? { detail: projectedError.detail } : {}),
      ...(reasonSource ? { reasonSource } : {}),
      stack: error.stack,
    },
    ...(modelContent === undefined ? {} : { modelContent }),
    durationMs: durationMs ?? 0,
    startedAt: new Date(),
    completedAt: new Date(),
  };
}

/**
 * 规格 0.15：给超时与执行中取消的错误追加工具提供的对账说明。
 *
 * 只认这两种错误：只有它们会在「请求可能已被受理」之后打断 handler。handler 自己抛出的错误发生在它
 * 能返回结构化结果的位置，不在此列。生成同类型新错误并复制原错误的字段，不修改原对象（handler
 * 抛出的错误可能被共享），也不再套一层 cause——那会让错误详情里出现两段重复文本。
 */
export function annotateUnsettledCall(
  error: Error,
  entry: { describeUnsettledCall?: (input: unknown, toolCallId: string) => string | undefined },
  input: unknown,
  toolCallId: string,
): Error {
  if (!isCoreError(error)) return error;
  if (error.type !== CoreErrorType.ToolTimeout && error.type !== CoreErrorType.ToolCancelled) {
    return error;
  }
  const note = entry.describeUnsettledCall?.(input, toolCallId);
  if (!note) return error;
  const annotated = createCoreError(error.type, `${error.message} ${note}`, {
    ...(error.cause instanceof Error ? { cause: error.cause } : {}),
    ...(error.context ? { context: error.context } : {}),
    recoverable: error.recoverable,
    retryable: error.retryable,
  });
  annotated.stack = error.stack;
  return annotated;
}

export function createToolHandlerFailureError(
  toolCall: ExecutableToolCall,
  failure: ToolHandlerFailure,
): Error {
  return createCoreError(CoreErrorType.ToolExecutionFailed, failure.message, {
    context: {
      code: failure.errorCode,
      toolHandlerFailure: failure,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
    },
    recoverable: true,
  });
}

export function isToolHandlerFailure(value: unknown): value is ToolHandlerFailure {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<ToolHandlerFailure>;
  return (
    candidate.result === false &&
    typeof candidate.errorCode === "number" &&
    Number.isFinite(candidate.errorCode) &&
    typeof candidate.message === "string"
  );
}

export function isToolHandlerFailureError(error: unknown): boolean {
  return isCoreError(error) && isToolHandlerFailure(error.context?.toolHandlerFailure);
}

export function createPermissionErrorResult(
  toolCall: ExecutableToolCall,
  reason: string | undefined,
  context: Record<string, unknown>,
  options?: {
    preserveReasonFormatting?: boolean;
  },
): ToolExecutionResult {
  return createErrorResult(
    toolCall,
    createCoreError(
      CoreErrorType.PermissionDenied,
      reason ?? `Permission denied for ${toolCall.name}`,
      {
        context: {
          ...context,
          toolName: toolCall.name,
        },
        recoverable: true,
      },
    ),
    undefined,
    options,
  );
}
