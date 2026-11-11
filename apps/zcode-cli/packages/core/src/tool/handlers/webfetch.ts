// ============================================================
// WebFetch Tool Handler
// ============================================================

import { STATUS_CODES } from "node:http";
import {
  WebFetchInputJsonSchema,
  WebFetchInputSchema,
  WebFetchOutputJsonSchema,
  WebFetchOutputSchema,
  type WebFetchInput,
  type WebFetchOutput,
} from "@zcode/contracts";
import type { ToolEntry, ToolExecutionContext, ToolHandler } from "../types.js";
import {
  clearWebFetchCacheForTests as clearWebFetchContentCacheForTests,
  getWebFetchCache,
  putWebFetchCache,
} from "./webfetch-cache.js";
import {
  DEFAULT_WEBFETCH_TIMEOUT_MS,
  MAX_WEBFETCH_MODEL_BYTES,
  WEBFETCH_TOOL_NAME,
} from "./webfetch-constants.js";
import { fetchAndExtractContent } from "./webfetch-network.js";
import { processFetchedContent } from "./webfetch-processing.js";
import type {
  FetchAndExtractContentResult,
  HttpErrorFetchContent,
  RedirectFetchContent,
} from "./webfetch-types.js";
import { isWebFetchPreapprovedUrl } from "../webfetch-preapproved.js";
import { normalizeWebFetchUrl } from "./webfetch-url.js";

export function clearWebFetchCacheForTests(): void {
  clearWebFetchContentCacheForTests();
}

const WEBFETCH_DESCRIPTION = [
  "Fetches a URL, converts the page to markdown, and answers `prompt` against it using a small fast model.",
  "",
  "- Fails on authenticated/private URLs — use an authenticated MCP tool or `gh` for those instead.",
  // URL 校验拒绝单段主机名（见 webfetch-url.ts assertPublicHost），这一句与实际行为一致。
  "- Fails on localhost and other hostnames without a dot; for a local server, use curl via Bash.",
  "- HTTP is upgraded to HTTPS. Cross-host redirects are returned to you rather than followed; call again with the redirect URL.",
  "- Responses are cached for 15 minutes per URL.",
].join("\n");

interface FreshWebFetchContent {
  fetched: FetchAndExtractContentResult;
  preapprovedUrl: boolean;
}

export const webFetchHandler: ToolHandler = async (input, context) => {
  const parsed = WebFetchInputSchema.parse(input) as WebFetchInput;
  const startedAt = Date.now();
  const normalizedUrl = normalizeWebFetchUrl(parsed.url);
  const cacheKey = parsed.url;
  const cached = getWebFetchCache(cacheKey);
  const content =
    cached === undefined
      ? await fetchFreshContent({
          context,
          originalUrl: cacheKey,
          url: normalizedUrl,
        })
      : {
          fetched: cached,
          preapprovedUrl: isWebFetchPreapprovedUrl(parsed.url),
        };
  const fetched = content.fetched;

  if (isTerminalFetchContent(fetched)) {
    return formatTerminalOutput(parsed, fetched, Math.max(0, Date.now() - startedAt));
  }

  if (cached === undefined) {
    putWebFetchCache(cacheKey, fetched);
  }

  const processing = await processFetchedContent(parsed, fetched, context, {
    preapprovedUrl: content.preapprovedUrl,
  });
  const durationMs = Math.max(0, Date.now() - startedAt);

  return {
    url: parsed.url,
    finalUrl: fetched.finalUrl,
    status: fetched.status,
    statusText: httpStatusText(fetched.status, fetched.statusText),
    contentType: fetched.contentType,
    bytes: fetched.bytes,
    durationMs,
    result: processing.result,
    cacheHit: cached !== undefined,
    redirects: fetched.redirects,
    artifactUri: fetched.artifactUri,
    artifactPath: fetched.artifactPath,
    truncated: processing.truncated,
  } satisfies WebFetchOutput;
};

async function fetchFreshContent(options: {
  context: ToolExecutionContext;
  originalUrl: string;
  url: URL;
}): Promise<FreshWebFetchContent> {
  const fetched = await fetchAndExtractContent({
    context: options.context,
    originalUrl: options.originalUrl,
    url: options.url,
  });
  return {
    fetched,
    preapprovedUrl: isWebFetchPreapprovedUrl(options.originalUrl),
  };
}

function formatTerminalOutput(
  input: WebFetchInput,
  fetched: HttpErrorFetchContent | RedirectFetchContent,
  durationMs: number,
): WebFetchOutput {
  if (fetched.type === "redirect") {
    return formatRedirectOutput(input, fetched, durationMs);
  }
  return formatHttpErrorOutput(fetched, durationMs);
}

