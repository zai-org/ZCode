import type { AiSdkProviderKind, ProviderBusinessErrorOptions } from "./model-execution.js";
import { isProviderCodeShaped, ProviderBusinessError } from "./model-execution.js";
import { getHttpResponseStatus, getResponseHeaders } from "./failure-inspection.js";
import { asRecord, stringProperty } from "./runner-record.js";

const BIGMODEL_BRACKETED_BUSINESS_CODE_PATTERN = /^\[(\d{4})\](?=\[)/;
const PROVIDER_BUSINESS_ERROR_WRAPPER_CODE = "PROVIDER_BUSINESS_ERROR";

interface DetectProviderBusinessFinishErrorOptions {
  providerId: string;
  providerKind?: AiSdkProviderKind | string;
  source: unknown;
}

export function detectProviderBusinessFinishError(
  options: DetectProviderBusinessFinishErrorOptions,
): ProviderBusinessError | undefined {
  const record = asRecord(options.source);
  if (!isFinishLikeRecord(record)) {
    return undefined;
  }

  const rawFinishReason = readRawFinishReason(record);
  const extracted = extractBusinessFailurePayload(record);
  const errorPayload = asRecord(record.error);
  const providerCode =
    extracted.providerCode ??
    normalizeStringish(record.providerCode) ??
    normalizeStringish(errorPayload?.code);

  // AI SDK 的 error chunk 常带普通 Error.message（如 rate limited），没有业务码；
  // 仅凭 providerMessage 命中会把可重试限流误判成 ProviderBusinessError。
  const hasBusinessSignal =
    providerCode !== undefined ||
    rawFinishReason === "provider_success_false" ||
    record.isProviderBusinessError === true ||
    record.name === "ProviderBusinessError";

  if (!hasBusinessSignal) {
    return undefined;
  }

  const errorOptions: ProviderBusinessErrorOptions = {
    providerId: options.providerId,
    providerKind: normalizeProviderKind(options.providerKind),
    providerCode,
    providerMessage:
      extracted.providerMessage ??
      normalizeStringish(record.providerMessage) ??
      normalizeStringish(record.message) ??
      (rawFinishReason === "provider_success_false"
        ? "Provider returned a business error."
        : undefined),
    providerRequestId: extracted.providerRequestId,
    responseBodySummary: extracted.responseBodySummary,
    // AI SDK 的 error chunk 会把 fetch 层业务错误重新包一层；
    // 重建 ProviderBusinessError 时不带 responseHeaders，会让 retry-after 在重试计算前丢失。
    responseHeaders: extracted.responseHeaders,
    responseStatus: extracted.responseStatus,
    statusCode: extracted.statusCode,
  };

  return new ProviderBusinessError(errorOptions);
}

function normalizeProviderKind(value: AiSdkProviderKind | string | undefined): AiSdkProviderKind {
  return value === "openai" || value === "anthropic" || value === "openai-compatible"
    ? value
    : "openai-compatible";
}

function isFinishLikeRecord(record: Record<string, unknown>): boolean {
  const chunkType = stringProperty(record, "type");
  if (chunkType === "finish" || chunkType === "error") {
    return true;
  }

  if (stringProperty(record, "finishReason") || readRawFinishReason(record)) {
    return true;
  }

  if (record.isProviderBusinessError === true || record.name === "ProviderBusinessError") {
    return true;
  }

  return false;
}

function readRawFinishReason(record: Record<string, unknown>): string | undefined {
  return (
    stringProperty(record, "rawFinishReason") ??
    stringProperty(asRecord(record.providerMetadata), "rawFinishReason")
  );
}

function extractBusinessFailurePayload(record: Record<string, unknown>) {
  const candidates = collectCandidateRecords(record);
  const providerCode = candidates.map(readProviderCode).find(Boolean);
  const providerMessage = candidates.map(readProviderMessage).find(Boolean);
  const providerRequestId = candidates.map(readProviderRequestId).find(Boolean);
  const responseHeaders = candidates.map(getResponseHeaders).find(Boolean);
  const responseBodySummary = candidates.find(hasBusinessSignal);
  const responseStatus = candidates.map(getHttpResponseStatus).find((value) => value !== undefined);
  const statusCode = candidates.map(readStatusCode).find((value) => value !== undefined);

  return {
    providerCode,
    providerMessage,
    providerRequestId,
    responseHeaders,
    responseBodySummary,
    responseStatus,
    statusCode,
  };
}

function collectCandidateRecords(record: Record<string, unknown>): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  const seen = new WeakSet<object>();
  const queue: unknown[] = [record];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== "object") {
      continue;
    }
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);

    if (Array.isArray(current)) {
      for (const item of current) {
        queue.push(item);
      }
      continue;
    }

    const currentRecord = current as Record<string, unknown>;
    result.push(currentRecord);

    queue.push(
      currentRecord.providerMetadata,
      currentRecord.response,
      asRecord(currentRecord.response).body,
      currentRecord.body,
      currentRecord.error,
      currentRecord.data,
      currentRecord.choices,
    );

    // zcode-plan 等业务错误可能只出现在 AI SDK finish chunk 的深层 JSON（如 response.body），
    // 仅沿固定字段链扫描会漏掉 3007，最终让 core 误判为 suspicious empty。
    for (const nested of Object.values(currentRecord)) {
      if (nested && typeof nested === "object") {
        queue.push(nested);
      }
    }
  }

  return result;
}

