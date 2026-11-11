// ============================================================
// WebSearch Tool
// ============================================================

import {
  CoreErrorType,
  WEBSEARCH_PROVIDER_NATIVE_SPEC,
  WEBSEARCH_TOOL_CONTRACT,
  WEB_SEARCH_BUDGET_EXHAUSTED_ERROR_CODE,
  WebSearchInputJsonSchema,
  WebSearchInputSchema,
  WebSearchOutputJsonSchema,
  WebSearchOutputSchema,
  createCoreError,
  runWithModelInvocationContext,
  toWebSearchProviderNativeArgs,
  type ModelStreamEvent,
  type ModelTextResult,
  type ModelToolCall,
  type ModelUsage,
  type ModelToolContract,
  type WebSearchInput,
  type WebSearchOutput,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler, ToolHandlerFailure } from "../types.js";
import { auxiliaryModelOptions } from "../../model/auxiliary-model-options.js";
import { buildWebSearchOutput, formatWebSearchModelContent } from "./websearch-results.js";
import { webSearchTraceFromContext } from "./websearch-support.js";

const WEBSEARCH_TOOL_NAME = "WebSearch";
const PROVIDER_WEBSEARCH_TOOL_NAME = "web_search";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_USES = 8;

// 当前月份不写进描述：模型从会话里的当前日期得知月份，描述保持逐字节稳定，跨月不让 tools 缓存失效。
const WEBSEARCH_PROVIDER_DESCRIPTION = [
  "Search the web. Returns result blocks with titles and URLs. US-only.",
  "",
  "- The current month is (provided in the conversation below) — use this when searching for recent information.",
  "- `allowed_domains` / `blocked_domains` filter results.",
  '- After answering from results, end with a "Sources:" list of the URLs you used as markdown links.',
].join("\n");

const webSearchHandler: ToolHandler<WebSearchInput, WebSearchOutput | ToolHandlerFailure> = async (input, context) => {
  const startedAt = Date.now();
  const model = context.model;

  if (!model) {
    throw createCoreError(CoreErrorType.ConfigurationError, "Model is required for WebSearch", {
      context: { toolCallId: context.toolCallId, toolName: WEBSEARCH_TOOL_NAME },
      recoverable: false,
    });
  }

  if (!model.properties.supportsNativeWebSearch) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "Current model does not support native WebSearch",
      {
        context: { toolCallId: context.toolCallId, toolName: WEBSEARCH_TOOL_NAME },
        recoverable: true,
      },
    );
  }

  // 动态工作流子代理的 per-ask 预算（docs: execution-engine.md「Search budget」）。
  // 成因：模型在长 turn 里退化后会一直发 WebSearch（实测一个子代理 77 分钟约 2000 次、
  // 查询退化成无意义词），而 loop 本身按设计不限工具次数，没有任何东西会让它停下。
  // 扣减放在能力校验之后、发请求之前：超额的调用不产生任何内部模型请求；端口同步扣减，
  // 同一批并行调用计数精确。回失败而非正常结果：输出 schema 没有承载拒绝的字段，
  // 且 tool_usage 的 error 计数让预算命中无需新事件即可观测。
  const charge = context.webSearchBudget?.charge();
  if (charge?.kind === "exhausted") {
    return {
      result: false,
      errorCode: WEB_SEARCH_BUDGET_EXHAUSTED_ERROR_CODE,
      message: charge.message,
    } satisfies ToolHandlerFailure;
  }

  const request: Parameters<typeof model.streamText>[0] = {
    messages: [
      {
        role: "system",
        content: "You are an assistant for performing a web search tool use.",
      },
      {
        role: "user",
        content: `Perform a web search for the query: ${input.query}`,
      },
    ],
    tools: [createProviderNativeWebSearchContract(input)],
    // BigModel 的 Anthropic 兼容端点会拒绝 named forced web_search tool_choice（1210）。
    // 这里保持自动选择，依靠单工具请求和 prompt 触发 provider-native 搜索。
    options: {
      ...auxiliaryModelOptions(model),
      maxOutputTokens: Math.min(4096, model.optionSpecs.maxOutputTokens.max),
    },
    abortSignal: context.abortSignal,
  };

  // BigModel Anthropic 兼容端点的非流式 JSON 会把 provider 内部
  // web_search 结果返回为 assistant-side 裸 tool_result，AI SDK 会在 schema
  // 校验阶段抛 Invalid JSON response。走流式可复用现有 SSE compat。
  const result = await collectWebSearchStreamResult({
    events: runWithModelInvocationContext(
      {
        metadata: {
          traceId: context.traceId,
          sessionId: context.sessionId,
          turnId: context.turnId,
          toolCallId: context.toolCallId,
          toolName: WEBSEARCH_TOOL_NAME,
          querySource: "web_search_tool",
        },
        modelCall: { operation: "web_search" },
        // statusSink 不在这里设：执行器交出的 context.model 已带默认会话事件出口。
        traceContext: webSearchTraceFromContext(context),
      },
      () => model.streamText(request),
    ),
  });

  return buildWebSearchOutput(input, result, startedAt);
};

export const webSearchToolEntry: ToolEntry = {
  ...WEBSEARCH_TOOL_CONTRACT,
  providerNative: undefined,
  metadata: {
    name: WEBSEARCH_TOOL_NAME,
    searchHint: "search the web for current information",
    description: WEBSEARCH_PROVIDER_DESCRIPTION,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxOutputBytes: 20_000,
    sideEffectScope: "network",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: webSearchHandler as ToolHandler,
  formatModelContent: formatWebSearchModelContent,
  inputSchema: WebSearchInputJsonSchema,
  outputSchema: WebSearchOutputJsonSchema,
  runtimeInputSchema: WebSearchInputSchema,
  runtimeOutputSchema: WebSearchOutputSchema,
};

function createProviderNativeWebSearchContract(input: WebSearchInput): ModelToolContract {
  return {
    name: PROVIDER_WEBSEARCH_TOOL_NAME,
    capability: "web_search",
    description: "Provider-native web search used internally by the WebSearch tool",
    executionMode: "providerNative",
    providerNative: {
      ...WEBSEARCH_PROVIDER_NATIVE_SPEC,
      args: toWebSearchProviderNativeArgs(input, {
        maxUses: DEFAULT_MAX_USES,
      }),
    },
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    },
    outputSchema: { type: "object" },
  };
}

async function collectWebSearchStreamResult(input: {
  events: AsyncIterable<ModelStreamEvent>;
}): Promise<ModelTextResult> {
  let text = "";
  let finishReason = "unknown";
  let providerMetadata: Record<string, unknown> | undefined;
  let usage: ModelUsage = {};
  const toolCalls: ModelToolCall[] = [];

  for await (const event of input.events) {
    switch (event.type) {
      case "text_delta":
        text += event.text;
        break;
      case "tool_call":
        toolCalls.push(event.toolCall);
        break;
      case "finish":
        finishReason = event.finishReason;
        usage = event.usage;
        providerMetadata = event.providerMetadata;
        break;
      case "error":
        throw normalizeStreamError(event.error);
    }
  }

  return {
    finishReason,
    providerMetadata,
    text,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage,
  };
}

function normalizeStreamError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return createCoreError(CoreErrorType.ModelError, "WebSearch stream failed", {
    context: { error },
    recoverable: true,
  });
}
