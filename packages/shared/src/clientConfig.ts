import { z } from "zod";
import { parsePluginStoreOrder, type PluginStoreOrder } from "./pluginStoreOrder.js";

/** 气泡文案：语言标签 → 纯文本；只含校验通过的条目，客户端没有默认文案。 */
export type DraftModelMigrationNotice = Readonly<Record<string, string>>;

/** 运营下发的草稿模型迁移规则；语义见 docs/chat/draft-model-migration.md。 */
export interface DraftModelMigrationRule {
  revision: number;
  targetModelId: string;
  sourceModelIds?: string[];
  /** 缺省或没有合法条目时不弹气泡，迁移照常。 */
  notice?: DraftModelMigrationNotice;
}

/** 只允许显式接入的公开字段进入服务快照，不透传账户或 Provider 配置。 */
export interface ClientConfigSnapshot {
  pluginStoreOrder: PluginStoreOrder | null;
  zsrcUrl: string | null;
  uiPluginRecommendations: { pluginId: string; surfaceId: string }[];
  draftModelMigration: DraftModelMigrationRule | null;
}

/** 刷新间隔属于读取方的缓存策略，不进入公开快照。 */
export interface ClientConfigResponse {
  snapshot: ClientConfigSnapshot;
  refreshIntervalMs: number;
}

const uiPluginRecommendationsSchema = z.array(
  z.object({
    pluginId: z.string().trim().min(1),
    surfaceId: z.string().trim().min(1),
  }),
);

const migrationModelIdSchema = z.string().trim().min(1);
// 迁移字段任一非法时整条规则失效，避免半条规则把草稿切到未声明的模型；notice 另行逐条校验。
const draftModelMigrationSchema = z.object({
  revision: z.number().int().positive(),
  targetModelId: migrationModelIdSchema,
  sourceModelIds: z.array(migrationModelIdSchema).min(1).optional(),
});

const NOTICE_LOCALE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const NOTICE_MAX_CHARACTERS = 256;
const NOTICE_LINE_BREAK_PATTERN = /[\r\n\u2028\u2029]/;

// 文案只是提示：非法条目只丢自己，整张表不可用时视为未配置，不能连带让迁移规则失效。
function parseDraftModelMigrationNotice(value: unknown): DraftModelMigrationNotice | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value).flatMap(([locale, text]) => {
    if (!NOTICE_LOCALE_PATTERN.test(locale) || typeof text !== "string") return [];
    const trimmed = text.trim();
    return trimmed &&
      Array.from(trimmed).length <= NOTICE_MAX_CHARACTERS &&
      !NOTICE_LINE_BREAK_PATTERN.test(trimmed)
      ? [[locale, trimmed] as const]
      : [];
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function parseDraftModelMigration(value: unknown): DraftModelMigrationRule | null {
  const rule = draftModelMigrationSchema.safeParse(value).data;
  if (!rule) return null;
  const notice = parseDraftModelMigrationNotice((value as { notice?: unknown }).notice);
  return notice ? { ...rule, notice } : rule;
}

const zsrcSchema = z.object({
  url: z
    .string()
    .trim()
    .url()
    .refine((value) => /^https?:\/\//i.test(value)),
});

// 运营可把刷新调到分钟级；上限保持原有的一小时，缺省或非法值不能让客户端比原来更频繁或更慢。
const REFRESH_INTERVAL_DEFAULT_SECONDS = 3600;
const REFRESH_INTERVAL_MIN_SECONDS = 60;
const REFRESH_INTERVAL_MAX_SECONDS = 3600;

/** ClientConfigService 与 Built-in 刷新共用；入参为响应的 data.configs。 */
export function resolveClientConfigRefreshIntervalMs(configs: unknown): number {
  const value =
    configs && typeof configs === "object" && !Array.isArray(configs)
      ? (configs as Record<string, unknown>).clientConfigRefreshIntervalSeconds
      : undefined;
  const seconds =
    typeof value === "number" && Number.isFinite(value) && value > 0
      ? Math.min(
          Math.max(Math.floor(value), REFRESH_INTERVAL_MIN_SECONDS),
          REFRESH_INTERVAL_MAX_SECONDS,
        )
      : REFRESH_INTERVAL_DEFAULT_SECONDS;
  return seconds * 1000;
}

export const clientConfigReadOptionsSchema = z.object({
  forceRefresh: z.boolean().optional(),
});
export type ClientConfigReadOptions = z.infer<typeof clientConfigReadOptionsSchema>;

const envelopeSchema = z.object({
  code: z.literal(0),
  data: z
    .object({
      configs: z
        .object({
          pluginStoreOrder: z.unknown().optional(),
          zsrc: z.unknown().optional(),
          uiPluginRecommendations: z.unknown().optional(),
          draftModelMigration: z.unknown().optional(),
          clientConfigRefreshIntervalSeconds: z.unknown().optional(),
        })
        .nullish(),
    })
    .nullish(),
});

export function parseClientConfigResponse(payload: unknown): ClientConfigResponse {
  const parsed = envelopeSchema.safeParse(payload);
  if (!parsed.success) throw new Error("Invalid public client config response");
  const configs = parsed.data.data?.configs;
  return {
    snapshot: {
      pluginStoreOrder: parsePluginStoreOrder(configs?.pluginStoreOrder),
      uiPluginRecommendations:
        uiPluginRecommendationsSchema.safeParse(configs?.uiPluginRecommendations).data ?? [],
      zsrcUrl: zsrcSchema.safeParse(configs?.zsrc).data?.url ?? null,
      draftModelMigration: parseDraftModelMigration(configs?.draftModelMigration),
    },
    refreshIntervalMs: resolveClientConfigRefreshIntervalMs(configs),
  };
}

export function parseClientConfigSnapshot(payload: unknown): ClientConfigSnapshot {
  return parseClientConfigResponse(payload).snapshot;
}
