import {
  WEB_REMOTE_CONTROL_RELAY_V2_HTTP,
  type MobilePushEvent,
  parseWebRemoteControlRelayV2HttpResponse,
  WebRemoteControlV2ConnectionError,
  type WebRemoteControlRelayV2HttpOperation,
  type WebRemoteControlRelayV2HttpRequest,
  type WebRemoteControlRelayV2HttpResponse,
} from "@zcode/shared/web-remote-relay";

/**
 * Main 直接 Node fetch；不使用会触发全局登出的 services HTTP 客户端。
 * 也因此拿不到 NodeApiClient 的来源头：X-Client-Language 由调用方传入当前界面语言，
 * 以前不带这个头，服务端只能猜语言。
 */
export function createWebRemoteControlV2Http(
  endpointOrigin: string,
  fetcher = fetch,
  getClientLanguage?: () => string | undefined,
) {
  async function request<K extends WebRemoteControlRelayV2HttpOperation>(
    operation: K,
    body: WebRemoteControlRelayV2HttpRequest<K>,
    jwt: string,
    signal: AbortSignal,
  ): Promise<WebRemoteControlRelayV2HttpResponse<K>> {
    const { method, path } = WEB_REMOTE_CONTROL_RELAY_V2_HTTP[operation];
    try {
      const response = await fetcher(new URL(path, endpointOrigin), {
        method,
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
          ...buildWebRemoteControlClientLanguageHeader(getClientLanguage),
        },
        body: method === "GET" ? undefined : JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        redirect: "error",
      });
      if (response.status === 401) throw new WebRemoteControlV2ConnectionError("auth-required");
      if (!response.ok)
        throw new WebRemoteControlV2ConnectionError("relay-unavailable", response.status >= 500);
      // 读取正文也可能断网或超时，必须交给外层网络重试；只有完整但非法的 JSON 才是终态。
      const responseBody = await response.text();
      let value: unknown;
      try {
        value = JSON.parse(responseBody);
      } catch {
        throw new WebRemoteControlV2ConnectionError("relay-unavailable");
      }
      const parsed = parseWebRemoteControlRelayV2HttpResponse(operation, value);
      if (!parsed || parsed.code !== 0)
        throw new WebRemoteControlV2ConnectionError("relay-unavailable");
      return parsed;
    } catch (error) {
      if (error instanceof WebRemoteControlV2ConnectionError) throw error;
      throw new WebRemoteControlV2ConnectionError("relay-unavailable", true);
    }
  }
  return {
    async reportNotification(
      deviceSid: string,
      event: MobilePushEvent,
      jwt: string,
      signal: AbortSignal,
    ): Promise<"accepted" | "ignored" | "rejected"> {
      try {
        const response = await fetcher(
          new URL("/api/v1/remote/notification/events", endpointOrigin),
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${jwt}`,
              "Content-Type": "application/json",
              ...buildWebRemoteControlClientLanguageHeader(getClientLanguage),
            },
            body: JSON.stringify({ device_sid: deviceSid, event }),
            signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
            redirect: "error",
          },
        );
        if (!response.ok) throw new Error("http_failed");
        const value = (await response.json()) as {
          code?: number;
          data?: { event_id?: string; status?: unknown };
        };
        const status = value?.data?.status;
        if (
          value?.code !== 0 ||
          value.data?.event_id !== event.event_id ||
          (status !== "accepted" && status !== "ignored" && status !== "rejected")
        )
          throw new Error("invalid_receipt");
        return status;
      } catch {
        // 不暴露响应正文或凭据；通知请求失败不进入远控的自动重试路径。
        throw new WebRemoteControlV2ConnectionError("relay-unavailable");
      }
    },
    async register(deviceMid: string, jwt: string, signal: AbortSignal) {
      const result = await request("register", { device_mid: deviceMid }, jwt, signal);
      if (!result.data) throw new WebRemoteControlV2ConnectionError("relay-unavailable");
      return result.data.device_sid;
    },
    async token(jwt: string, signal: AbortSignal) {
      const result = await request("token", { role: "device" }, jwt, signal);
      if (!result.data) throw new WebRemoteControlV2ConnectionError("relay-unavailable");
      return result.data.token;
    },
    async delete(deviceSid: string, jwt: string, signal: AbortSignal) {
      await request("delete", { device_sid: deviceSid }, jwt, signal);
    },
  };
}

/** 只在拿到界面语言时带 X-Client-Language；拿不到时不猜系统语言，避免和 UI 不一致。 */
export function buildWebRemoteControlClientLanguageHeader(
  getClientLanguage: (() => string | undefined) | undefined,
): Record<string, string> {
  const clientLanguage = getClientLanguage?.()?.trim();
  return clientLanguage ? { "X-Client-Language": clientLanguage } : {};
}