function formatRedirectOutput(
  input: WebFetchInput,
  redirect: RedirectFetchContent,
  durationMs: number,
): WebFetchOutput {
  const statusText = httpStatusText(redirect.status, redirect.statusText);
  const result = [
    "REDIRECT DETECTED: The URL redirects to a different host.",
    "",
    `Original URL: ${redirect.originalUrl}`,
    `Redirect URL: ${redirect.redirectUrl}`,
    `Status: ${redirect.status} ${statusText}`,
    "",
    "To complete your request, I need to fetch content from the redirected URL. Please use WebFetch again with these parameters:",
    `- url: "${redirect.redirectUrl}"`,
    `- prompt: "${input.prompt}"`,
  ].join("\n");

  return {
    url: input.url,
    finalUrl: redirect.originalUrl,
    status: redirect.status,
    statusText,
    contentType: "text/plain",
    bytes: Buffer.byteLength(result, "utf8"),
    durationMs,
    result,
    cacheHit: false,
    redirects: redirect.redirects,
    truncated: false,
  };
}

function formatHttpErrorOutput(error: HttpErrorFetchContent, durationMs: number): WebFetchOutput {
  const statusText = httpStatusText(error.status, error.statusText);
  const retryAfter = error.retryAfter ? `\nRetry-After: ${error.retryAfter}` : "";
  const result = [
    `The server returned HTTP ${error.status} ${statusText}.${retryAfter}`,
    "",
    "The response body was not retrieved. If this URL requires authentication, use an authenticated tool (e.g. `gh` for GitHub, or an MCP-provided fetch tool) instead of WebFetch.",
  ].join("\n");

  return {
    url: error.originalUrl,
    finalUrl: error.finalUrl,
    status: error.status,
    statusText,
    contentType: "text/plain",
    bytes: 0,
    durationMs,
    result,
    cacheHit: false,
    redirects: error.redirects,
    truncated: false,
  };
}

function httpStatusText(status: number, statusText: string): string {
  return statusText.trim() || STATUS_CODES[status] || "Unknown Status";
}

function isTerminalFetchContent(
  value: FetchAndExtractContentResult,
): value is HttpErrorFetchContent | RedirectFetchContent {
  return "type" in value;
}

export const webFetchToolEntry: ToolEntry = {
  capability:
    "Fetch a public URL, convert readable content to markdown, and answer a prompt from it",
  metadata: {
    name: WEBFETCH_TOOL_NAME,
    searchHint: "fetch and extract content from a URL",
    description: WEBFETCH_DESCRIPTION,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: DEFAULT_WEBFETCH_TIMEOUT_MS,
    maxOutputBytes: MAX_WEBFETCH_MODEL_BYTES,
    sideEffectScope: "network",
    riskLevel: "medium",
    needsApproval: true,
  },
  handler: webFetchHandler,
  formatModelContent: formatWebFetchModelContent,
  inputSchema: WebFetchInputJsonSchema,
  outputSchema: WebFetchOutputJsonSchema,
  runtimeInputSchema: WebFetchInputSchema,
  runtimeOutputSchema: WebFetchOutputSchema,
  permission: {
    permission: "webfetch",
    reason: "WebFetch performs an outbound network GET request to the requested domain",
    riskLevel: "medium",
    sideEffectScope: "network",
    needsApproval: true,
    patternSources: ["network"],
    alwaysAllowPatternSources: ["network"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_WEBFETCH_MODEL_BYTES,
    maxModelBytes: MAX_WEBFETCH_MODEL_BYTES,
    strategy: "artifact",
    preview: {
      maxBytes: MAX_WEBFETCH_MODEL_BYTES,
      direction: "head",
    },
    artifact: {
      enabled: true,
      retention: "session",
    },
  },
  timeout: {
    defaultMs: DEFAULT_WEBFETCH_TIMEOUT_MS,
    maxMs: DEFAULT_WEBFETCH_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "bestEffort",
    userVisibleMessage: "WebFetch was cancelled before the page could be processed",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function formatWebFetchModelContent(output: unknown): string {
  if (isWebFetchOutput(output)) {
    return output.result;
  }
  return typeof output === "string" ? output : (JSON.stringify(output) ?? "");
}

function isWebFetchOutput(value: unknown): value is WebFetchOutput {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as WebFetchOutput).result === "string" &&
    typeof (value as WebFetchOutput).finalUrl === "string"
  );
}
