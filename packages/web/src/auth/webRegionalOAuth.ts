import { ZAI_CN_PROVIDER_ID, ZAI_PROVIDER_ID, type UserInfo } from "@zcode/shared";
import { toUserInfo } from "#src/auth/zaiWebOAuthProvider.js";

export type RegionalOAuthProvider = typeof ZAI_CN_PROVIDER_ID | typeof ZAI_PROVIDER_ID;
interface RegionalFlow {
  flowId: string;
  authorizeUrl: string;
  expiresAt: number;
  intervalMs: number;
  provider: RegionalOAuthProvider;
}

async function requestData(
  path: string,
  pollToken: string,
  signal: AbortSignal,
  provider?: RegionalOAuthProvider,
): Promise<Record<string, unknown>> {
  if (signal.aborted) throw signal.reason ?? new DOMException("Request aborted", "AbortError");

  // Bug 原因：AbortSignal.any 从 Chrome 116 才有，Chrome/Edge 111–115 在 init 请求前抛 TypeError，
  // 远控登录弹窗随即关闭。用基础 AbortController 合并调用方取消与 15 秒期限，期限覆盖正文读取。
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new DOMException("Request timed out", "TimeoutError")),
    15_000,
  );
  try {
    const response = await fetch(path, {
      signal: controller.signal,
      method: provider ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${pollToken}`,
        ...(provider ? { "Content-Type": "application/json" } : {}),
      },
      ...(provider ? { body: JSON.stringify({ provider }) } : {}),
    });
    if (!response.ok) throw new Error("OAuth request failed");
    const payload = await response.json();
    if (payload?.code !== 0 || !payload.data || typeof payload.data !== "object")
      throw new Error("Invalid OAuth response");
    return payload.data;
  } catch (error) {
    // 状态码失败时正文未读；先释放连接再撤销期限。
    controller.abort();
    throw error;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }
}

export async function initializeRegionalOAuth(
  provider: RegionalOAuthProvider,
  token: string,
  signal: AbortSignal,
): Promise<RegionalFlow> {
  const data = await requestData("/api/v1/oauth/cli/init", token, signal, provider);
  if (
    typeof data.authorize_url !== "string" ||
    typeof data.flow_id !== "string" ||
    !data.flow_id.trim() ||
    typeof data.expires_at !== "number" ||
    typeof data.poll_interval_sec !== "number"
  )
    throw new Error("Invalid OAuth flow");
  const url = new URL(data.authorize_url);
  const expiresAt = Math.min(data.expires_at * 1000, Date.now() + 10 * 60_000);
  const intervalMs = data.poll_interval_sec * 1000;
  if (
    url.protocol !== "https:" ||
    !url.searchParams.get("state") ||
    !Number.isFinite(expiresAt) ||
    !Number.isFinite(intervalMs) ||
    intervalMs < 1000 ||
    intervalMs >= expiresAt - Date.now()
  )
    throw new Error("Invalid OAuth flow");
  return {
    flowId: data.flow_id,
    authorizeUrl: data.authorize_url,
    expiresAt,
    intervalMs,
    provider,
  };
}

export async function pollRegionalOAuth(
  flow: RegionalFlow,
  token: string,
  signal: AbortSignal,
): Promise<{ zcodeJwtToken: string; userInfo: UserInfo; businessAccessToken?: string } | null> {
  const data = await requestData(
    `/api/v1/oauth/cli/poll/${encodeURIComponent(flow.flowId)}`,
    token,
    signal,
  );
  if (data.status === "pending") return null;
  const user = data.user as Record<string, unknown> | null;
  // 只有后端canonical user_id可作主体；上游id/sub以及缓存形态的id都不能替代。
  const userId = typeof user?.user_id === "string" ? user.user_id.trim() : "";
  const userInfo = userId
    ? toUserInfo({ user_id: userId, name: user?.name, email: user?.email, avatar: user?.avatar })
    : null;
  if (
    data.status !== "ready" ||
    typeof data.token !== "string" ||
    !data.token.trim() ||
    !userInfo ||
    userInfo.id === "unknown"
  )
    throw new Error("OAuth authorization did not complete");
  const upstream = data.zai as Record<string, unknown> | undefined;
  const businessAccessToken =
    flow.provider === ZAI_PROVIDER_ID && typeof upstream?.access_token === "string"
      ? upstream.access_token.trim()
      : "";
  return {
    zcodeJwtToken: data.token.trim(),
    userInfo,
    ...(businessAccessToken ? { businessAccessToken } : {}),
  };
}

export function waitForRegionalPoll(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}
