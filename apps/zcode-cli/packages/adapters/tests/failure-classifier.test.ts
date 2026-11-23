import { APICallError } from "ai";
import { describe, expect, it } from "vitest";
import { classifyModelFailure, inspectProviderFailure } from "../src/model/failure-classifier.js";
import { detectProviderBusinessFinishError } from "../src/model/provider-finish-business-error.js";
import { ProviderBusinessError } from "../src/model/model-execution.js";

const MAXIMUM_CONTEXT_LENGTH_ERROR =
  "This model's maximum context length is 128000 tokens. However, you requested 64000 output tokens and your prompt contains at least 64001 input tokens, for a total of at least 128001 tokens. Please reduce the length of the input prompt or the number of requested output tokens.";
const AZURE_CONTEXT_LENGTH_ERROR =
  "This model's maximum context length is 300000 tokens. However, your messages resulted in 350564 tokens (100 in the messages, 350464 in the functions). Please reduce the length of the messages or functions.";
const GEMINI_CONTEXT_LENGTH_ERROR =
  "The input token count (131137) exceeds the maximum number of tokens allowed (131072).";

describe("classifyModelFailure context length errors", () => {
  it("maps the reported maximum context length message to context exceeded", () => {
    expect(classifyModelFailure(new Error(MAXIMUM_CONTEXT_LENGTH_ERROR))).toMatchObject({
      code: "model_context_exceeded",
      reason: "context_exceeded",
      retryable: false,
    });
  });

  it("maps Azure's official maximum context length message without relying on its code", () => {
    expect(classifyModelFailure(new Error(AZURE_CONTEXT_LENGTH_ERROR))).toMatchObject({
      code: "model_context_exceeded",
      reason: "context_exceeded",
      retryable: false,
    });
  });

  it("maps a standard 400 response body to context exceeded", () => {
    const error = new APICallError({
      message: "Bad Request",
      responseBody: JSON.stringify({
        error: {
          code: "invalid_request_error",
          message: MAXIMUM_CONTEXT_LENGTH_ERROR,
          type: "invalid_request_error",
        },
      }),
      statusCode: 400,
    });

    expect(classifyModelFailure(error)).toMatchObject({
      code: "model_context_exceeded",
      reason: "context_exceeded",
      retryable: false,
      statusCode: 400,
    });
  });

  it("reads a standard context length response body from an Error cause", () => {
    const error = new Error("Turn execution failed", {
      cause: new APICallError({
        message: "Bad Request",
        responseBody: JSON.stringify({
          error: {
            code: "invalid_request_error",
            message: MAXIMUM_CONTEXT_LENGTH_ERROR,
          },
        }),
        statusCode: 400,
      }),
    });

    expect(classifyModelFailure(error)).toMatchObject({
      code: "model_context_exceeded",
      reason: "context_exceeded",
      retryable: false,
      statusCode: 400,
    });
  });

  it.each([
    "context_length_exceeded",
    "context_window_exceeded",
    "model_context_exceeded",
    "model_context_window_exceeded",
  ])("reads the context code %s from a standard response body", (code) => {
    const error = new APICallError({
      message: "Bad Request",
      responseBody: JSON.stringify({
        error: {
          code,
          message: AZURE_CONTEXT_LENGTH_ERROR,
          type: "invalid_request_error",
        },
      }),
      statusCode: 400,
    });

    expect(classifyModelFailure(error)).toMatchObject({
      code: "model_context_exceeded",
      reason: "context_exceeded",
      retryable: false,
      statusCode: 400,
    });
  });

  it("recognizes Anthropic's official prompt-too-long response", () => {
    const error = new APICallError({
      message: "Bad Request",
      responseBody: JSON.stringify({
        error: {
          message: "prompt is too long",
          type: "invalid_request_error",
        },
        type: "error",
      }),
      statusCode: 400,
    });

    expect(classifyModelFailure(error)).toMatchObject({
      code: "model_context_exceeded",
      reason: "context_exceeded",
      retryable: false,
      statusCode: 400,
    });
  });

  it("recognizes the Gemini API error captured in Google's official CLI repository", () => {
    const error = new APICallError({
      message: "Bad Request",
      responseBody: JSON.stringify({
        error: {
          code: 400,
          message: JSON.stringify({
            error: {
              code: 400,
              message: GEMINI_CONTEXT_LENGTH_ERROR,
              status: "INVALID_ARGUMENT",
            },
          }),
          status: "Bad Request",
        },
      }),
      statusCode: 400,
    });

    expect(classifyModelFailure(error)).toMatchObject({
      code: "model_context_exceeded",
      reason: "context_exceeded",
      retryable: false,
      statusCode: 400,
    });
  });

  it.each([
    "Range of input length should be [1, 131072]",
    "Total message token length exceed model limit (10000000 tokens).",
  ])("recognizes Alibaba Cloud's official context error: %s", (message) => {
    const error = new APICallError({
      message: "Bad Request",
      responseBody: JSON.stringify({
        code: "InvalidParameter",
        message,
      }),
      statusCode: 400,
    });

    expect(classifyModelFailure(error)).toMatchObject({
      code: "model_context_exceeded",
      reason: "context_exceeded",
      retryable: false,
      statusCode: 400,
    });
  });

  it.each([
    {
      name: "Azure's string length validation",
      responseBody: {
        error: {
          code: "string_above_max_length",
          message:
            "Invalid 'tools[0].function.description': string too long. Expected a string with maximum length 1048576, but got a string with length 2778531 instead.",
          type: "invalid_request_error",
        },
      },
      statusCode: 400,
    },
    {
      name: "Alibaba Cloud's max_tokens range validation",
      responseBody: {
        code: "InvalidParameter",
        message: "Range of max_tokens should be [1, 32768]",
      },
      statusCode: 400,
    },
    {
      name: "Mistral's generic bad request",
      responseBody: {
        message: "Bad request",
        type: "invalid_request_error",
      },
      statusCode: 400,
    },
    {
      name: "DeepSeek's generic invalid parameters response",
      responseBody: {
        message: "Invalid parameters",
      },
      statusCode: 422,
    },
    {
      name: "MiniMax's ambiguous max_tokens limit",
      responseBody: {
        base_resp: {
          status_code: 1039,
          status_msg: "Token limit, please adjust max_tokens.",
        },
      },
      statusCode: 400,
    },
  ])("does not over-classify $name as context exceeded", ({ responseBody, statusCode }) => {
    const error = new APICallError({
      message: statusCode === 422 ? "Unprocessable Entity" : "Bad Request",
      responseBody: JSON.stringify(responseBody),
      statusCode,
    });

    expect(classifyModelFailure(error)).toMatchObject({
      code: "invalid_model_request",
      reason: "invalid_request",
      retryable: false,
      statusCode,
    });
  });
});

