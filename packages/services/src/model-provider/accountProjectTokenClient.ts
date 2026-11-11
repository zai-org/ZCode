import {
  ApiError,
  ProjectAccessTokenClient,
  ProjectAccessTokenError,
  ProjectAccessTokenHttpStatusError,
  ProjectAccessTokenTransientError,
  projectAccessTokenRetryAfterMs,
  type ApiClient,
} from "@zcode/shared";
import type { ICredentialService } from "#src/credential/credential.js";
import type { LocalCredentialService } from "#src/credential/credentialService.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { readApiJson } from "#src/providers/api/apiJson.js";

const PROJECT_TOKEN_REQUEST_TIMEOUT_MS = 15_000;
const log = createServiceLogger("project-access-token");

/** 本地与旧远程附加入口复用同一 HTTP/ID 存储约束，每个鉴权 owner 只持有一个实例。 */
export function createAccountProjectTokenClient(
  apiClient: ApiClient,
  credentialService: Pick<ICredentialService, "load" | "save" | "delete"> &
    Partial<Pick<LocalCredentialService, "recoverUnreadable">>,
): ProjectAccessTokenClient {
  return new ProjectAccessTokenClient({
    request: async (url, init) => {
      try {
        return await readApiJson(apiClient, url, {
          ...init,
          timeoutMs: PROJECT_TOKEN_REQUEST_TIMEOUT_MS,
        });
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return { code: 404 };
        // 仅承认传输异常/内部超时及临时 HTTP 状态；JSON 解析和未知异常不能恢复旧 PAT。
        if (error instanceof ApiError) {
          const status = error.status;
          if (status === 429 || (status !== undefined && status >= 500 && status < 600))
            throw new ProjectAccessTokenTransientError({
              kind: "http",
              status,
              ...(status === 429
                ? {
                    retryAfterMs: projectAccessTokenRetryAfterMs(
                      error.responseHeaders?.["retry-after"],
                    ),
                  }
                : {}),
            });
          if (status === undefined && error.cause instanceof TypeError)
            throw new ProjectAccessTokenTransientError({ kind: "network" });
          if (
            status === undefined &&
            error.cause instanceof DOMException &&
            ["AbortError", "TimeoutError"].includes(error.cause.name)
          )
            throw new ProjectAccessTokenTransientError({ kind: "timeout" });
          // Bug 原因（ZCT-2111046389485834240）：非临时状态与 2xx 非 JSON 过去原样抛出，
          // 换证客户端只能记 project_token_request_failed。这里只保留状态码/固定码，不带响应体。
          if (status !== undefined && status >= 200 && status < 300)
            throw new ProjectAccessTokenError("project_token_invalid_response");
          if (status !== undefined) throw new ProjectAccessTokenHttpStatusError(status);
        }
        throw error;
      }
    },
    locationStore: credentialService,
    observe: (event) =>
      log.warn(
        undefined,
        event.code === "project_token_request_retry"
          ? "项目 Token 签发临时失败，准备重试"
          : event.code === "project_token_refresh_deferred"
            ? "项目 Token 提前刷新暂缓"
            : event.code === "project_token_location_unreadable"
              ? "项目定位缓存无法解密，准备局部恢复"
              : event.code === "project_token_location_recovery"
                ? "项目定位缓存复核完成"
                : "项目 Token 获取失败",
        event,
      ),
  });
}
