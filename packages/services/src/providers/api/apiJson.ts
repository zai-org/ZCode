import { ApiError, type ApiClient, type ApiRequestInit } from "@zcode/shared";

const DIAGNOSTIC_RESPONSE_HEADER_NAMES = [
  "x-request-id",
  "x-trace-id",
  "x-span-id",
  "retry-after",
] as const;

function resolveMethod(init?: ApiRequestInit): string {
  return (init?.method ?? "GET").toUpperCase();
}

function resolveUrl(input: string | URL): string {
  return typeof input === "string" ? input : input.toString();
}

function readDiagnosticResponseHeaders(headers: Headers): Record<string, string> | undefined {
  const responseHeaders: Record<string, string> = {};

  for (const name of DIAGNOSTIC_RESPONSE_HEADER_NAMES) {
    const value = headers.get(name)?.trim();
    if (value) {
      responseHeaders[name] = value;
    }
  }

  return Object.keys(responseHeaders).length > 0 ? responseHeaders : undefined;
}

async function readResponseMessage(response: Response): Promise<string> {
  try {
    const body = await response.text();
    const trimmed = body.trim();
    if (!trimmed) {
      return `HTTP ${response.status}`;
    }

    try {
      const parsed = JSON.parse(trimmed) as {
        error?: unknown;
        message?: unknown;
        msg?: unknown;
        detail?: unknown;
      };
      const message =
        typeof parsed.error === "string"
          ? parsed.error
          : typeof parsed.message === "string"
            ? parsed.message
            : typeof parsed.msg === "string"
              ? parsed.msg
              : typeof parsed.detail === "string"
                ? parsed.detail
                : "";
      return message.trim() || `HTTP ${response.status}`;
    } catch {
      return trimmed;
    }
  } catch {
    return `HTTP ${response.status}`;
  }
}

export async function readApiJson<T>(
  apiClient: ApiClient,
  input: string | URL,
  init?: ApiRequestInit,
): Promise<T> {
  const url = resolveUrl(input);
  const method = resolveMethod(init);
  const response = await apiClient.request(input, init);

  if (!response.ok) {
    const message = await readResponseMessage(response);
    throw new ApiError({
      message,
      url,
      method,
      status: response.status,
      responseHeaders: readDiagnosticResponseHeaders(response.headers),
    });
  }

  try {
    return (await response.json()) as T;
  } catch (error) {
    throw new ApiError({
      message: error instanceof Error ? error.message : "Invalid JSON response",
      url,
      method,
      status: response.status,
      responseHeaders: readDiagnosticResponseHeaders(response.headers),
      cause: error,
    });
  }
}
