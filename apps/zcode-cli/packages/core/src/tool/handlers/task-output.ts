import {
  CoreErrorType,
  SessionEventType,
  TASK_OUTPUT_ALIASES,
  TASK_OUTPUT_PROVIDER_DESCRIPTION,
  TASK_OUTPUT_TOOL_NAME,
  TaskOutputInputSchema,
  TaskOutputResultSchema,
  TaskOutputResultJsonSchema,
  TaskOutputInputJsonSchema,
  createCoreError,
  type TaskOutputInput,
  type TaskOutputResult,
  type TaskOutputTask,
} from "@zcode/contracts";
import { escapeXml } from "../../runtime-task/notification.js";
import type { RuntimeTaskSnapshot } from "../../runtime-task/registry.js";
import { formatPersistedOutputEnvelope } from "../result-persistence-format.js";
import type {
  ToolEntry,
  ToolExecutionContext,
  ToolHandler,
  ToolHandlerFailure,
  ToolInputValidationContext,
  ToolInputValidationResult,
  ToolPersistedModelContentInput,
} from "../types.js";
import {
  formatCompactFileSize,
  projectTask,
  throwIfAborted,
} from "./task-output-projection.js";

const TASK_OUTPUT_DEFAULT_LENGTH = 32_000;
const TASK_OUTPUT_MAX_LENGTH = 160_000;
const TASK_OUTPUT_PERSIST_THRESHOLD_CHARS = 100_000;
const TASK_OUTPUT_RESULT_BUDGET_BYTES = 400_000;
const TASK_OUTPUT_PERSIST_PREVIEW_CHARS = 2_000;
const TASK_OUTPUT_POLL_INTERVAL_MS = 100;
const TASK_OUTPUT_ERROR_CODE = {
  TASK_ID_REQUIRED: 1,
  TASK_NOT_FOUND: 2,
} as const;

const taskOutputHandler: ToolHandler = async (input, context) => {
  const parsed = TaskOutputInputSchema.parse(input) as TaskOutputInput;
  const inputFailure = getTaskOutputInputFailure(parsed, context.runtimeTaskRegistry);
  if (inputFailure) return inputFailure;

  const registry = requireRuntimeTaskRegistry(context);

  const initialTask = registry.get(parsed.task_id);
  if (!initialTask) {
    return taskOutputFailure(
      TASK_OUTPUT_ERROR_CODE.TASK_NOT_FOUND,
      `No task found with ID: ${parsed.task_id}`,
    );
  }

  if (!parsed.block) {
    if (isTaskActive(initialTask.status)) {
      return taskOutputResult("not_ready", await projectTask(initialTask, context));
    }
    const projectedTask = await projectTask(initialTask, context);
    // notified 是完成结果已成功交付的 claim；投影前写入会在读取失败或
    // abort 时吞掉后续 completion notification。异步投影不会被外层取消竞态强制
    // 停止，因此 await 返回后必须再次检查 signal，再提交 claim。
    throwIfAborted(context.abortSignal);
    markTaskNotified(initialTask, context);
    return taskOutputResult("success", projectedTask);
  }

  await emitWaitingProgress(context);
  const task = await waitForTask(parsed.task_id, parsed.timeout, context);
  if (!task) {
    return taskOutputResult("timeout", null);
  }
  if (isTaskActive(task.status)) {
    return taskOutputResult("timeout", await projectTask(task, context));
  }
  const projectedTask = await projectTask(task, context);
  throwIfAborted(context.abortSignal);
  markTaskNotified(task, context);
  return taskOutputResult("success", projectedTask);
};

