// task-output.ts 顶到 oxlint max-lines 上限（400 行），把任务投影
// （projectTask 及 dwf / agent 分支）、输出文件尾部快照读取和紧凑文件大小格式化拆到本文件；
// 公开面仍从 task-output.ts 导出。
import { open } from "node:fs/promises";
import type { TaskOutputTask } from "@zcode/contracts";
import type { RuntimeTaskSnapshot } from "../../runtime-task/registry.js";
import type { ToolExecutionContext } from "../types.js";
import { projectBashTask } from "./task-output-bash.js";

const TASK_OUTPUT_FILE_TAIL_BYTES = 8 * 1024 * 1024;
const TASK_OUTPUT_RUNNING_BASH_PREFIX_BYTES = 30_000;

export function formatCompactFileSize(size: number): string {
  const kilobytes = size / 1024;
  if (kilobytes < 1) return `${size} bytes`;
  if (kilobytes < 1024) return `${trimSingleDecimal(kilobytes)}KB`;
  const megabytes = kilobytes / 1024;
  if (megabytes < 1024) return `${trimSingleDecimal(megabytes)}MB`;
  return `${trimSingleDecimal(megabytes / 1024)}GB`;
}

function trimSingleDecimal(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

export async function projectTask(
  task: RuntimeTaskSnapshot,
  context: ToolExecutionContext,
): Promise<TaskOutputTask> {
  if (task.type === "local_bash") {
    return projectBashTask(task, context, {
      readOutputFile: (outputFile) => readTaskOutputFileSnapshot(outputFile, context),
      runningOutputPrefixBytes: TASK_OUTPUT_RUNNING_BASH_PREFIX_BYTES,
    });
  }
  if (task.type === "local_agent") {
    return projectAgentTask(task, context);
  }
  if (task.type === "local_dynamic_workflow") {
    return projectDynamicWorkflowTask(task, context);
  }

  const output = await readTaskOutputFile(task.outputFile, context);
  return {
    task_id: task.taskId,
    task_type: task.type,
    status: task.status,
    description: task.description,
    output,
    ...(task.outputFile ? { outputFile: task.outputFile } : {}),
  };
}

/**
 * workflow run 的投影优先读取终态更新时写入的 resultText；只读 outputFile 可能遗漏结果。
 * 文件读取保留为回退，返回形状与 {@link projectAgentTask} 一致。
 */
async function projectDynamicWorkflowTask(
  task: RuntimeTaskSnapshot,
  context: ToolExecutionContext,
): Promise<TaskOutputTask> {
  const outputFile = task.outputFile;
  const output = task.resultText ?? (await readTaskOutputFile(outputFile, context));

  return {
    task_id: task.taskId,
    task_type: task.type,
    status: task.status,
    description: task.description,
    output,
    ...(outputFile ? { outputFile } : {}),
    ...(task.resultText === undefined ? {} : { result: task.resultText }),
    ...(task.error ? { error: task.error } : {}),
  };
}

async function projectAgentTask(
  task: RuntimeTaskSnapshot,
  context: ToolExecutionContext,
): Promise<TaskOutputTask> {
  const outputFile = task.outputFile;
  const diskOutput = await readTaskOutputFile(outputFile, context);
  const completedOutput = task.output?.status === "completed" ? task.output : undefined;
  const cleanResult = completedOutput?.content.map((block) => block.text).join("\n");
  const output = cleanResult || diskOutput;

  return {
    task_id: task.taskId,
    task_type: task.type,
    status: task.status,
    description: task.description,
    output,
    ...(outputFile ? { outputFile } : {}),
    ...(task.prompt ? { prompt: task.prompt } : {}),
    ...(output ? { result: output } : {}),
    ...(task.error ? { error: task.error } : {}),
    // 运行中的 output 文件在完成时才写；进展事实让模型判断是否卡住，而不是读到空输出。
    ...(task.status === "running" ? { activity: projectAgentActivity(task) } : {}),
  };
}

function projectAgentActivity(task: RuntimeTaskSnapshot): NonNullable<TaskOutputTask["activity"]> {
  const now = Date.now();
  const lastProgressAt = task.activity?.lastProgressAt ?? task.startedAt.getTime();
  return {
    last_progress_at: new Date(lastProgressAt).toISOString(),
    no_progress_for_ms: Math.max(0, now - lastProgressAt),
    running_tools: (task.activity?.runningTools ?? []).map((tool) => ({
      tool_name: tool.toolName,
      running_for_ms: Math.max(0, now - tool.startedAt),
      ...(tool.summary ? { summary: tool.summary } : {}),
    })),
    waiting_for_permission: task.activity?.waitingForPermission ?? false,
  };
}

async function readTaskOutputFile(
  outputFile: string | undefined,
  context: ToolExecutionContext,
): Promise<string> {
  return (await readTaskOutputFileSnapshot(outputFile, context)).content;
}

async function readTaskOutputFileSnapshot(
  outputFile: string | undefined,
  context: ToolExecutionContext,
): Promise<{ available: boolean; content: string; truncated: boolean }> {
  if (!outputFile) {
    return { available: false, content: "", truncated: false };
  }

  try {
    throwIfAborted(context.abortSignal);
    const handle = await open(outputFile, "r");
    try {
      const stat = await handle.stat();
      const bytesToRead = Math.min(stat.size, TASK_OUTPUT_FILE_TAIL_BYTES);
      if (bytesToRead === 0) {
        return { available: true, content: "", truncated: false };
      }

      const buffer = Buffer.allocUnsafe(bytesToRead);
      const start = stat.size - bytesToRead;
      let bytesRead = 0;
      while (bytesRead < bytesToRead) {
        const read = await handle.read(
          buffer,
          bytesRead,
          bytesToRead - bytesRead,
          start + bytesRead,
        );
        if (read.bytesRead === 0) break;
        bytesRead += read.bytesRead;
      }
      throwIfAborted(context.abortSignal);

      const omittedBytes = stat.size - bytesRead;
      const content = buffer.subarray(0, bytesRead).toString("utf8");
      return {
        available: true,
        content:
          omittedBytes > 0
            ? `[${Math.round(omittedBytes / 1024)}KB of earlier output omitted]\n${content}`
            : content,
        truncated: omittedBytes > 0,
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (context.abortSignal.aborted) throwIfAborted(context.abortSignal);
    if (error instanceof Error && error.name === "AbortError") throw error;
    return { available: false, content: "", truncated: false };
  }
}

export function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw new DOMException("Task output wait aborted", "AbortError");
}
