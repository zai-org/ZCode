import { describe, expect, it } from "vitest";
import {
  CoreErrorType,
  createRootTraceContext,
  createSessionId,
  createToolCallId,
  createTurnId,
} from "@zcode/contracts";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import { createToolExecutor } from "../src/tool/executor.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { modelContentForToolResult } from "../src/runtime/helpers/tool-result.js";
import type { ToolEntry, ToolExecutionContext } from "../src/tool/types.js";

/**
 * 规格 0.15：调用在 handler 返回之前超时或取消时，工具可以把对账说明追加到错误文本。
 *
 * 会话控制的写工具靠回执把请求身份交给模型；可回执送不回来时，模型只看到 "timed out"，拿不到
 * 身份就只能另起新请求，于是重复建会话或重复发消息。执行器在这两种错误上调用
 * `describeUnsettledCall`，让身份随同一条错误送到模型手里。
 */
const NOTE = "requestId=R1; pass it as retryOf to retry this exact request.";

function entry(input: {
  name: string;
  timeoutMs: number;
  handler: (context: ToolExecutionContext) => Promise<unknown>;
  describeUnsettledCall?: ToolEntry["describeUnsettledCall"];
}): ToolEntry {
  return {
    capability: "test",
    metadata: {
      name: input.name,
      description: "test tool",
      readOnly: false,
      destructive: false,
      concurrentSafe: false,
      timeoutMs: input.timeoutMs,
      maxOutputBytes: 1000,
      sideEffectScope: "none",
      riskLevel: "low",
      needsApproval: false,
    },
    handler: (_input: unknown, context: ToolExecutionContext) => input.handler(context),
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "object", properties: {} },
    ...(input.describeUnsettledCall ? { describeUnsettledCall: input.describeUnsettledCall } : {}),
  } as unknown as ToolEntry;
}

/** 永不返回的 handler：只有超时或取消能结束它。 */
const hang = (context: ToolExecutionContext) =>
  new Promise<never>((_resolve, reject) => {
    context.abortSignal.addEventListener("abort", () => reject(context.abortSignal.reason));
  });

async function run(tool: ToolEntry, options: { signal?: AbortSignal } = {}) {
  const sessionId = createSessionId("unsettled-call");
  const turnId = createTurnId("unsettled-call");
  const traceContext = createRootTraceContext({ sessionId, turnId });
  const registry = createToolRegistry();
  registry.register(tool);
  const executor = createToolExecutor({
    emitEvent: async () => undefined,
    permissionService: new PermissionService(defaultPermissionConfig),
    registry,
    sessionId,
    turnId,
    traceContext,
  });
  const callId = createToolCallId("unsettled-call");
  const result = await executor.execute(
    { id: callId, input: { probe: true }, name: tool.metadata.name },
    { traceContext, ...options },
  );
  return { result, callId, text: String(modelContentForToolResult(result)) };
}

describe("describeUnsettledCall", () => {
  it("appends the note to a timeout and passes the call's input and id", async () => {
    const seen: unknown[] = [];
    const { result, callId, text } = await run(
      entry({
        name: "TimesOut",
        timeoutMs: 20,
        handler: hang,
        describeUnsettledCall: (input, toolCallId) => {
          seen.push({ input, toolCallId });
          return NOTE;
        },
      }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.type).toBe(CoreErrorType.ToolTimeout);
    expect(text).toContain("timed out after 20ms");
    expect(text).toContain(NOTE);
    expect(seen).toEqual([{ input: { probe: true }, toolCallId: callId }]);
  });

  it("appends the note when the call is cancelled mid-execution", async () => {
    const controller = new AbortController();
    const pending = run(
      entry({
        name: "Cancelled",
        timeoutMs: 60_000,
        handler: (context) => {
          // handler 已在执行（请求可能已提交）之后才取消——这正是需要身份的时刻。
          setTimeout(() => controller.abort(), 10);
          return hang(context);
        },
        describeUnsettledCall: () => NOTE,
      }),
      { signal: controller.signal },
    );
    const { result, text } = await pending;
    expect(result.success).toBe(false);
    expect(result.error?.type).toBe(CoreErrorType.ToolCancelled);
    expect(text).toContain(NOTE);
  });

  it("leaves a timeout untouched for tools that do not declare it", async () => {
    const { result, text } = await run(
      entry({ name: "PlainTimeout", timeoutMs: 20, handler: hang }),
    );
    expect(result.error?.type).toBe(CoreErrorType.ToolTimeout);
    expect(text).not.toContain("requestId");
  });

  // 只作用于超时与取消：handler 自己抛出的错误发生在它能返回结构化结果的位置，
  // 会话控制把提交之后的异常转成了带 requestId 的回执，这里不该再追加一遍。
  it("does not touch errors the handler throws itself", async () => {
    const { result, text } = await run(
      entry({
        name: "Throws",
        timeoutMs: 60_000,
        handler: async () => {
          throw new Error("owner refused");
        },
        describeUnsettledCall: () => NOTE,
      }),
    );
    expect(result.success).toBe(false);
    expect(text).toContain("owner refused");
    expect(text).not.toContain(NOTE);
  });

  it("skips the note when the tool returns nothing to add", async () => {
    const { text } = await run(
      entry({
        name: "NothingToAdd",
        timeoutMs: 20,
        handler: hang,
        describeUnsettledCall: () => undefined,
      }),
    );
    expect(text).toContain("timed out after 20ms");
    expect(text).not.toContain("requestId");
  });
});