export const taskOutputToolEntry: ToolEntry = {
  aliases: TASK_OUTPUT_ALIASES,
  capability: "read output/logs from a background task",
  maxModelChars: TASK_OUTPUT_PERSIST_THRESHOLD_CHARS,
  metadata: {
    shouldDefer: true,
    name: TASK_OUTPUT_TOOL_NAME,
    searchHint: "read output/logs from a background task",
    description: TASK_OUTPUT_PROVIDER_DESCRIPTION,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    maxOutputBytes: TASK_OUTPUT_RESULT_BUDGET_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: taskOutputHandler,
  validateInput: validateTaskOutputInput,
  formatModelContent: formatTaskOutputModelContent,
  formatPersistedModelContent: formatPersistedTaskOutputModelContent,
  inputSchema: TaskOutputInputJsonSchema,
  outputSchema: TaskOutputResultJsonSchema,
  runtimeInputSchema: TaskOutputInputSchema,
  runtimeOutputSchema: TaskOutputResultSchema,
  permission: {
    permission: "taskOutput",
    reason: "TaskOutput reads a background task from the current runtime",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: TASK_OUTPUT_RESULT_BUDGET_BYTES,
    maxModelBytes: TASK_OUTPUT_RESULT_BUDGET_BYTES,
    strategy: "artifact",
    preview: {
      maxBytes: TASK_OUTPUT_RESULT_BUDGET_BYTES,
      direction: "head",
    },
    artifact: {
      enabled: true,
      retention: "session",
    },
  },
  resultArtifactContentType: "text/plain",
  timeout: {
    kind: "none",
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "TaskOutput was cancelled while waiting for the task",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function taskOutputFailure(errorCode: number, message: string): ToolHandlerFailure {
  return { result: false, errorCode, message };
}

function validateTaskOutputInput(
  input: unknown,
  context: ToolInputValidationContext,
): ToolInputValidationResult {
  const parsed = TaskOutputInputSchema.parse(input) as TaskOutputInput;
  return getTaskOutputInputFailure(parsed, context.runtimeTaskRegistry) ?? { result: true };
}

function getTaskOutputInputFailure(
  input: TaskOutputInput,
  registry: ToolInputValidationContext["runtimeTaskRegistry"],
): ToolHandlerFailure | undefined {
  if (!input.task_id) {
    return taskOutputFailure(TASK_OUTPUT_ERROR_CODE.TASK_ID_REQUIRED, "Task ID is required");
  }
  if (registry && !registry.get(input.task_id)) {
    return taskOutputFailure(
      TASK_OUTPUT_ERROR_CODE.TASK_NOT_FOUND,
      `No task found with ID: ${input.task_id}`,
    );
  }
  return undefined;
}

export function formatTaskOutputModelContent(output: unknown): string {
  const parsed = TaskOutputResultSchema.parse(output);
  const blocks = [`<retrieval_status>${parsed.retrieval_status}</retrieval_status>`];
  const task = parsed.task;
  if (task) {
    blocks.push(`<task_id>${task.task_id}</task_id>`);
    blocks.push(`<task_type>${task.task_type}</task_type>`);
    blocks.push(`<status>${task.status}</status>`);
    if (task.exitCode !== undefined && task.exitCode !== null) {
      blocks.push(`<exit_code>${task.exitCode}</exit_code>`);
    }
    if (task.output.trim()) {
      // 没有真实完整文件时，task_id 不是可读取路径，不能把它伪装成
      // “Full output”；此时保留原文，由外层的大结果 artifact 机制继续处理。
      const content = (
        task.outputFile ? truncateTaskOutput(task.output, task.outputFile) : task.output
      ).trimEnd();
      blocks.push(`<output>\n${content}\n</output>`);
    }
    if (task.error) {
      blocks.push(`<error>${task.error}</error>`);
    }
    if (task.activity) {
      blocks.push(formatTaskActivity(task.activity));
    }
  }
  return blocks.join("\n\n");
}

/** 运行中后台 Agent 的进展（与无进展提醒同一份事实），让模型判断是否卡住。 */
function formatTaskActivity(activity: NonNullable<TaskOutputTask["activity"]>): string {
  const lines = [
    "<activity>",
    `<last_progress_at>${activity.last_progress_at}</last_progress_at>`,
    `<no_progress_for_ms>${Math.floor(activity.no_progress_for_ms)}</no_progress_for_ms>`,
  ];
  if (activity.waiting_for_permission) {
    lines.push("<waiting_for_permission>true</waiting_for_permission>");
  }
  for (const tool of activity.running_tools) {
    lines.push(
      // 工具名和摘要来自 child 模型生成的工具入参，转义后才不会打乱父模型看到的块结构（!3563 评审 SG-04）。
      `<running_tool name="${escapeXml(tool.tool_name)}" running_for_ms="${Math.floor(tool.running_for_ms)}">${escapeXml(tool.summary ?? "")}</running_tool>`,
    );
  }
  lines.push("</activity>");
  return lines.join("\n");
}

export function truncateTaskOutput(
  output: string,
  outputPath: string,
  configuredValue = process.env.TASK_MAX_OUTPUT_LENGTH,
): string {
  const maxLength = resolveTaskOutputLength(configuredValue);
  if (output.length <= maxLength) return output;

  const prefix = `[Truncated. Full output: ${outputPath}]\n\n`;
  const tailLength = maxLength - prefix.length;
  return prefix + output.slice(-tailLength);
}

export function resolveTaskOutputLength(
  configuredValue = process.env.TASK_MAX_OUTPUT_LENGTH,
): number {
  if (!configuredValue) return TASK_OUTPUT_DEFAULT_LENGTH;
  const parsed = Number.parseInt(configuredValue, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return TASK_OUTPUT_DEFAULT_LENGTH;
  return Math.min(parsed, TASK_OUTPUT_MAX_LENGTH);
}

function formatPersistedTaskOutputModelContent(input: ToolPersistedModelContentInput): string {
  return formatPersistedOutputEnvelope({
    content: input.content,
    formatBytes: formatCompactFileSize,
    originalBytes: input.content.length,
    persistedPath: input.persistedPath,
    previewChars: TASK_OUTPUT_PERSIST_PREVIEW_CHARS,
  });
}

async function waitForTask(
  taskId: string,
  timeoutMs: number,
  context: ToolExecutionContext,
): Promise<RuntimeTaskSnapshot | undefined> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    throwIfAborted(context.abortSignal);
    const task = context.runtimeTaskRegistry?.get(taskId);
    if (!task) return undefined;
    if (!isTaskActive(task.status)) return task;
    await delay(TASK_OUTPUT_POLL_INTERVAL_MS);
  }
  return context.runtimeTaskRegistry?.get(taskId);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

const isTaskActive = (status: string): boolean => status === "running" || status === "pending";

function markTaskNotified(task: RuntimeTaskSnapshot, context: ToolExecutionContext): void {
  context.runtimeTaskRegistry?.update(task.taskId, (current) =>
    current.notified ? current : { ...current, notified: true },
  );
}

async function emitWaitingProgress(context: ToolExecutionContext): Promise<void> {
  if (!context.emitEvent) return;

  await context.emitEvent({
    id: crypto.randomUUID() as never,
    sessionId: context.sessionId,
    turnId: context.turnId,
    type: SessionEventType.ToolCallProgress,
    timestamp: new Date(),
    traceId: context.traceId,
    sequenceNumber: 0,
    payload: {
      toolCallId: context.toolCallId as never,
      toolName: TASK_OUTPUT_TOOL_NAME,
      elapsedMs: 0,
    },
  });
}

function taskOutputResult(
  retrievalStatus: TaskOutputResult["retrieval_status"],
  task: TaskOutputTask | null,
): TaskOutputResult {
  return {
    retrieval_status: retrievalStatus,
    task,
  };
}

function requireRuntimeTaskRegistry(context: ToolExecutionContext) {
  const registry = context.runtimeTaskRegistry;
  if (registry) return registry;

  throw createCoreError(
    CoreErrorType.ConfigurationError,
    "Runtime task registry is not configured for TaskOutput",
    {
      context: {
        toolCallId: context.toolCallId,
        toolName: TASK_OUTPUT_TOOL_NAME,
      },
      recoverable: false,
    },
  );
}
