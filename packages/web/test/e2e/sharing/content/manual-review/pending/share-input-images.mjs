// SHARE-IMG01：本地网络 fixture，验证匿名分享页的输入图片及加载失败回退。
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";
const baseUrl = process.env.SHARE_E2E_BASE_URL || "http://127.0.0.1:5186";
const output = process.env.SHARE_E2E_ARTIFACTS || "/tmp/share-input-images-e2e";
await mkdir(output, { recursive: true });
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAKAAAABQCAIAAAARP+ljAAAA3UlEQVR4nO3RMQ3AMBDAwMDp3LlwCrZzEQVGJP9JRuBb//2M6nq/Ua3jxwEDBgwYMGDAIzp+HDBgwIABAwY8IsDxAMcDHA9wPMDxAMcDHA9wPMDxAMcDHA9wPMDxAMcDHA9wPMDxAMcDHA9wPMDxAMcDHA9wPMDxAMcDHA9wPMDxAMcDHA9wPMDxAMcDHA9wPMDxAMcDHA9wPMDxAMcDHA9wPMDxAMcDHA9wPMDxAMcDHA9wPMDxAMcDHA9wPMDxAMcDHA9wPMDxAMcDHA9wPMDxAMcDHA9wPMDxAMfbNAF3wYemXYoAAAAASUVORK5CYII=",
  "base64",
);
const base = { turnId: "turn-1", productTurnId: "product-1", createdAt: 1 };
const input = [
  ["image-1", "photo.png", "image/png"],
  ["broken-1", "broken.png", "image/png"],
  ["missing-1", "unavailable.png", "image/png"],
  ["text-1", "notes-with-a-long-name.txt", "text/plain"],
];
const artifacts = [
  ...input.filter(([id]) => id !== "missing-1"),
  ["thumb-1", "thumb.png", "image/png"],
].map(([id, name, mime]) => ({
  artifact_id: id,
  logical_artifact_key: id,
  producer_product_turn_id: base.productTurnId,
  artifact_version: 1,
  state: "current",
  ref: `zcode-artifact://share/${id}`,
  artifact_type: mime.startsWith("image/") ? "image" : "text",
  display_name: name,
  extension: name.split(".").at(-1),
  mime_type: mime,
  size_bytes: png.length,
  sha256: "a".repeat(64),
  url: `https://resources.example.com/${id}`,
  url_expires_at: 9999999999999,
}));
const preview = {
  schema_version: 1,
  share: {
    title: "Input image preview",
    access_mode: "public_readonly",
    created_at: 1,
    expires_at: 9999999999999,
  },
  rows: [
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
      kind: "userInput",
      origin: "realUser",
      text: "这个图里面是啥内容",
      attachments: input.map(([id, fileName, mime]) => ({
        ref: `zcode-artifact://share/${id}`,
        fileName,
        mime,
        bytes: png.length,
        ...(id === "image-1" ? { previewRef: "zcode-artifact://share/thumb-1" } : {}),
      })),
    },
    {
      ...base,
      rowId: 3,
      createdAtSeq: 3,
      kind: "assistantText",
      state: "complete",
      text: "SHARE_IMG01_RESPONSE",
    },
  ],
  artifacts,
  integrity: { projection_sha256: "a".repeat(64), artifact_set_sha256: "b".repeat(64) },
};
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  for (const locale of ["cn/share", "share"])
    for (const width of [375, 1280])
      for (const theme of ["zai-light", "zai-dark"]) {
        const context = await browser.newContext({
          viewport: { width, height: 900 },
          reducedMotion: "reduce",
        });
        await context.addInitScript((theme) => localStorage.setItem("zcode-theme", theme), theme);
        const page = await context.newPage();
        const errors = [],
          requests = [],
          diagnostics = [];
        page.on("pageerror", (e) => errors.length < 5 && errors.push(e.stack ?? e.message));
        page.on("console", (msg) => {
          if (msg.text().includes("share-input-image")) diagnostics.push(msg.text());
        });
        await context.route("**/*", async (route) => {
          const url = new URL(route.request().url());
          if (url.pathname.endsWith("/shares/input-images/preview"))
            return route.fulfill({
              contentType: "application/json",
              body: JSON.stringify({ code: 0, msg: "", data: preview }),
            });
          if (url.hostname === "resources.example.com") {
            requests.push(url.pathname);
            if (url.pathname === "/broken-1")
              return route.fulfill({ status: 404, body: "Missing image" });
            return route.fulfill({ contentType: "image/png", body: png });
          }
          if (
            url.origin === new URL(baseUrl).origin &&
            url.pathname.startsWith("/share/") &&
            route.request().isNavigationRequest()
          ) {
            const response = await route.fetch({ url: `${baseUrl}/cn${url.pathname}` });
            return route.fulfill({ response });
          }
          if (url.origin === new URL(baseUrl).origin) return route.continue();
          return route.abort();
        });
        await page.goto(`${baseUrl}/${locale}/input-images`);
        const attachments = page.locator('[data-v4-user-input-attachments="true"]');
        await attachments.waitFor();
        const image = attachments.getByRole("img", { name: "photo.png", exact: true });
        assert.equal(
          await image.count(),
          1,
          "Input image must render a thumbnail, not only a file pill",
        );
        await image.scrollIntoViewIfNeeded();
        await page.waitForFunction(() => {
          const img = document.querySelector('img[alt="photo.png"]');
          return img?.complete && img.naturalWidth > 0;
        });
        assert.equal(await image.getAttribute("src"), "https://resources.example.com/thumb-1");
        const link = attachments.getByRole("link", { name: "photo.png", exact: true });
        assert.equal(await link.getAttribute("href"), "https://resources.example.com/image-1");
        const popupPromise = page.waitForEvent("popup");
        await link.click();
        const popup = await popupPromise;
        await popup.waitForLoadState();
        assert.equal(popup.url(), "https://resources.example.com/image-1");
        await popup.close();
        await attachments
          .locator('[data-v4-user-input-attachment-pill="true"]')
          .filter({ hasText: "broken.png" })
          .waitFor();
        assert.equal(await attachments.getByRole("img", { name: "broken.png" }).count(), 0);
        assert.equal(
          await attachments.getByRole("link", { name: /broken.png/u }).getAttribute("href"),
          "https://resources.example.com/broken-1",
        );
        assert.equal(await attachments.locator('[aria-disabled="true"]').count(), 1);
        assert.equal(
          await attachments.locator('[data-v4-user-input-attachment-pill="true"]').count(),
          3,
        );
        assert.ok(requests.includes("/thumb-1"), "Thumbnail bytes must be requested");
        if (process.env.SHARE_E2E_EXPECT_DIAGNOSTICS === "true") {
          assert.ok(
            diagnostics.some((line) => line.includes("preview failed")),
            "Failed image must produce a diagnostic without signed URLs",
          );
        }
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
          false,
          `${locale}/${width}/${theme} overflow`,
        );
        const pill = await attachments
          .locator('[data-v4-user-input-attachment-pill="true"]')
          .first()
          .boundingBox();
        assert.ok(pill && pill.height < 48, "File pills must not stretch to thumbnail height");
        const box = await image.boundingBox();
        assert.ok(box?.width > 0 && box.width <= 96 && box.height <= 96);
        assert.deepEqual(errors, []);
        await page.screenshot({
          path: `${output}/${locale.replaceAll("/", "-")}-${width}-${theme}.png`,
          fullPage: true,
        });
        await context.close();
      }
  console.log(
    "SHARE-IMG01: 8 browser variants passed (thumbnail bytes, original link, failed/missing images, files, locale, themes, overflow)",
  );
} finally {
  await browser.close();
}
