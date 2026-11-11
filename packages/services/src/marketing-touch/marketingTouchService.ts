import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  parseMarketingTouchResponse,
  SUPPORTED_LOCALES,
  type ApiClient,
  type Locale,
} from "@zcode/shared";
import { readApiJson } from "#src/providers/api/apiJson.js";
import type { IMarketingTouchService } from "#src/marketing-touch/marketingTouch.js";

// X-Client-Language 必须是真实界面语言（含 ja-JP/ru-RU/ko-KR），不能先降级成中英。
const localeSchema = z.enum(SUPPORTED_LOCALES);
// 序号属于本次服务进程启动，不能随组件、账号或服务实例重建而归零。
let bootRequestSeq = 0;
const reportSchema = z.object({
  locale: localeSchema,
  scope: z.string().uuid(),
  campaignId: z.string().trim().min(1).max(128),
  actionType: z.enum(["confirm", "cancel"]),
});

export function createMarketingTouchService(options: {
  apiClient: ApiClient;
  getToken: () => Promise<string | null | undefined>;
  getDeviceMid: () => string | undefined;
  baseUrl: string;
  appVersion: string;
  onSnapshot?: (snapshot: ReturnType<typeof parseMarketingTouchResponse>) => void;
}): IMarketingTouchService {
  let previousToken: string | undefined;
  let scope = randomUUID();
  async function context(locale: Locale) {
    const token = (await options.getToken())?.trim() || "";
    if (previousToken !== token) {
      previousToken = token;
      scope = randomUUID();
    }
    const device = z.string().uuid().parse(options.getDeviceMid());
    return {
      scope,
      headers: {
        "X-Device-Mid": device,
        "X-Client-Language": localeSchema.parse(locale),
        "X-ZCode-App-Version": options.appVersion,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    };
  }
  return {
    async query({ locale }) {
      const identity = await context(locale);
      const url = new URL("/api/v1/marketing/touch", options.baseUrl);
      url.searchParams.set("seq", String(bootRequestSeq++));
      const response = await readApiJson<unknown>(options.apiClient, url.href, {
        method: "GET",
        headers: identity.headers,
        timeoutMs: 15_000,
        redirect: "error",
      });
      if ((await context(locale)).scope !== identity.scope)
        throw new Error("marketing_identity_changed");
      const snapshot = parseMarketingTouchResponse(response);
      options.onSnapshot?.(snapshot);
      return { ...snapshot, scope: identity.scope };
    },
    async report(input) {
      const parsed = reportSchema.parse(input);
      const identity = await context(parsed.locale);
      // 领取期间账号可能已切换；禁止把旧操作用新凭据上报，也不向 UI 暴露凭据。
      if (identity.scope !== parsed.scope) throw new Error("marketing_identity_changed");
      const response = await readApiJson<unknown>(
        options.apiClient,
        new URL("/api/v1/marketing/touch/action", options.baseUrl).href,
        {
          method: "POST",
          headers: { ...identity.headers, "Content-Type": "application/json" },
          body: JSON.stringify({ campaign_id: parsed.campaignId, action_type: parsed.actionType }),
          timeoutMs: 15_000,
          redirect: "error",
        },
      );
      z.object({ code: z.literal(0) }).parse(response);
    },
  };
}