function readProviderCode(record: Record<string, unknown>): string | undefined {
  const errorRecord = asRecord(record.error);
  const contextRecord = asRecord(record.context);
  const value =
    normalizeProviderCode(record.providerCode) ??
    normalizeProviderCode(errorRecord?.providerCode) ??
    normalizeProviderCode(contextRecord?.providerCode) ??
    normalizeProviderCode(record.error_code) ??
    normalizeProviderCode(errorRecord?.error_code) ??
    // ProviderBusinessError 二次进入 AI SDK chunk 时，外层 code 是包装类型；
    // 真实上游码在 providerCode/嵌套 body 中，不能让包装码提前截断扫描。
    normalizeProviderCode(record.code) ??
    normalizeProviderCode(errorRecord?.code) ??
    normalizeProviderCode(contextRecord?.code) ??
    // BigModel/Z.AI 的 SSE error chunk 有时只有 `[1302][...][request_id]` message，
    // 没有结构化 code；只解析这个强格式前缀，避免把普通 rate limit 文案误判成业务码。
    readBigModelBracketedBusinessCode(record.message) ??
    readBigModelBracketedBusinessCode(record.providerMessage) ??
    readBigModelBracketedBusinessCode(errorRecord?.message) ??
    readBigModelBracketedBusinessCode(errorRecord?.providerMessage) ??
    readBigModelBracketedBusinessCode(contextRecord?.message) ??
    readBigModelBracketedBusinessCode(contextRecord?.providerMessage);
  return value;
}

function readProviderMessage(record: Record<string, unknown>): string | undefined {
  const errorRecord = asRecord(record.error);
  const contextRecord = asRecord(record.context);
  return (
    normalizeStringish(record.msg) ??
    normalizeStringish(record.providerMessage) ??
    normalizeStringish(record.message) ??
    normalizeStringish(errorRecord?.msg) ??
    normalizeStringish(errorRecord?.providerMessage) ??
    normalizeStringish(errorRecord?.message) ??
    normalizeStringish(contextRecord?.providerMessage) ??
    normalizeStringish(contextRecord?.msg) ??
    normalizeStringish(contextRecord?.message)
  );
}

function readProviderRequestId(record: Record<string, unknown>): string | undefined {
  const errorRecord = asRecord(record.error);
  return (
    normalizeStringish(record.request_id) ??
    normalizeStringish(record.requestId) ??
    normalizeStringish(record.id) ??
    normalizeStringish(errorRecord.request_id) ??
    normalizeStringish(errorRecord.requestId) ??
    normalizeStringish(errorRecord.id)
  );
}

function readStatusCode(record: Record<string, unknown>): number | undefined {
  return toFiniteNumber(record.statusCode) ?? toFiniteNumber(record.status);
}

function hasBusinessSignal(record: Record<string, unknown>): boolean {
  return Boolean(
    readProviderCode(record) ||
    readProviderMessage(record) ||
    (Array.isArray(record.allowed_models) && record.allowed_models.length > 0),
  );
}

function normalizeStringish(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeProviderCode(value: unknown): string | undefined {
  const normalized = normalizeStringish(value);
  // 不像码值的字符串（如整段脚本）不能当 providerCode，原因见 model-execution.ts 的 isProviderCodeShaped。
  if (normalized !== undefined && !isProviderCodeShaped(normalized)) {
    return undefined;
  }
  return normalized?.toUpperCase() === PROVIDER_BUSINESS_ERROR_WRAPPER_CODE
    ? undefined
    : normalized;
}

function readBigModelBracketedBusinessCode(value: unknown): string | undefined {
  const message = normalizeStringish(value);
  const match = message?.match(BIGMODEL_BRACKETED_BUSINESS_CODE_PATTERN);
  return match?.[1];
}

function toFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
