import { createHash } from "node:crypto";
import {
  PLUGIN_DISCOVERY_PAGE_SIZE,
  type PluginDiscoveryCandidate,
  type SearchPluginsInput,
  type SearchPluginsOutput,
} from "@zcode/contracts";
import { isDiscoverableOfficialPlugin, resolveLocalizedText } from "@zcode/shared";

const VERSION = "bm25-v1";
const normalize = (value: string) => value.normalize("NFKC").toLowerCase().trim();
const compareId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function* tokens(value: string): Generator<string> {
  // 汉字不能跨标点、语言或字段拼接；单汉字只通过完整名称命中。
  for (const [run] of value.matchAll(/\p{Script=Han}+|(?:(?!\p{Script=Han})[\p{L}\p{N}])+/gu)) {
    if (!/^\p{Script=Han}/u.test(run)) {
      yield run;
      continue;
    }
    let previous = "";
    for (const char of run) {
      if (previous) yield previous + char;
      previous = char;
    }
  }
}

function field(values: string[], query: ReadonlySet<string>, unique: boolean) {
  const matches = new Map<string, number>();
  const seen = unique ? new Set<string>() : undefined;
  let length = 0;
  for (const value of new Set(values)) {
    for (const term of tokens(value)) {
      if (seen?.has(term)) continue;
      seen?.add(term);
      length++;
      if (query.has(term)) matches.set(term, (matches.get(term) ?? 0) + 1);
    }
  }
  return { matches, length };
}

type Field = ReturnType<typeof field>;

function scoring(fields: Field[], k1: number, b: number) {
  let documents = 0;
  let totalLength = 0;
  const df = new Map<string, number>();
  for (const { length, matches } of fields) {
    if (length === 0) continue;
    documents++;
    totalLength += length;
    for (const term of matches.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const idf = new Map(
    [...df].map(([term, n]) => [term, Math.log1p((documents - n + 0.5) / (n + 0.5))]),
  );
  const average = documents ? totalLength / documents : 0;
  return ({ matches, length }: Field) => {
    if (!length) return 0;
    const norm = k1 * (1 - b + (b * length) / average);
    let score = 0;
    // 相同词频的加法顺序也要一致，避免翻译字段重排造成浮点尾差并打破 ID 平局。
    for (const [term, tf] of [...matches].sort(([a], [b]) => compareId(a, b))) {
      score += (idf.get(term)! * tf * (k1 + 1)) / (tf + norm);
    }
    return score;
  };
}

/** 只对调用方已过滤的官方目录评分。参数仅用于离线标注集验证，线上使用冻结值。 */
export function rankVisiblePlugins(
  catalog: readonly PluginDiscoveryCandidate[],
  query: string,
  { nameWeight = 4, k1 = 1.2, detailB = 0.75 } = {},
): PluginDiscoveryCandidate[] {
  const words = new Set(tokens(query));
  const docs = catalog.map((entry) => {
    const name = normalize(entry.name);
    const displays = [entry.displayName ?? "", ...Object.values(entry.displayNameI18n ?? {})].map(
      normalize,
    );
    const tier =
      query === name || query === normalize(entry.pluginId)
        ? 2
        : query.length > 0 && displays.includes(query)
          ? 1
          : 0;
    const detail = [
      entry.description ?? "",
      entry.category ?? "",
      ...Object.values(entry.descriptionI18n ?? {}),
      ...(entry.examplePrompts ?? []),
    ].map(normalize);
    return {
      entry,
      tier,
      name: field([name, ...displays], words, true),
      detail: field(detail, words, false),
    };
  });
  const nameScore = scoring(
    docs.map((doc) => doc.name),
    k1,
    0,
  );
  const detailScore = scoring(
    docs.map((doc) => doc.detail),
    k1,
    detailB,
  );
  return docs
    .map((doc) => ({ ...doc, score: nameWeight * nameScore(doc.name) + detailScore(doc.detail) }))
    .filter((doc) => doc.tier || doc.score > 0)
    .sort(
      (a, b) =>
        b.tier - a.tier || b.score - a.score || compareId(a.entry.pluginId, b.entry.pluginId),
    )
    .map((doc) => doc.entry);
}

function cursorRevision(query: string, visible: PluginDiscoveryCandidate[]) {
  // 非命中文档也会影响字段统计。按 ID 和对象键固定顺序，目录重排不应使游标失效。
  const ordered = visible.toSorted((a, b) => compareId(a.pluginId, b.pluginId));
  const snapshot = JSON.stringify([VERSION, query, ordered], (_, value: unknown) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => compareId(a, b)))
      : value,
  );
  return VERSION + ":" + createHash("sha256").update(snapshot).digest("hex").slice(0, 24);
}

export function searchPluginCatalog(
  catalog: readonly PluginDiscoveryCandidate[],
  input: SearchPluginsInput,
  stale: boolean,
): SearchPluginsOutput {
  const query = normalize(input.query);
  const visible = catalog.filter((entry) => isDiscoverableOfficialPlugin(entry.pluginId));
  const ranked = rankVisiblePlugins(visible, query);
  const revision =
    input.cursor !== undefined || ranked.length > PLUGIN_DISCOVERY_PAGE_SIZE
      ? cursorRevision(query, visible)
      : "";
  let offset = 0;
  if (input.cursor !== undefined) {
    const match = /^([^:]+:[a-f0-9]{24}):([1-9]\d*)$/u.exec(input.cursor);
    if (!match || match[1] !== revision) {
      throw new Error("plugin_search_cursor_expired: restart the search without a cursor");
    }
    offset = Number(match[2]);
    if (
      !Number.isSafeInteger(offset) ||
      offset >= ranked.length ||
      offset % PLUGIN_DISCOVERY_PAGE_SIZE !== 0
    )
      throw new Error("plugin_search_cursor_invalid");
  }
  const locale = /\p{Script=Han}/u.test(query) ? "zh-CN" : "en-US";
  // 检索全文留在目录侧；模型只拿有界摘要，避免示例提示词和全语言 map 挤爆工具结果预算。
  const plugins = ranked.slice(offset, offset + PLUGIN_DISCOVERY_PAGE_SIZE).map((entry) => ({
    pluginId: entry.pluginId,
    name: entry.name,
    displayName: resolveLocalizedText(locale, entry.displayName, entry.displayNameI18n)?.slice(
      0,
      128,
    ),
    description: resolveLocalizedText(locale, entry.description, entry.descriptionI18n)?.slice(
      0,
      384,
    ),
    installed: entry.installed,
    enabled: entry.enabled,
    action: entry.action,
    scope: entry.scope,
  }));
  const next = offset + plugins.length;
  return { plugins, stale, ...(next < ranked.length ? { cursor: `${revision}:${next}` } : {}) };
}
