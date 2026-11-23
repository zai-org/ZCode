import { CoreErrorType, createCoreError } from "../deps.js";
import { isPlainRecord } from "./data.js";

interface ProviderBusinessMetadataFailure {
  message: string;
  providerCode?: string;
  responseBodySummary?: Record<string, unknown>;
}

export function findProviderBusinessFailureInMetadata(
  providerMetadata: Record<string, unknown> | undefined,
): ProviderBusinessMetadataFailure | undefined {
  if (!providerMetadata) {
    return undefined;
  }

  const queue: unknown[] = [providerMetadata];
  const seen = new WeakSet<object>();

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

    const record = current as Record<string, unknown>;
    const providerCode = readProviderBusinessCode(record);
    const providerMessage = readProviderBusinessMessage(record);
    const failedBySuccess = record.success === false;
    const failedByCode = isNonZeroProviderBusinessCode(providerCode);

    if (failedBySuccess || failedByCode) {
      return {
        message: providerMessage ?? "Provider returned a business error.",
        providerCode,
        responseBodySummary: summarizeProviderBusinessMetadataBody(record),
      };
    }

    for (const nested of Object.values(record)) {
      if (nested && typeof nested === "object") {
        queue.push(nested);
      }
    }
  }

  return undefined;
}

export function createCoreErrorFromProviderBusinessLike(
  error: unknown,
): ReturnType<typeof createCoreError> | undefined {
  const failure = readProviderBusinessFailureFromUnknown(error);
  if (!failure) {
    return undefined;
  }

  return createCoreError(CoreErrorType.ModelError, failure.message, {
    context: {
      ...(failure.providerCode ? { providerCode: failure.providerCode } : {}),
      ...(failure.responseBodySummary ? { responseBodySummary: failure.responseBodySummary } : {}),
    },
    recoverable: true,
    retryable: false,
  });
}

function readProviderBusinessFailureFromUnknown(
  error: unknown,
): ProviderBusinessMetadataFailure | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const record = error as Record<string, unknown>;
  if (record.isProviderBusinessError === true || record.name === "ProviderBusinessError") {
    return readProviderBusinessFailureFromRecord(record);
  }

  const context = isPlainRecord(record.context) ? record.context : undefined;
  if (context) {
    const contextFailure = readProviderBusinessFailureFromRecord({
      ...context,
      msg: context.msg ?? context.providerMessage ?? record.message,
      message: context.message ?? record.message,
      code: context.providerCode ?? context.code,
    });
    if (contextFailure) {
      return contextFailure;
    }
  }

  return readProviderBusinessFailureFromRecord(record);
}

function readProviderBusinessFailureFromRecord(
  record: Record<string, unknown>,
): ProviderBusinessMetadataFailure | undefined {
  const providerCode = readProviderBusinessCode(record);
  const providerMessage = readProviderBusinessMessage(record);
  const failedBySuccess = record.success === false;
  const failedByCode = isNonZeroProviderBusinessCode(providerCode);

  if (!failedBySuccess && !failedByCode) {
    return undefined;
  }

  return {
    message: providerMessage ?? "Provider returned a business error.",
    providerCode,
    responseBodySummary: summarizeProviderBusinessMetadataBody(record),
  };
}

function readProviderBusinessCode(record: Record<string, unknown>): string | undefined {
  const errorRecord = isPlainRecord(record.error) ? record.error : undefined;
  const contextRecord = isPlainRecord(record.context) ? record.context : undefined;
  return (
    normalizeProviderBusinessCode(record.code) ??
    normalizeProviderBusinessCode(record.providerCode) ??
    normalizeProviderBusinessCode(record.error_code) ??
    normalizeProviderBusinessCode(errorRecord?.code) ??
    normalizeProviderBusinessCode(errorRecord?.providerCode) ??
    normalizeProviderBusinessCode(errorRecord?.error_code) ??
    normalizeProviderBusinessCode(contextRecord?.providerCode) ??
    normalizeProviderBusinessCode(contextRecord?.code)
  );
}

function readProviderBusinessMessage(record: Record<string, unknown>): string | undefined {
  const errorRecord = isPlainRecord(record.error) ? record.error : undefined;
  const contextRecord = isPlainRecord(record.context) ? record.context : undefined;
  return (
    normalizeProviderBusinessMessage(record.msg) ??
    normalizeProviderBusinessMessage(record.providerMessage) ??
    normalizeProviderBusinessMessage(record.message) ??
    normalizeProviderBusinessMessage(errorRecord?.msg) ??
    normalizeProviderBusinessMessage(errorRecord?.providerMessage) ??
    normalizeProviderBusinessMessage(errorRecord?.message) ??
    normalizeProviderBusinessMessage(contextRecord?.providerMessage) ??
    normalizeProviderBusinessMessage(contextRecord?.msg) ??
    normalizeProviderBusinessMessage(contextRecord?.message)
  );
}

function summarizeProviderBusinessMetadataBody(
  record: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) {
      continue;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      summary[key] = value;
      continue;
    }
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      summary[key] = value;
    }
  }

  return Object.keys(summary).length > 0 ? summary : undefined;
}

function normalizeProviderBusinessCode(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  // 上游曾在 499 响应体的 code 字段里放一整段多行脚本，原样当业务码会让报错详情显示成
  // provider_code=<脚本>，也会被误判成业务错误。业务码只可能是数字或短标识符，其余当作没有码。
  return PROVIDER_CODE_SHAPE.test(normalized) ? normalized : undefined;
}

const PROVIDER_CODE_SHAPE = /^[A-Za-z0-9_.:-]{1,64}$/;

function normalizeProviderBusinessMessage(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function isNonZeroProviderBusinessCode(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric !== 0 : true;
}
