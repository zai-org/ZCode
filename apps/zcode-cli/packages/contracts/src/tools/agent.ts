// ============================================================
// Agent Tool - Subagent orchestration tool
// ============================================================
// 支持基于配置的子代理和异步启动。

import { z } from "zod";
import type { ToolCallId, TraceId } from "../interfaces/shared.js";
import type { ModelUsage } from "../model/index.js";
import { toToolJsonSchema } from "./json-schema.js";

export const AgentType = {
  GeneralPurpose: "general-purpose",
  Explore: "Explore",
} as const;

export type AgentType = string;

export const AgentInputSchema = z.object({
  description: z.string().describe("A short (3-5 word) description of the task"),
  prompt: z.string().describe("The task for the agent to perform"),
  subagent_type: z
    .string()
    .optional()
    .describe("The type of specialized agent to use for this task"),
  // subagent 模型由 Settings / Markdown profile 统一决定；若把调用级
  // model 暴露给父模型，历史 tool call 会持续生成旧 override 并覆盖当前配置。
  run_in_background: z
    .boolean()
    .optional()
    .describe(
      "Set to true to run this agent in the background. You will be notified when it completes.",
    ),
});

export type AgentInput = z.infer<typeof AgentInputSchema>;

export const AgentInputJsonSchema = toToolJsonSchema(AgentInputSchema);

export interface AgentTextContentBlock {
  type: "text";
  text: string;
}

export interface AgentCompletedOutput {
  status: "completed";
  agentId: string;
  agentType: AgentType;
  description: string;
  prompt: string;
  content: AgentTextContentBlock[];
  totalToolUseCount: number;
  totalDurationMs: number;
  totalTokens?: number;
  usage?: ModelUsage;
}

export interface AgentBackgroundedOutput {
  status: "async_launched";
  isAsync: true;
  agentId: string;
  agentType: AgentType;
  description: string;
  prompt: string;
  childSessionId: string;
  backgroundTaskId: string;
  outputFile: string;
  canReadOutputFile: boolean;
}

export type AgentOutput = AgentCompletedOutput | AgentBackgroundedOutput;

export const AgentTextContentBlockSchema = z
  .object({
    type: z.literal("text"),
    text: z.string(),
  })
  .strict();

export const AgentCompletedOutputSchema = z
  .object({
    status: z.literal("completed"),
    agentId: z.string(),
    agentType: z.string(),
    description: z.string(),
    prompt: z.string(),
    content: z.array(AgentTextContentBlockSchema),
    totalToolUseCount: z.number().int().nonnegative(),
    totalDurationMs: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative().optional(),
    usage: z.record(z.unknown()).optional(),
  })
  .strict();

export const AgentBackgroundedOutputSchema = z
  .object({
    status: z.literal("async_launched"),
    isAsync: z.literal(true),
    agentId: z.string(),
    agentType: z.string(),
    description: z.string(),
    prompt: z.string(),
    childSessionId: z.string(),
    backgroundTaskId: z.string(),
    outputFile: z.string(),
    canReadOutputFile: z.boolean(),
  })
  .strict();

export const AgentOutputSchema = z.union([
  AgentCompletedOutputSchema,
  AgentBackgroundedOutputSchema,
]);

export const AgentOutputJsonSchema = toToolJsonSchema(AgentOutputSchema);

/**
 * 同步子代理开始运行后失败时，runner 交给 Agent 工具、只给模型的交接数据。
 * 挂在抛出的错误上且不可枚举，不放进 `context`：日志序列化 `context`，UI 摘要读 cause 链，
 * 两边都不会带上部分报告。
 */
export const AgentFailureHandbackSchema = z
  .object({
    agentId: z.string(),
    report: z.string().optional(),
    totalToolUseCount: z.number().int().nonnegative(),
    totalDurationMs: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative().optional(),
  })
  .strict();

export type AgentFailureHandback = z.infer<typeof AgentFailureHandbackSchema>;

const AGENT_FAILURE_HANDBACK_PROPERTY = "agentFailureHandback";

/**
 * 在原错误上挂交接数据，返回同一个对象。
 * 修复原因：曾用 `Object.create` + `getOwnPropertyDescriptors` 复制错误再挂数据。Node 的 `stack`
 * 是读原对象内部槽的 accessor，复制品上读到 undefined，`tool_call_error` 与结果里的 stack 随之丢失。
 * 现在只加一个不可枚举属性，不改任何已有字段，错误身份与 stack 不变；对象不可扩展时不挂。
 */
export function withAgentFailureHandback<T extends Error>(
  error: T,
  handback: AgentFailureHandback,
): T {
  Reflect.defineProperty(error, AGENT_FAILURE_HANDBACK_PROPERTY, {
    configurable: true,
    enumerable: false,
    value: handback,
  });
  return error;
}

export function readAgentFailureHandback(error: unknown): AgentFailureHandback | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const parsed = AgentFailureHandbackSchema.safeParse(
    (error as Record<string, unknown>)[AGENT_FAILURE_HANDBACK_PROPERTY],
  );
  return parsed.success ? parsed.data : undefined;
}

export interface AgentToolCall {
  id: ToolCallId;
  name: "Agent";
  input: AgentInput;
  traceId: TraceId;
  startedAt: Date;
}

export interface AgentToolResult {
  toolCallId: ToolCallId;
  output: AgentOutput;
  traceId: TraceId;
  durationMs: number;
}

export const AgentErrorCode = {
  SUBAGENT_UNAVAILABLE: "agent_subagent_unavailable",
  BACKGROUND_UNAVAILABLE: "agent_background_unavailable",
  UNKNOWN_AGENT_TYPE: "agent_unknown_type",
  CHILD_RUNTIME_FAILED: "agent_child_runtime_failed",
} as const;

export type AgentErrorCode = (typeof AgentErrorCode)[keyof typeof AgentErrorCode];
