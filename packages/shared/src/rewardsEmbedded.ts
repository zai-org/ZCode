import { z } from "zod";

export const REWARDS_PARTITION = "persist:zcode-rewards";
export const REWARDS_CONTEXT_EVENT = "zcode-rewards-context";
export const rewardsContextSchema = z.object({
  theme: z.enum(["zai-light", "zai-dark"]),
  locale: z.enum(["zh-CN", "en-US"]),
  auth: z.object({
    status: z.enum(["ready", "anonymous"]),
    provider: z.enum(["zai", "zai_cn", "bigmodel"]).nullable(),
    revision: z.number().int().nonnegative(),
  }),
});
export type RewardsContext = z.infer<typeof rewardsContextSchema>;

export function isTrustedRewardsUrl(
  value: string,
  options: { dev?: boolean; e2e?: boolean } = {},
): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    const trusted =
      ["https://zcode.z.ai", "https://zcode.z.ai"].includes(url.origin) ||
      (options.dev === true && url.origin === "http://localhost:3000") ||
      (options.e2e === true &&
        url.protocol === "http:" &&
        ["127.0.0.1", "localhost"].includes(url.hostname));
    return (
      trusted &&
      /^\/(cn|en)\/rewards\/?$/.test(url.pathname) &&
      url.searchParams.get("embedded") === "app"
    );
  } catch {
    return false;
  }
}

export function resolveRewardsOrigin(options: {
  env: "test" | "production";
  dev?: boolean;
  override?: string;
  e2e?: boolean;
}): string {
  try {
    if (
      options.override &&
      isTrustedRewardsUrl(buildRewardsUrl(options.override, "en-US", "zai-dark"), options)
    )
      return new URL(options.override).origin;
  } catch {
    // 配置值非法时回到受信任的环境地址，不让菜单点击直接抛异常。
  }
  return options.env === "test" ? "https://zcode.z.ai" : "https://zcode.z.ai";
}

export function buildRewardsUrl(
  origin: string,
  locale: string,
  theme: RewardsContext["theme"],
): string {
  const url = new URL(`/${locale === "zh-CN" ? "cn" : "en"}/rewards`, origin);
  url.searchParams.set("embedded", "app");
  url.searchParams.set("theme", theme);
  return url.toString();
}
