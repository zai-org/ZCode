// ============================================================
// WebSearch Tool - provider-visible wrapper and internal provider-native schema definitions
// ============================================================

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";
import type { ProviderNativeToolSpec, ToolContractDeclaration } from "./contract.js";

const DEFAULT_MAX_USES = 8;
const MAX_USES = 8;

const WebSearchProviderInputSchema = z
  .object({
    query: z.string().min(2).describe("The search query to use"),
    allowed_domains: z
      .array(z.string())
      .optional()
      .describe("Only include search results from these domains"),
    blocked_domains: z
      .array(z.string())
      .optional()
      .describe("Never include search results from these domains"),
  })
  .strict();

// 两种域名不能同时给出：由 WebSearch validateInput 检查（13-websearch.md），不写成 refine——
// runtime schema 失败会先返回 InputValidationError，固定文字会变成 JSON。
export const WebSearchInputSchema = WebSearchProviderInputSchema.extend({
  maxUses: z
    .number()
    .int()
    .min(1)
    .max(MAX_USES)
    .optional()
    .describe(
      `Maximum provider-native searches in the internal web_search request, default ${DEFAULT_MAX_USES}`,
    ),
}).strict();

export type WebSearchInput = z.infer<typeof WebSearchInputSchema>;

export const WebSearchInputJsonSchema = toToolJsonSchema(WebSearchProviderInputSchema);

export interface WebSearchProviderNativeArgs extends Record<string, unknown> {
  allowedDomains?: string[];
  blockedDomains?: string[];
  maxUses?: number;
}

export function toWebSearchProviderNativeArgs(
  input: WebSearchInput,
  defaults: { maxUses: number },
): WebSearchProviderNativeArgs {
  return {
    allowedDomains: input.allowed_domains,
    blockedDomains: input.blocked_domains,
    maxUses: input.maxUses ?? defaults.maxUses,
  };
}

export const WebSearchSourceSchema = z
  .object({
    title: z.string().optional(),
    url: z.string().min(1),
  })
  .strict();

export type WebSearchSource = z.infer<typeof WebSearchSourceSchema>;

export const WebSearchResultItemSchema = z
  .object({
    title: z.string().optional(),
    url: z.string().min(1),
    pageAge: z.string().optional(),
  })
  .strict();

export type WebSearchResultItem = z.infer<typeof WebSearchResultItemSchema>;

const WebSearchModelUsageSchema = z
  .object({
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    totalTokens: z.number().optional(),
    cacheReadTokens: z.number().optional(),
    cacheWriteTokens: z.number().optional(),
    reasoningTokens: z.number().optional(),
    serverToolUse: z
      .object({
        webSearchRequests: z.number().optional(),
        webFetchRequests: z.number().optional(),
      })
      .optional(),
  })
  .strict();

export const WebSearchOutputSchema = z
  .object({
    query: z.string(),
    results: z.array(WebSearchResultItemSchema),
    sources: z.array(WebSearchSourceSchema),
    summary: z.string().optional(),
    durationMs: z.number().nonnegative(),
    webSearchRequests: z.number().int().nonnegative().optional(),
    modelUsage: WebSearchModelUsageSchema.optional(),
  })
  .strict();

export type WebSearchOutput = z.infer<typeof WebSearchOutputSchema>;

export const WebSearchOutputJsonSchema = toToolJsonSchema(WebSearchOutputSchema);

export const WEBSEARCH_PROVIDER_NATIVE_SPEC: ProviderNativeToolSpec = {
  kind: "provider_native",
  logicalName: "WebSearch",
  providerToolName: "web_search",
  fallback: "disabled",
};

export const WEBSEARCH_TOOL_CONTRACT: ToolContractDeclaration = {
  capability: "web_search",
  executionMode: "client",
  inputSchema: WebSearchInputJsonSchema,
  outputSchema: WebSearchOutputJsonSchema,
  permission: {
    permission: "websearch",
    reason:
      "WebSearch performs read-only provider-native web searches through an internal model request",
    riskLevel: "low",
    sideEffectScope: "network",
    needsApproval: false,
    patternSources: ["toolName", "input", "network"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: 10_000,
    maxModelBytes: 20_000,
    strategy: "truncate",
    preview: {
      maxLines: 30,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: 60_000,
    maxMs: 120_000,
    allowCallOverride: true,
  },
  cancellation: {
    supported: true,
    cleanup: "bestEffort",
    userVisibleMessage: "WebSearch was cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "full",
    recordOutput: "summary",
  },
};
