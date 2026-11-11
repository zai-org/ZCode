// Run from the repository root: pnpm exec tsx apps/zcode-cli/packages/bootstrap/tests/data/plugin-discovery-search/evaluate.mjs [--performance]
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { rankVisiblePlugins, searchPluginCatalog } from "../../../src/plugin-discovery/search.ts";

const read = (name) => readFile(new URL(name, import.meta.url), "utf8");
const { listings, sourceSha256 } = JSON.parse(await read("catalog.json"));
const catalog = listings.map((entry) => ({
  ...entry,
  pluginId: entry.name + "@zcode-plugins-official",
  installed: false,
  enabled: false,
  action: "install",
  scope: "user",
}));
const normalize = (v) => v.normalize("NFKC").toLocaleLowerCase("en-US");
const labels = (await read("queries.tsv"))
  .trimEnd()
  .split("\n")
  .filter((line) => !line.startsWith("#"))
  .map((line) => {
    const [split, query, ids, weak] = line.split("\t");
    const gold = ids.split(",");
    for (const name of gold)
      assert.ok(
        catalog.some((p) => p.name === name),
        name,
      );
    return { split, query, gold, weak };
  });
assert.equal(new Set(labels.map((r) => r.query)).size, labels.length);
assert.equal(labels.length >= 60, true);
const tune = labels.filter((r) => r.split === "tune");
const holdout = labels.filter((r) => r.split === "holdout");
assert.equal(tune.length + holdout.length, labels.length);
// !2855 原 4:1 子串规则；对同一批可见条目排序。
function baseline(query) {
  const words = normalize(query)
    .split(/[\s,，;；]+/u)
    .filter(Boolean);
  return catalog
    .map((p) => {
      const names = normalize(
        [p.pluginId, p.name, p.displayName, ...Object.values(p.displayNameI18n ?? {})].join(" "),
      );
      const detail = normalize(
        [
          p.description,
          p.category,
          ...Object.values(p.descriptionI18n ?? {}),
          ...(p.examplePrompts ?? []),
        ].join(" "),
      );
      const score = words.reduce(
        (sum, w) => sum + (names.includes(w) ? 4 : 0) + (detail.includes(w) ? 1 : 0),
        0,
      );
      return { p, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.p.pluginId.localeCompare(b.p.pluginId))
    .slice(0, 10)
    .map((x) => x.p.name);
}
const production = (query) =>
  searchPluginCatalog(catalog, { query }, false).plugins.map((p) => p.name);
function measure(rows, search) {
  let recall = 0,
    ndcg = 0;
  for (const { query, gold } of rows) {
    const top = search(query);
    const relevant = top.map((name) => gold.includes(name));
    const gain = (rank) => 1 / Math.log2(rank + 2);
    recall += relevant.filter(Boolean).length / gold.length;
    ndcg +=
      relevant.reduce((s, hit, rank) => s + (hit ? gain(rank) : 0), 0) /
      gold.slice(0, 10).reduce((s, _id, rank) => s + gain(rank), 0);
  }
  return { recall: recall / rows.length, ndcg: ndcg / rows.length };
}
const report = {
  sourceSha256,
  count: catalog.length,
  tuneCount: tune.length,
  holdoutCount: holdout.length,
};
if (process.argv.includes("--performance")) {
  const durations = {};
  for (const [n, samples] of [
    [catalog.length, 100],
    [1_000, 40],
    [10_000, 20],
  ]) {
    // 按真实条目的长度与语言分布扩容；ID 保持唯一。
    const synthetic =
      n === catalog.length
        ? catalog
        : Array.from({ length: n }, (_, i) => ({
            ...catalog[i % catalog.length],
            pluginId: `sample-${i}@zcode-plugins-official`,
          }));
    const queries = [
      "CLI",
      "cloud resource profile",
      "企业信息查询",
      "收件箱",
      "编辑 PDF",
      "Jupyter Notebook",
      "浏览器操作",
      "创建工具",
    ];
    for (let i = -8; i < samples; i++) {
      const query = queries[(i + 8) % queries.length];
      const start = performance.now();
      searchPluginCatalog(synthetic, { query }, false);
      const ms = performance.now() - start;
      if (i >= 0) (durations[n] ??= []).push(ms);
    }
  }
  report.timings = Object.fromEntries(
    Object.entries(durations).map(([n, d]) => {
      d.sort((a, b) => a - b);
      return [
        n,
        {
          samples: d.length,
          p50: d[Math.ceil(0.5 * d.length) - 1],
          p95: d[Math.ceil(0.95 * d.length) - 1],
        },
      ];
    }),
  );
  console.log(JSON.stringify(report, null, 2));
  assert.ok(report.timings[catalog.length].p95 <= 50, "real catalog p95 > 50 ms");
} else {
  // 只在调参集比较敏感性；产品参数由规格冻结，留出集只评一次，不回调参数。
  report.tuneGrid = [
    { nameWeight: 4, k1: 1.2, detailB: 0.75 },
    { nameWeight: 2, k1: 1.2, detailB: 0.75 },
    { nameWeight: 6, k1: 1.2, detailB: 0.75 },
    { nameWeight: 4, k1: 0.8, detailB: 0.5 },
    { nameWeight: 4, k1: 1.6, detailB: 0.9 },
  ].map((params) => ({
    ...params,
    ...measure(tune, (query) =>
      rankVisiblePlugins(catalog, normalize(query).trim(), params)
        .slice(0, 10)
        .map((p) => p.name),
    ),
  }));
  report.quality = {};
  for (const [split, rows] of [
    ["tune", tune],
    ["holdout", holdout],
    ["weak", holdout.filter((x) => x.weak)],
  ]) {
    report.quality[split] = { baseline: measure(rows, baseline), bm25: measure(rows, production) };
  }
  report.weak = holdout
    .filter((row) => row.weak)
    .map(({ query, gold }) => ({
      query,
      gold,
      before: baseline(query).findIndex((name) => gold.includes(name)) + 1 || null,
      after: production(query).findIndex((name) => gold.includes(name)) + 1 || null,
    }));
  console.log(JSON.stringify(report, null, 2));
  const h = report.quality.holdout,
    w = report.quality.weak;
  assert.ok(h.bm25.recall >= h.baseline.recall && h.bm25.ndcg >= h.baseline.ndcg);
  assert.ok(w.bm25.ndcg > w.baseline.ndcg);
}