describe("classifyModelFailure TLS errors", () => {
  it.each([
    Object.assign(new Error("request failed"), { code: "MODEL_TLS_VALIDATION_FAILED" }),
    Object.assign(new Error("request failed"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }),
    Object.assign(new Error("request failed"), { code: "SELF_SIGNED_CERT_IN_CHAIN" }),
    Object.assign(new Error("request failed"), { code: "CERT_HAS_EXPIRED" }),
  ])("maps a known TLS failure to tls_error", (error) => {
    expect(classifyModelFailure(error)).toMatchObject({
      code: "model_request_failed",
      reason: "tls_error",
      retryable: false,
    });
  });

  it("does not classify generic certificate prose as a TLS failure", () => {
    expect(classifyModelFailure(new Error("certificate setup is incomplete"))).toMatchObject({
      reason: "unknown",
    });
  });

  it("does not infer TLS failure state from self-signed certificate prose", () => {
    expect(
      classifyModelFailure(new Error("self-signed certificate in certificate chain")),
    ).toMatchObject({
      reason: "unknown",
    });
  });
});

describe("classifyModelFailure provider business codes", () => {
  it("maps Start Plan concurrency failures to non-retryable rate limits", () => {
    for (const code of ["3008", "3009", "3010"]) {
      const failure = classifyModelFailure(
        new ProviderBusinessError({
          providerCode: code,
          providerId: "account:zai-start-plan",
          providerKind: "openai-compatible",
          providerMessage: "当前系统繁忙，请稍后再试或升级账户。",
          responseBodySummary: {
            code: Number(code),
            msg: "当前系统繁忙，请稍后再试或升级账户。",
          },
          responseStatus: 429,
          statusCode: 429,
        }),
      );

      expect(failure).toMatchObject({
        code: "model_rate_limited",
        message: "当前系统繁忙，请稍后再试或升级账户。",
        reason: "rate_limited",
        retryReason: "rate_limited",
        retryable: false,
        statusCode: 429,
      });
    }
  });

  it("maps upstream 2007 failures to retryable server errors", () => {
    const failure = classifyModelFailure(
      new ProviderBusinessError({
        providerCode: "2007",
        providerId: "account:zai-individual-coding-plan",
        providerKind: "openai-compatible",
        providerMessage: "upstream temporarily unavailable",
        responseBodySummary: {
          code: 2007,
          msg: "upstream temporarily unavailable",
        },
        responseStatus: 500,
        statusCode: 500,
      }),
    );

    expect(failure).toMatchObject({
      code: "model_request_failed",
      message: "upstream temporarily unavailable",
      reason: "server_error",
      retryReason: "server_error",
      retryable: true,
      statusCode: 500,
    });
  });

  it("maps HTTP 200 provider 1302 business rate limits to retryable rate limits", () => {
    const failure = classifyModelFailure(
      new ProviderBusinessError({
        providerCode: "1302",
        providerId: "account:bigmodel-individual-coding-plan",
        providerKind: "anthropic",
        providerMessage:
          "[1302][您的账户已达到速率限制，请您控制请求频率][20260605191846d4c0880887ed4c8d]",
        providerRequestId: "20260605191846d4c0880887ed4c8d",
        responseBodySummary: {
          error: {
            code: "1302",
            message:
              "[1302][您的账户已达到速率限制，请您控制请求频率][20260605191846d4c0880887ed4c8d]",
            type: "rate_limit_error",
          },
          request_id: "20260605191846d4c0880887ed4c8d",
          type: "error",
        },
        responseStatus: 200,
      }),
    );

    expect(failure).toMatchObject({
      code: "model_rate_limited",
      message: "[1302][您的账户已达到速率限制，请您控制请求频率][20260605191846d4c0880887ed4c8d]",
      reason: "rate_limited",
      retryReason: "rate_limited",
      retryable: true,
      statusCode: undefined,
    });
  });

  it("uses retry-after headers from provider business errors", () => {
    const failure = classifyModelFailure(
      new ProviderBusinessError({
        providerCode: "1305",
        providerId: "account:bigmodel-individual-coding-plan",
        providerKind: "anthropic",
        providerMessage: "平台流量限制，请稍后重试",
        responseHeaders: {
          "retry-after": "41",
        },
        responseStatus: 529,
        statusCode: 529,
      }),
    );

    expect(failure).toMatchObject({
      code: "model_rate_limited",
      reason: "rate_limited",
      retryAfterMs: 41_000,
      retryReason: "rate_limited",
      retryable: true,
      statusCode: 529,
    });
  });

  it("preserves retry-after headers from provider business error chunks", () => {
    const error = detectProviderBusinessFinishError({
      providerId: "account:bigmodel-individual-coding-plan",
      providerKind: "anthropic",
      source: {
        type: "error",
        error: new ProviderBusinessError({
          providerCode: "1305",
          providerId: "account:bigmodel-individual-coding-plan",
          providerKind: "anthropic",
          providerMessage: "平台流量限制，请稍后重试",
          responseHeaders: {
            "retry-after": "37",
            "x-should-retry": "true",
          },
          responseStatus: 529,
          statusCode: 529,
        }),
      },
    });

    expect(error).toMatchObject({
      providerCode: "1305",
      responseHeaders: {
        "retry-after": "37",
        "x-should-retry": "true",
      },
    });
    expect(classifyModelFailure(error)).toMatchObject({
      code: "model_rate_limited",
      reason: "rate_limited",
      retryAfterMs: 37_000,
      retryable: true,
      statusCode: 529,
    });
  });

  it("uses retry-after headers from ProviderBusinessError wrapped in APICallError cause", () => {
    const failure = classifyModelFailure(
      new APICallError({
        message: "Cannot connect to API: 平台流量限制，请稍后重试",
        cause: new ProviderBusinessError({
          providerCode: "1305",
          providerId: "account:bigmodel-individual-coding-plan",
          providerKind: "anthropic",
          providerMessage: "平台流量限制，请稍后重试",
          responseHeaders: {
            "retry-after": "37",
          },
          responseStatus: 529,
          statusCode: 529,
        }),
        isRetryable: true,
      }),
    );

    expect(failure).toMatchObject({
      code: "model_rate_limited",
      message: "平台流量限制，请稍后重试",
      reason: "rate_limited",
      retryAfterMs: 37_000,
      retryable: true,
      statusCode: 529,
    });
  });

  it("ignores retry-after when provider marks x-should-retry false", () => {
    const failure = classifyModelFailure(
      new ProviderBusinessError({
        providerCode: "1305",
        providerId: "account:bigmodel-individual-coding-plan",
        providerKind: "anthropic",
        providerMessage: "平台流量限制，请稍后重试",
        responseHeaders: {
          "retry-after": "41",
          "retry-after-ms": "41000",
          "x-should-retry": "false",
        },
        responseStatus: 529,
        statusCode: 529,
      }),
    );

    expect(failure).toMatchObject({
      code: "model_rate_limited",
      reason: "rate_limited",
      retryAfterMs: undefined,
      retryable: true,
      statusCode: 529,
    });
  });

  it("detects BigModel bracketed business codes from message-only SSE errors", () => {
    const error = detectProviderBusinessFinishError({
      providerId: "account:zai-individual-coding-plan",
      providerKind: "anthropic",
      source: {
        type: "error",
        error: new Error("[1302][Rate limit reached for requests][20260608211523b786be6a48924736]"),
      },
    });

    expect(error).toMatchObject({
      providerCode: "1302",
      providerMessage: "[1302][Rate limit reached for requests][20260608211523b786be6a48924736]",
    });
    expect(classifyModelFailure(error)).toMatchObject({
      code: "model_rate_limited",
      message: "[1302][Rate limit reached for requests][20260608211523b786be6a48924736]",
      reason: "rate_limited",
      retryReason: "rate_limited",
      retryable: true,
    });
  });

  it("maps BigModel transient business codes to retryable failures", () => {
    const cases = [
      {
        code: "500",
        expectedCode: "model_request_failed",
        message: "内部错误，请稍后重试",
        reason: "server_error",
        retryReason: "server_error",
      },
      {
        code: "1120",
        expectedCode: "model_request_failed",
        message: "当前账号暂时无法访问，请稍后重试",
        reason: "server_error",
        retryReason: "server_error",
      },
      {
        code: "1230",
        expectedCode: "model_request_failed",
        message: "API 调用流程异常，请稍后重试",
        reason: "server_error",
        retryReason: "server_error",
      },
      {
        code: "1234",
        expectedCode: "model_request_failed",
        message: "网络错误，请稍后重试",
        reason: "network_error",
        retryReason: "network_error",
      },
      {
        code: "1303",
        expectedCode: "model_rate_limited",
        message: "当前调用频率过高，请稍后重试",
        reason: "rate_limited",
        retryReason: "rate_limited",
      },
      {
        code: "1305",
        expectedCode: "model_rate_limited",
        message: "平台流量限制，请稍后重试",
        reason: "rate_limited",
        retryReason: "rate_limited",
      },
      {
        code: "1312",
        expectedCode: "model_request_failed",
        message: "模型访问负载过高，请稍后重试",
        reason: "provider_overloaded",
        retryReason: "provider_overloaded",
      },
    ];

    for (const item of cases) {
      const failure = classifyModelFailure(
        providerBusinessError({
          providerCode: item.code,
          providerMessage: `[${item.code}]${item.message}`,
        }),
      );

      expect(failure).toMatchObject({
        code: item.expectedCode,
        message: `[${item.code}]${item.message}`,
        reason: item.reason,
        retryReason: item.retryReason,
        retryable: true,
        statusCode: undefined,
      });
    }
  });

  it("maps BigModel 1261 prompt-too-long business code to context exceeded", () => {
    const failure = classifyModelFailure(
      providerBusinessError({
        providerCode: "1261",
        providerMessage: "Prompt 超长",
        responseStatus: 400,
        statusCode: 400,
      }),
    );

    expect(failure).toMatchObject({
      code: "model_context_exceeded",
      message: "Prompt 超长",
      reason: "context_exceeded",
      retryReason: "network_error",
      retryable: false,
      statusCode: 400,
    });
  });

  it("keeps BigModel quota, entitlement, and terminal business codes non-retryable", () => {
    const terminalCodes = ["1113", "1304", "1308", "1309", "1310", "1311", "1313"];

    for (const code of terminalCodes) {
      const failure = classifyModelFailure(
        providerBusinessError({
          providerCode: code,
          providerMessage: `[${code}] quota or entitlement terminal error`,
        }),
      );

      expect(failure).toMatchObject({
        retryable: false,
        statusCode: undefined,
      });
    }
  });

  it("does not retry HTTP 429 BigModel 1113 business code", () => {
    const failure = classifyModelFailure(
      new ProviderBusinessError({
        providerCode: "1113",
        providerId: "account:bigmodel-individual-coding-plan",
        providerKind: "anthropic",
        providerMessage: "[1113] provider terminal business error",
        responseHeaders: {
          "retry-after": "37",
          "x-should-retry": "true",
        },
        responseStatus: 429,
        statusCode: 429,
      }),
    );

    expect(failure).toMatchObject({
      code: "model_request_failed",
      reason: "unknown",
      retryable: false,
      statusCode: 429,
    });
  });

  it("does not retry HTTP 429 BigModel quota reset business codes", () => {
    const failure = classifyModelFailure(
      providerBusinessError({
        providerCode: "1308",
        providerMessage: "[1308] 已达使用上限，请等待重置时间后再试",
        responseStatus: 429,
        statusCode: 429,
      }),
    );

    expect(failure).toMatchObject({
      code: "model_rate_limited",
      reason: "rate_limited",
      retryReason: "rate_limited",
      retryable: false,
      statusCode: 429,
    });
  });

  it.each([
    { expectedRetryAfterMs: undefined, name: "missing", responseHeaders: undefined },
    {
      expectedRetryAfterMs: 30_000,
      name: "short",
      responseHeaders: { "retry-after": "30" },
    },
    {
      expectedRetryAfterMs: 16_097_000,
      name: "long",
      responseHeaders: { "retry-after": "16097" },
    },
    {
      expectedRetryAfterMs: undefined,
      name: "blocked by x-should-retry",
      responseHeaders: { "retry-after": "16097", "x-should-retry": "false" },
    },
  ])(
    "does not retry insufficient quota when retry-after is $name",
    ({ expectedRetryAfterMs, responseHeaders }) => {
      const message =
        "Your token-plan 5-hour quota has been exhausted. The quota will reset later.";
      const failure = classifyModelFailure(
        new ProviderBusinessError({
          providerCode: "insufficient_quota",
          providerId: "custom:token-plan",
          providerKind: "openai-compatible",
          providerMessage: message,
          responseHeaders,
          responseStatus: 429,
          statusCode: 429,
        }),
      );

      expect(failure).toMatchObject({
        code: "model_rate_limited",
        message,
        reason: "rate_limited",
        retryAfterMs: expectedRetryAfterMs,
        retryReason: "rate_limited",
        retryable: false,
        statusCode: 429,
      });
    },
  );

  it.each([
    "credit_balance_exhausted",
    "organization_spend_limit_exceeded",
    "project_spend_limit_exceeded",
    "organization_usage_limit_exceeded",
    "exceeded_current_quota_error",
    "1008",
    "2056",
    "20097",
    "1314",
    "1315",
    "1316",
    "1317",
    "1318",
    "1319",
    "1320",
    "1321",
  ])("does not retry official terminal quota or billing code %s", (providerCode) => {
    const failure = classifyModelFailure(
      new ProviderBusinessError({
        providerCode,
        providerId: "custom:provider",
        providerKind: "openai-compatible",
        providerMessage: `Provider returned terminal code ${providerCode}.`,
        responseStatus: 429,
        statusCode: 429,
      }),
    );

    expect(failure).toMatchObject({
      retryable: false,
      statusCode: 429,
    });
  });

  it.each([
    ["rate_limit_reached_error", "rate_limited"],
    ["rate_limit_error", "rate_limited"],
  ])("retries official transient provider code %s", (providerCode, reason) => {
    const failure = classifyModelFailure(
      new ProviderBusinessError({
        providerCode,
        providerId: "custom:provider",
        providerKind: "openai-compatible",
        providerMessage: `Provider returned transient code ${providerCode}.`,
        responseStatus: 200,
      }),
    );

    expect(failure).toMatchObject({
      reason,
      retryable: true,
    });
  });

  it.each(["engine_overloaded_error", "overloaded_error"])(
    "maps overload code %s to a retryable request failure",
    (providerCode) => {
      const failure = classifyModelFailure(
        new ProviderBusinessError({
          providerCode,
          providerId: "custom:provider",
          providerKind: "openai-compatible",
          providerMessage: `Provider returned overload code ${providerCode}.`,
          responseStatus: 200,
        }),
      );

      expect(failure).toMatchObject({
        code: "model_request_failed",
        reason: "provider_overloaded",
        retryable: true,
      });
    },
  );

  it("classifies Kimi error.type from AI SDK parsed error data", () => {
    const message = "Your account balance is insufficient.";
    const failure = classifyModelFailure(
      new APICallError({
        data: {
          error: {
            message,
            type: "exceeded_current_quota_error",
          },
        },
        message,
        requestBodyValues: {},
        statusCode: 429,
        url: "https://api.moonshot.cn/v1/chat/completions",
      }),
    );

    expect(failure).toMatchObject({
      code: "model_rate_limited",
      message,
      reason: "rate_limited",
      retryable: false,
      statusCode: 429,
    });
  });

  it("prefers AI SDK parsed error.code over the broader OpenAI error.type", () => {
    const message = "Your organization has no prepaid credits remaining.";
    const error = new APICallError({
      data: {
        error: {
          code: "credit_balance_exhausted",
          message,
          type: "insufficient_quota",
        },
        request_id: "req_credit_exhausted",
      },
      message,
      requestBodyValues: {},
      statusCode: 429,
      url: "https://api.openai.com/v1/responses",
    });
    const failure = classifyModelFailure(error);

    expect(failure).toMatchObject({
      code: "model_rate_limited",
      message,
      reason: "rate_limited",
      retryable: false,
      statusCode: 429,
    });
    expect(inspectProviderFailure(error)).toEqual({
      providerErrorCode: "credit_balance_exhausted",
      providerErrorMessage: message,
      providerRequestId: "req_credit_exhausted",
    });
  });

  it("leaves unmapped AI SDK error data to the existing generic retry classifier", () => {
    const message = "Provider reported a custom transient failure.";
    const failure = classifyModelFailure(
      new APICallError({
        data: {
          error: {
            message,
            type: "custom_transient_error",
          },
        },
        isRetryable: true,
        message,
      }),
    );

    expect(failure).toMatchObject({
      code: "model_request_failed",
      reason: "server_error",
      retryable: true,
      statusCode: undefined,
    });
  });

  it("retries provider business HTTP 429 when no terminal business code is present", () => {
    const failure = classifyModelFailure(
      new ProviderBusinessError({
        providerId: "account:bigmodel-individual-coding-plan",
        providerKind: "openai-compatible",
        providerMessage: "Provider throttled the request.",
        responseStatus: 429,
        statusCode: 429,
      }),
    );

    expect(failure).toMatchObject({
      code: "model_rate_limited",
      message: "Provider throttled the request.",
      reason: "rate_limited",
      retryReason: "rate_limited",
      retryable: true,
      statusCode: 429,
    });
  });

  it("retries nested BigModel 1234 errors hidden behind ProviderBusinessError wrapper code", () => {
    const failure = classifyModelFailure(
      new ProviderBusinessError({
        providerCode: "PROVIDER_BUSINESS_ERROR",
        providerId: "account:bigmodel-individual-coding-plan",
        providerKind: "openai-compatible",
        providerMessage: "网络错误，错误id：202606101326108f72c6d20f7b40d9，请稍后重试",
        responseBodySummary: {
          error: {
            code: "PROVIDER_BUSINESS_ERROR",
            isProviderBusinessError: true,
            name: "ProviderBusinessError",
            providerCode: "1234",
            providerMessage: "网络错误，错误id：202606101326108f72c6d20f7b40d9，请稍后重试",
            responseBodySummary: {
              error: {
                code: "1234",
                message: "网络错误，错误id：202606101326108f72c6d20f7b40d9，请稍后重试",
              },
            },
            responseStatus: 500,
          },
          type: "error",
        },
        responseStatus: 500,
      }),
    );

    expect(failure).toMatchObject({
      code: "model_request_failed",
      message: "网络错误，错误id：202606101326108f72c6d20f7b40d9，请稍后重试",
      reason: "network_error",
      retryReason: "network_error",
      retryable: true,
      statusCode: 500,
    });
  });

  it("retries provider business HTTP 5xx even without a provider business code", () => {
    const failure = classifyModelFailure(
      new ProviderBusinessError({
        providerId: "account:bigmodel-individual-coding-plan",
        providerKind: "openai-compatible",
        providerMessage: "Provider returned an internal error.",
        responseStatus: 500,
      }),
    );

    expect(failure).toMatchObject({
      code: "model_request_failed",
      message: "Provider returned an internal error.",
      reason: "server_error",
      retryReason: "server_error",
      retryable: true,
      statusCode: 500,
    });
  });

  it("maps HTTP 200 provider api_error internal network failures to retryable network errors", () => {
    const failure = classifyModelFailure(
      new ProviderBusinessError({
        providerId: "account:bigmodel-individual-coding-plan",
        providerKind: "anthropic",
        providerMessage: "Internal Network Failure",
        providerRequestId: "20260605180401a5d2482ebda148a5",
        responseBodySummary: {
          error: {
            message: "Internal Network Failure",
            type: "api_error",
          },
          request_id: "20260605180401a5d2482ebda148a5",
          type: "error",
        },
        responseStatus: 200,
      }),
    );

    expect(failure).toMatchObject({
      code: "model_request_failed",
      message: "Internal Network Failure",
      reason: "network_error",
      retryReason: "network_error",
      retryable: true,
      statusCode: undefined,
    });
  });

  it("maps provider business transport codes to retryable network errors", () => {
    const failure = classifyModelFailure(
      new ProviderBusinessError({
        providerCode: "ECONNRESET",
        providerId: "account:zai-individual-coding-plan",
        providerKind: "openai-compatible",
        providerMessage: "Cannot connect to API: socket hang up",
        responseBodySummary: {
          error: {
            cause: { code: "ECONNRESET" },
            message: "Cannot connect to API: socket hang up",
            name: "AI_APICallError",
          },
          type: "error",
        },
      }),
    );

    expect(failure).toMatchObject({
      code: "model_request_failed",
      message: "Cannot connect to API: socket hang up",
      reason: "network_error",
      retryReason: "network_error",
      retryable: true,
    });
  });

  it("maps provider business transport timeouts to retryable timeout failures", () => {
    const cases = [
      {
        providerCode: "UND_ERR_HEADERS_TIMEOUT",
        providerMessage: "Cannot connect to API: Headers Timeout Error",
      },
      {
        providerCode: "UND_ERR_BODY_TIMEOUT",
        providerMessage: "Cannot connect to API: Body Timeout Error",
      },
      {
        providerCode: "ETIMEDOUT",
        providerMessage: "Cannot connect to API: request timed out",
      },
    ];

    for (const item of cases) {
      const failure = classifyModelFailure(
        new ProviderBusinessError({
          providerCode: item.providerCode,
          providerId: "account:zai-individual-coding-plan",
          providerKind: "openai-compatible",
          providerMessage: item.providerMessage,
          responseBodySummary: {
            error: {
              cause: { code: item.providerCode },
              message: item.providerMessage,
              name: "AI_APICallError",
            },
            type: "error",
          },
        }),
      );

      expect(failure).toMatchObject({
        code: "model_request_timeout",
        message: item.providerMessage,
        reason: "timeout",
        retryReason: "timeout",
        retryable: true,
      });
    }
  });

  it("maps provider business HTTP 408 failures to retryable timeout failures", () => {
    const failure = classifyModelFailure(
      new ProviderBusinessError({
        providerId: "account:zai-individual-coding-plan",
        providerKind: "openai-compatible",
        providerMessage: "Provider gateway timed out before response headers.",
        responseStatus: 408,
        statusCode: 408,
      }),
    );

    expect(failure).toMatchObject({
      code: "model_request_timeout",
      message: "Provider gateway timed out before response headers.",
      reason: "timeout",
      retryReason: "timeout",
      retryable: true,
      statusCode: 408,
    });
  });
});

