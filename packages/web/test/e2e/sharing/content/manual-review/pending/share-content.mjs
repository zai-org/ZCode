// SHARE-WF02：fixture 只拦截网络，不访问真实账号、分享或模型。
import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const blocks = JSON.parse(
  await readFile(resolve("packages/services/test/fixtures/share-content-blocks.json"), "utf8"),
);
for (const artifact of blocks[0].payload.artifacts) {
  if (artifact.kind === "file" || artifact.kind === "markdown")
    artifact.preview_text = `# VERIFIED_DOCUMENT_${artifact.resource_id.endsWith("1") ? "1" : "2"}\n\n实际交付文档正文。`;
}
const baseUrl = process.env.SHARE_E2E_BASE_URL || "http://127.0.0.1:5186";
const artifactDir = process.env.SHARE_E2E_ARTIFACTS || "/tmp/share-content-e2e";
await mkdir(artifactDir, { recursive: true });
const base = { turnId: "share-turn-1", productTurnId: "share-product-turn-1", createdAt: 1 };
const rows = [
  {
    ...base,
    rowId: 1,
    createdAtSeq: 1,
    kind: "turnHeader",
    origin: "userInput",
    state: "completedSuccess",
    startedAt: 1,
  },
  {
    ...base,
    rowId: 2,
    createdAtSeq: 2,
    kind: "assistantText",
    state: "complete",
    text: "SHARE_WF02_FINAL 正文保留。http://127.0.0.1:8080",
  },
  {
    ...base,
    rowId: 3,
    createdAtSeq: 3,
    kind: "assistantText",
    state: "complete",
    text: "SHARE_WF02_FALLBACK 工作流已完成，包含进度看板和交付文档。",
  },
];
rows.push({
  ...base,
  rowId: 4,
  createdAtSeq: 4,
  kind: "assistantText",
  state: "complete",
  text: "EMPTY_WORKFLOW_FALLBACK",
});
blocks.push({
  ...blocks[0],
  id: "share-content-2",
  fallback_row_id: 4,
  resource_ids: [],
  payload: {
    name: "Unavailable workflow",
    completion: false,
    unavailable: "source_unavailable",
    artifacts: [],
  },
});
const artifacts = [1, 2].map((index) => ({
  artifact_id: `share-artifact-${index}`,
  logical_artifact_key: `share-key-${index}`,
  producer_product_turn_id: base.productTurnId,
  artifact_version: 1,
  state: "current",
  ref: `zcode-artifact://share/share-artifact-${index}`,
  artifact_type: "text",
  display_name: `report-${index}.md`,
  extension: "md",
  mime_type: "text/markdown",
  size_bytes: 12,
  sha256: "a".repeat(64),
  url: `https://resources.invalid/report-${index}.md`,
  url_expires_at: 9999999999999,
}));
const preview = {
  schema_version: 1,
  share: {
    title: "SHARE-WF02",
    access_mode: "public_readonly",
    created_at: 1,
    expires_at: 9999999999999,
  },
  rows,
  content_blocks: blocks,
  artifacts,
  integrity: {
    projection_sha256: "a".repeat(64),
    artifact_set_sha256: "b".repeat(64),
    content_blocks_sha256: "c".repeat(64),
  },
};
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  for (const locale of ["cn/share", "share"])
    for (const width of [375, 1280])
      for (const theme of ["zai-light", "zai-dark"]) {
        const context = await browser.newContext({
          viewport: { width, height: 1000 },
          reducedMotion: "reduce",
        });
        await context.addInitScript((value) => localStorage.setItem("zcode-theme", value), theme);
        const page = await context.newPage();
        const errors = [];
        const unexpected = [];
        let version = 2;
        page.on(
          "pageerror",
          (error) => errors.length < 5 && errors.push(error.stack ?? error.message),
        );
        await page.route("**/*", async (route) => {
          const url = new URL(route.request().url());
          if (url.pathname.endsWith("/shares/content-e2e/preview"))
            return route.fulfill({
              contentType: "application/json",
              body: JSON.stringify({
                code: 0,
                msg: "",
                data: {
                  ...preview,
                  content_blocks: blocks.map((block) => ({ ...block, version })),
                },
              }),
            });
          if (url.hostname === "resources.invalid") {
            unexpected.push("CORS-dependent artifact fetch");
            return route.abort();
          }
          // Vite 的资源 base 固定 /cn/share/；部署的英文路径也回退到同一份 index.html。
          if (
            url.origin === new URL(baseUrl).origin &&
            url.pathname.startsWith("/share/") &&
            route.request().isNavigationRequest()
          ) {
            const response = await route.fetch({ url: `${baseUrl}/cn${url.pathname}` });
            return route.fulfill({ response });
          }
          if (url.origin === new URL(baseUrl).origin) return route.continue();
          unexpected.push(url.pathname);
          return route.abort();
        });
        await page.goto(`${baseUrl}/${locale}/content-e2e`);
        await page.locator("[data-share-content-block]").waitFor();
        assert.equal(await page.locator("[data-share-content-block]").count(), 1);
        assert.equal(await page.getByText("EMPTY_WORKFLOW_FALLBACK", { exact: true }).count(), 0);
        assert.match(await page.locator("body").innerText(), /SHARE_WF02_FINAL/u);
        assert.equal(await page.locator("[data-share-local-website]").count(), 0);
        for (const title of ["军棋项目进度看板", "结果表格", "性能图表", "验收指标"]) {
          await page.locator("button").filter({ hasText: title }).first().click();
          if (title === "军棋项目进度看板")
            await page.getByText("模块 14", { exact: true }).waitFor();
          if (title === "验收指标") await page.getByText("43", { exact: true }).waitFor();
          await page.keyboard.press("Escape");
        }
        for (const [index, title] of ["军棋项目交付报告", "军棋游戏启动说明"].entries()) {
          await page.locator("button").filter({ hasText: title }).first().click();
          await page.getByRole("heading", { name: `VERIFIED_DOCUMENT_${index + 1}` }).waitFor();
          await page.keyboard.press("Escape");
        }
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth + 1,
        );
        assert.equal(overflow, false, `${locale}/${width}/${theme} overflow`);
        await page.screenshot({
          path: `${artifactDir}/${locale.replaceAll("/", "-")}-${width}-${theme}.png`,
          fullPage: true,
        });
        version = 99;
        await page.reload();
        await page.locator("[data-share-content-fallback]").first().waitFor();
        // content-visibility:auto 会跳过视口外布局，先实际滚到正文再验证可见。
        await page.getByText(/SHARE_WF02_FINAL/u).scrollIntoViewIfNeeded();
        await page.getByText(/SHARE_WF02_FINAL/u).waitFor();
        await page.getByText(/SHARE_WF02_FALLBACK/u).scrollIntoViewIfNeeded();
        await page.getByText(/SHARE_WF02_FALLBACK/u).waitFor();
        assert.deepEqual(errors, []);
        assert.deepEqual(unexpected, []);
        await context.close();
      }
  console.log(
    "SHARE-WF02: 8 browser variants passed (content, files, fallback, isolation, overflow)",
  );
} finally {
  await browser.close();
}
