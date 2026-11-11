import { z } from "zod";
import { SUPPORTED_LOCALES } from "../protocol.js";
import { isDiscoverableOfficialPlugin } from "../plugin-store-visibility.js";

export const PLUGIN_LOCALIZED_LIMITS = {
  entries: 16,
  keyLength: 64,
  textLength: 4_000,
  textBytes: 4_096,
  mapBytes: 24 * 1_024,
} as const;

const encoder = new TextEncoder();
const jsonBytes = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;
const safePrefix = (text: string, length: number) =>
  text.slice(0, length).replace(/[\uD800-\uDBFF]$/u, "");

function boundLocalizedValue(text: string, byteLimit: number): string {
  let end = Math.min(text.length, PLUGIN_LOCALIZED_LIMITS.textLength);
  const prefix = safePrefix(text, end);
  if (jsonBytes(prefix) <= byteLimit) return prefix;
  let start = 0;
  while (start < end) {
    const middle = Math.ceil((start + end) / 2);
    if (jsonBytes(safePrefix(text, middle)) <= byteLimit) start = middle;
    else end = middle - 1;
  }
  return safePrefix(text, start);
}

/** 旧实现只截每条译文，条目数与转义后的字节数仍可撑大持久化事件。入口与发布共用此边界。 */
export function boundPluginLocalizedText(
  input?: Record<string, string>,
): Record<string, string> | undefined {
  if (!input) return undefined;
  const result: Record<string, string> = Object.create(null);
  let count = 0;
  let bytes = 2;
  const validKey = (key: string) =>
    key.length > 0 && key.length <= PLUGIN_LOCALIZED_LIMITS.keyLength && Object.hasOwn(input, key);
  const add = (key: string) => {
    if (!validKey(key) || Object.hasOwn(result, key) || count >= PLUGIN_LOCALIZED_LIMITS.entries)
      return;
    const overhead = jsonBytes(key) + 1 + (count > 0 ? 1 : 0);
    const available = Math.min(
      PLUGIN_LOCALIZED_LIMITS.textBytes,
      PLUGIN_LOCALIZED_LIMITS.mapBytes - bytes - overhead,
    );
    if (available < 2) return;
    const value = boundLocalizedValue(input[key]!, available);
    result[key] = value;
    bytes += overhead + jsonBytes(value);
    count += 1;
  };
  // 会话由多个语言不同的客户端共享；优先保留所有界面语言，不引入会话级当前语言状态。
  for (const locale of SUPPORTED_LOCALES) {
    if (validKey(locale) && input[locale]) {
      add(locale);
      continue;
    }
    const language = locale.split("-")[0];
    for (const key in input) {
      if (validKey(key) && input[key] && key.split("-")[0] === language) {
        add(key);
        break;
      }
    }
  }
  for (const key in input) {
    if (count >= PLUGIN_LOCALIZED_LIMITS.entries || bytes + 7 > PLUGIN_LOCALIZED_LIMITS.mapBytes)
      break;
    add(key);
  }
  return count ? result : undefined;
}

const localized = z
  .record(
    z.string().min(1).max(PLUGIN_LOCALIZED_LIMITS.keyLength),
    z
      .string()
      .max(PLUGIN_LOCALIZED_LIMITS.textLength)
      .refine(
        (value) =>
          value.length <= PLUGIN_LOCALIZED_LIMITS.textLength &&
          jsonBytes(value) <= PLUGIN_LOCALIZED_LIMITS.textBytes,
        "Localized text exceeds its encoded byte budget",
      ),
  )
  .refine(
    (value) =>
      Object.keys(value).length <= PLUGIN_LOCALIZED_LIMITS.entries &&
      jsonBytes(value) <= PLUGIN_LOCALIZED_LIMITS.mapBytes,
    "Localized map exceeds its entry or encoded byte budget",
  );
export const pluginInstallRequestPayloadSchema = z
  .object({
    kind: z.literal("pluginInstall"),
    pluginId: z.string().max(256).refine(isDiscoverableOfficialPlugin),
    name: z.string().max(256),
    displayName: z.string().max(512).optional(),
    displayNameI18n: localized.optional(),
    description: z.string().max(4_000).optional(),
    descriptionI18n: localized.optional(),
    icon: z.string().max(2_048).optional(),
    reason: z.string().trim().min(1).max(2_000),
    action: z.enum(["install", "enable"]),
    // install/workspace 明确授权安装并启用当前工作区；保留历史 install/user 载荷。
    scope: z.enum(["user", "workspace"]),
    toolCallId: z.string(),
  })
  .strict();
export type PluginInstallRequestPayload = z.infer<typeof pluginInstallRequestPayloadSchema>;