function providerBusinessError(input: {
  providerCode: string;
  providerMessage: string;
  responseStatus?: number;
  statusCode?: number;
}): ProviderBusinessError {
  return new ProviderBusinessError({
    providerCode: input.providerCode,
    providerId: "account:bigmodel-individual-coding-plan",
    providerKind: "anthropic",
    providerMessage: input.providerMessage,
    responseBodySummary: {
      error: {
        code: input.providerCode,
        message: input.providerMessage,
      },
      type: "error",
    },
    responseStatus: input.responseStatus ?? 200,
    statusCode: input.statusCode,
  });
}

describe("provider code shape", () => {
  // 回归：上游 499 响应体的 code 字段曾是一整段多行脚本，被当成 providerCode 显示在报错详情里。
  const scriptCode = [
    "const root =",
    "  process.env.ZCODE_PLUGIN_ROOT;",
    "await agent.computerUse.listApps();",
  ].join("\n");

  function createApiCallError(statusCode: number, body: Record<string, unknown>): APICallError {
    return new APICallError({
      message: `status code ${statusCode}`,
      url: "https://api.example.com/v1/chat/completions",
      requestBodyValues: {},
      statusCode,
      responseBody: JSON.stringify(body),
    });
  }

  it("ignores non code-shaped values in an HTTP 499 response body", () => {
    const error = createApiCallError(499, { code: scriptCode, error: { code: scriptCode } });

    expect(inspectProviderFailure(error).providerErrorCode).toBeUndefined();
    expect(classifyModelFailure(error)).toMatchObject({
      code: "model_request_failed",
      reason: "unknown",
      retryable: false,
      statusCode: 499,
    });
  });

  it("ignores non code-shaped providerCode on ProviderBusinessError", () => {
    const error = new ProviderBusinessError({
      providerCode: "a b",
      providerId: "custom",
      providerKind: "openai-compatible",
      responseStatus: 499,
      statusCode: 499,
    });

    expect(inspectProviderFailure(error).providerErrorCode).toBeUndefined();
  });

  it("keeps numeric and identifier business codes from the response body", () => {
    expect(
      inspectProviderFailure(createApiCallError(403, { code: 3007, msg: "denied" }))
        .providerErrorCode,
    ).toBe("3007");
    expect(
      inspectProviderFailure(createApiCallError(429, { error: { code: "1113", message: "quota" } }))
        .providerErrorCode,
    ).toBe("1113");
    expect(
      inspectProviderFailure(
        createApiCallError(429, { error: { code: "insufficient_quota", message: "quota" } }),
      ).providerErrorCode,
    ).toBe("insufficient_quota");
  });
});
