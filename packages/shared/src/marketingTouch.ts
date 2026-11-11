import { z } from "zod";
import { cloudButtonThemeSchema } from "./cloudContent.js";
import { SUPPORTED_LOCALES } from "./protocol.js";

const id = z.string().trim().min(1).max(128);
const url = z
  .string()
  .max(4096)
  .url()
  .refine((value) => {
    if (!URL.canParse(value)) return false;
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password;
  });
export const marketingAssetSchema = z.object({
  src: url,
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
const text = z.object({
  format: z.enum(["plaintext", "html", "markdown"]),
  content: z.string().max(20_000),
});
export const marketingNavigationSchema = z.discriminatedUnion("page", [
  z.object({ page: z.literal("upgrade") }).strict(),
  z.object({ page: z.literal("rewards") }).strict(),
  z
    .object({
      page: z.literal("settings"),
      section: z
        .enum([
          "general",
          "appearance",
          "models",
          "browser",
          "computer_use",
          "memory",
          "subagents",
          "plugins",
          "mcp",
          "skills",
          "commands",
          "hooks",
          "usage",
        ])
        .optional(),
      provider_id: id.optional(),
    })
    .strict()
    .refine((args) => args.provider_id === undefined || args.section === "models"),
  z
    .object({
      page: z.literal("plugin_marketplace"),
      plugin_id: id.regex(/^[^@\s]+@[^@\s]+$/u).optional(),
    })
    .strict(),
]);
export const marketingActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("close") }),
  z.object({ type: z.literal("open_url"), args: z.object({ url }) }),
  z.object({ type: z.literal("claim_zcode_plan"), args: z.object({ plan_id: id }) }),
  z.object({ type: z.literal("navigate"), args: marketingNavigationSchema }),
  z.object({
    type: z.literal("copy_text"),
    args: z
      .object({
        text: z
          .string()
          .max(20_000)
          .refine((value) => value.trim().length > 0),
      })
      .strict(),
  }),
]);
const button = z.object({
  text,
  action: marketingActionSchema,
  theme: cloudButtonThemeSchema.nullish(),
});
// Banner 允许空格式；若复用弹窗约束会丢弃有效投放，仅在此按纯文本归一。
const bannerButton = button.omit({ theme: true }).extend({
  text: text.extend({
    format: z
      .enum(["", "plaintext", "html", "markdown"])
      .transform((value) => value || "plaintext"),
  }),
});
const layout = z.enum(["", "v1"]).optional();
const visualArgs = z
  .record(z.string(), z.unknown())
  .refine((value) => JSON.stringify(value).length <= 64_000)
  .optional();
const image = z.object({
  type: z.literal("image"),
  image: z.object({ default: marketingAssetSchema, dark: marketingAssetSchema.nullish() }),
  args: visualArgs,
});
export const marketingVisualSchema = z.discriminatedUnion("type", [
  image,
  z.object({
    type: z.literal("video"),
    video: z.object({ src: marketingAssetSchema, fallback: marketingAssetSchema }),
    args: visualArgs,
  }),
  z.object({
    type: z.literal("bundle"),
    bundle: z.object({
      bundle: marketingAssetSchema,
      entry: z
        .string()
        .min(1)
        .max(240)
        .refine(
          (value) =>
            !value.includes("\\") &&
            value.split("/").every((part) => part && part !== "." && part !== ".."),
        ),
      fallback: marketingAssetSchema.nullish(),
    }),
    args: visualArgs,
  }),
]);
export const marketingPopupSchema = z.object({
  layout,
  title: text,
  description: text,
  hero: marketingVisualSchema.nullish(),
  buttons: z.array(button).max(4),
});
const banner = z
  .object({
    layout,
    background: marketingVisualSchema,
    buttons: z.array(bannerButton).max(2),
    success_popup: marketingPopupSchema.nullish(),
  })
  .refine(
    (value) =>
      value.buttons.filter((b) => b.action.type === "close").length <= 1 &&
      value.buttons.filter((b) => b.action.type !== "close").length <= 1,
  );
const deliveryBase = { campaign_id: id, priority: z.number().int().min(0).max(100) };
// 服务端已将旧 card 改名为 banner；判别值与内容字段必须同步，否则有效投放会被丢弃。
export const marketingDeliverySchema = z.discriminatedUnion("resource_position", [
  z.object({ ...deliveryBase, resource_position: z.literal("banner"), banner }),
  z.object({ ...deliveryBase, resource_position: z.literal("popup"), popup: marketingPopupSchema }),
]);
const envelope = z.object({
  code: z.literal(0),
  data: z.object({
    server_time: z.number().finite(),
    // 请求头带的是真实界面语言；服务端可能原样回显 ja-JP 等，响应校验不能只认中英。
    language: z.enum(SUPPORTED_LOCALES),
    deliveries: z.array(z.unknown()).max(32),
  }),
});

export type MarketingAsset = z.infer<typeof marketingAssetSchema>;
export type MarketingAction = z.infer<typeof marketingActionSchema>;
export type MarketingPopup = z.infer<typeof marketingPopupSchema>;
export type MarketingVisual = z.infer<typeof marketingVisualSchema>;
export type MarketingDelivery = z.infer<typeof marketingDeliverySchema>;
export type MarketingBannerDelivery = Extract<MarketingDelivery, { resource_position: "banner" }>;
export type MarketingPopupDelivery = Extract<MarketingDelivery, { resource_position: "popup" }>;
export type MarketingTouchSnapshot = ReturnType<typeof parseMarketingTouchResponse>;

/** 单条坏投放不影响其他资源位；外层失败不能伪装成成功空结果。 */
export function parseMarketingTouchResponse(input: unknown) {
  const { data } = envelope.parse(input);
  const deliveries: MarketingDelivery[] = [];
  let rejectedCount = 0;
  const positions = new Set<string>();
  for (const raw of data.deliveries) {
    const result = marketingDeliverySchema.safeParse(raw);
    if (!result.success || positions.has(result.data.resource_position)) {
      rejectedCount++;
      continue;
    }
    positions.add(result.data.resource_position);
    deliveries.push(result.data);
  }
  return {
    serverTime: data.server_time * 1000,
    language: data.language,
    deliveries,
    rejectedCount,
  };
}
