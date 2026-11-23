import { ZAI_CN_PROVIDER_ID, ZAI_PROVIDER_ID, type UserInfo } from "@zcode/shared";
import { toUserInfo } from "#src/auth/zaiWebOAuthProvider.js";

export type RegionalOAuthProvider = typeof ZAI_CN_PROVIDER_ID | typeof ZAI_PROVIDER_ID;
interface RegionalFlow {
  flowId: string;
  authorizeUrl: string;
  /** 服务端授权 state；授权站原样带回 Web 回调页，用于找回 pending。 */
  state: string;
  /** init 返回时起算的剩余寿命（毫秒），按服务端 server_time 计算，不依赖本机时钟。 */
  lifetimeMs: number;
  intervalMs: number;
  provider: RegionalOAuthProvider;
}

async function fetchWithDeadline<T>(
  path: string,
  init: RequestInit,
  signal: AbortSignal,
  read: (response: Response) => Promise<T>,
): Promise<T> {
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
    const response = await fetch(path, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error("OAuth request failed");
    return await read(response);
  } catch (error) {
    // 状态码失败时正文未读；先释放连接再撤销期限。
    controller.abort();
    throw error;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }
}

function requestData(
  path: string,
  pollToken: string,
  signal: AbortSignal,
  provider?: RegionalOAuthProvider,
): Promise<Record<string, unknown>> {
  return fetchWithDeadline(
    path,
    {
      method: provider ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${pollToken}`,
        ...(provider ? { "Content-Type": "application/json" } : {}),
      },
      ...(provider ? { body: JSON.stringify({ provider }) } : {}),
    },
    signal,
    async (response) => {
      const payload = await response.json();
      if (payload?.code !== 0 || !payload.data || typeof payload.data !== "object")
        throw new Error("Invalid OAuth response");
      return payload.data;
    },
  );
}

/**
 * 把授权站回给 Web 回调页的 code/state 转交后端，由后端兑换并完成 flow。
 *
 * 与官网中转页 /app/oauth/login 的做法相同：同源 GET，前端不兑换授权码。返回的是 HTML 结果页，
 * 不解析页面文案；成败以随后 poll 的 ready / failed 为准。
 */
export async function forwardRegionalOAuthCallback(
  provider: RegionalOAuthProvider,
  code: string,
  state: string,
  signal: AbortSignal,
): Promise<void> {
  await fetchWithDeadline(
    `/api/v1/oauth/cli/callback/${provider}?${new URLSearchParams({ code, state }).toString()}`,
    { method: "GET", cache: "no-store", credentials: "same-origin" },
    signal,
    (response) => response.text(),
  );
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
  const state = url.searchParams.get("state")?.trim() ?? "";
  // Bug 原因：旧逻辑用浏览器 Date.now() 减服务端 expires_at，手机或电脑时钟偏快约 5 分钟以上时
  // 300 秒的 flow 剩余寿命为负，每次都报 Invalid OAuth flow。expires_at 与同一响应的 server_time
  // 同属服务端时钟，相减得到与本机时钟无关的剩余寿命；服务端未返回数值 server_time 时退回本机时间。
  const serverNowMs = typeof data.server_time === "number" ? data.server_time * 1000 : Date.now();
  const lifetimeMs = Math.min(data.expires_at * 1000 - serverNowMs, 10 * 60_000);
  const intervalMs = data.poll_interval_sec * 1000;
  if (
    url.protocol !== "https:" ||
    !state ||
    !Number.isFinite(lifetimeMs) ||
    !Number.isFinite(intervalMs) ||
    intervalMs < 1000 ||
    intervalMs >= lifetimeMs
  )
    throw new Error("Invalid OAuth flow");
  return {
    flowId: data.flow_id,
    authorizeUrl: data.authorize_url,
    state,
    lifetimeMs,
    intervalMs,
    provider,
  };
}

export async function pollRegionalOAuth(
  flow: Pick<RegionalFlow, "flowId" | "provider">,
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
