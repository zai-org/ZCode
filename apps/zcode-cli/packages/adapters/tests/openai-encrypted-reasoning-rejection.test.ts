import { APICallError } from "ai";
import { describe, expect, it } from "vitest";
import type { ModelInputMessage } from "@zcode/contracts";
import { ProviderBusinessError } from "../src/model/model-execution.js";
import {
  isOpenAiEncryptedReasoningRejection,
  repairReasoningHistoryAfterRejection,
} from "../src/model/reasoning-history-normalization.js";

const BAD_REQUEST = 400;
const INVALID_ENCRYPTED_CONTENT_CODE = "invalid_encrypted_content";

describe("OpenAI Responses 加密推理被拒的识别", () => {
  it.each([
    // 文案不命中文案匹配，只能靠错误码识别。
    [
      "ProviderBusinessError 的 providerCode",
      businessError(BAD_REQUEST, INVALID_ENCRYPTED_CONTENT_CODE, "Bad Request"),
    ],
    [
      "未归一的错误体 code",
      apiCallError(BAD_REQUEST, "Bad Request", { code: INVALID_ENCRYPTED_CONTENT_CODE }),
    ],
    [
      "没有 code 的校验失败文案",
      apiCallError(BAD_REQUEST, "The encrypted content for item rs_1 could not be verified."),
    ],
    [
      "没有 code 的过期文案",
      apiCallError(BAD_REQUEST, "reasoning `encrypted_content` has expired"),
    ],
  ])("识别 %s", (_name, error) => {
    expect(isOpenAiEncryptedReasoningRejection(error)).toBe(true);
  });

  it.each([
    // 非推理模型带 include 的 400：要靠不发 include 解决，删密文重试无用。
    [
      "非推理模型不支持密文",
      apiCallError(BAD_REQUEST, "Encrypted content is not supported with this model."),
    ],
    ["非 400 状态", businessError(500, INVALID_ENCRYPTED_CONTENT_CODE)],
    ["其他 400", businessError(BAD_REQUEST, "invalid_value", "Invalid value for 'input'.")],
  ])("不把 %s 当成密文被拒", (_name, error) => {
    expect(isOpenAiEncryptedReasoningRejection(error)).toBe(false);
  });

  it("只有 openai 类型执行密文修复", () => {
    const messages = encryptedHistory();
    const error = businessError(BAD_REQUEST, INVALID_ENCRYPTED_CONTENT_CODE);

    expect(repairReasoningHistoryAfterRejection(messages, error, "anthropic")).toBe(undefined);
    expect(repairReasoningHistoryAfterRejection(messages, error, "openai-compatible")).toBe(
      undefined,
    );
    expect(repairReasoningHistoryAfterRejection(messages, error, "openai")).toEqual([
      messages[0],
      { ...messages[1], content: [{ type: "text", text: "done" }] },
    ]);
  });
});

function businessError(
  status: number,
  providerCode: string,
  message = "The encrypted content for item rs_1 could not be verified.",
): ProviderBusinessError {
  return new ProviderBusinessError({
    providerCode,
    providerId: "fixture",
    providerKind: "openai",
    providerMessage: message,
    responseStatus: status,
  });
}

function apiCallError(
  status: number,
  message: string,
  error: { code?: string } = {},
): APICallError {
  const body = {
    error: { message, type: "invalid_request_error", param: null, code: null, ...error },
  };
  return new APICallError({
    data: body,
    message,
    requestBodyValues: {},
    responseBody: JSON.stringify(body),
    statusCode: status,
    url: "https://gateway.example.com/v1/responses",
  });
}

function encryptedHistory(): ModelInputMessage[] {
  return [
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: [
        {
          type: "reasoning",
          text: "thought",
          providerOptions: { openai: { itemId: "rs_1", reasoningEncryptedContent: "enc" } },
        },
        { type: "text", text: "done" },
      ],
    },
  ];
}
