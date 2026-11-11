// SHARE-WF03：实际 session 的去执行化快照可通过 SHARE_PARITY_PREVIEW 指定，原数据不入仓。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";
async function fixturePreview() {
  const [seed] = JSON.parse(
    await readFile(
      new URL(
        "../../../../../../../services/test/fixtures/share-content-blocks.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const payload = structuredClone(seed.payload);
  payload.duration_ms = 2525893;
  payload.run.usage.spentTokens = 34528659;
  payload.artifacts = payload.artifacts
    .slice(0, 3)
    .map((artifact) =>
      artifact.kind === "file" || artifact.kind === "markdown"
        ? { ...artifact, preview_text: "# 冻结文档\n\n" + "完整报告内容。".repeat(100) }
        : artifact,
    );
  const base = { createdAt: 1, turnId: "t1", productTurnId: "share-product-turn-1" };
  return {
    schema_version: 1,
    share: {
      title: "SHARE-WF03",
      access_mode: "public_readonly",
      created_at: 1,
      expires_at: 9999999999999,
    },
    artifacts: payload.artifacts
      .filter((artifact) => artifact.preview_text !== undefined)
      .map((artifact) => ({
        artifact_id: artifact.resource_id,
        logical_artifact_key: artifact.resource_id,
        producer_product_turn_id: "share-product-turn-1",
        artifact_version: 1,
        state: "current",
        ref: `zcode-artifact://share/${artifact.resource_id}`,
        artifact_type: "text",
        display_name: `${artifact.title}.md`,
        extension: "md",
        mime_type: "text/markdown",
        size_bytes: Buffer.byteLength(artifact.preview_text),
        sha256: createHash("sha256").update(artifact.preview_text).digest("hex"),
        url: `https://resources.invalid/${artifact.resource_id}`,
        url_expires_at: 9999999999999,
      })),
    integrity: { projection_sha256: "a".repeat(64), artifact_set_sha256: "b".repeat(64) },
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
        kind: "assistantText",
        state: "complete",
        text: "运行摘要",
      },
      {
        ...base,
        rowId: 5,
        createdAtSeq: 5,
        kind: "toolCall",
        toolCallId: "write-missing-image",
        toolName: "Write",
        status: "success",
        input: { file_path: "/workspace/missing-preview.png" },
        inputText: '{"file_path":"/workspace/missing-preview.png"}',
      },
      {
        ...base,
        rowId: 3,
        createdAtSeq: 3,
        kind: "turnHeader",
        turnId: "t2",
        productTurnId: "share-product-turn-2",
        origin: "backgroundResult",
        state: "completedSuccess",
        startedAt: 1,
      },
      {
        ...base,
        rowId: 4,
        createdAtSeq: 4,
        kind: "assistantText",
        turnId: "t2",
        productTurnId: "share-product-turn-2",
        state: "complete",
        text: "完成摘要",
      },
    ],
    content_blocks: [
      { ...seed, version: 2, fallback_row_id: 2, payload: { ...payload, completion: false } },
      {
        ...seed,
        id: "share-content-2",
        version: 2,
        product_turn_id: "share-product-turn-2",
        fallback_row_id: 4,
        payload: { ...payload, completion: true },
      },
    ],
  };
}
const preview = process.env.SHARE_PARITY_PREVIEW
  ? JSON.parse(await readFile(process.env.SHARE_PARITY_PREVIEW, "utf8"))
  : await fixturePreview();
const baseUrl = process.env.SHARE_E2E_BASE_URL || "http://127.0.0.1:5187";
const output = process.env.SHARE_E2E_ARTIFACTS || "/tmp/share-workflow-parity";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  for (const locale of ["cn/share", "share"])
    for (const width of [390, 1280])
      for (const theme of ["zai-light", "zai-dark"]) {
        const context = await browser.newContext({
          viewport: { width, height: 1000 },
          reducedMotion: "reduce",
        });
        await context.addInitScript((theme) => localStorage.setItem("zcode-theme", theme), theme);
        const page = await context.newPage();
        const errors = [],
          external = [];
        page.on("pageerror", (e) => {
          if (errors.length < 10) errors.push(e.stack ?? e.message);
        });
        await page.route("**/*", async (route) => {
          const url = new URL(route.request().url());
          if (url.pathname.endsWith("/shares/parity/preview"))
            return route.fulfill({
              contentType: "application/json",
              body: JSON.stringify({ code: 0, msg: "", data: preview }),
            });
          if (
            url.origin === new URL(baseUrl).origin &&
            url.pathname.startsWith("/share/") &&
            route.request().isNavigationRequest()
          ) {
            const response = await route.fetch({ url: `${baseUrl}/cn${url.pathname}` });
            return route.fulfill({ response });
          }
          if (url.origin === new URL(baseUrl).origin) return route.continue();
          external.push(url.hostname);
          return route.abort();
        });
        await page.goto(`${baseUrl}/${locale}/parity`);
        const cards = page.locator("[data-share-content-block]");
        await cards.nth(1).waitFor();
        assert.equal(await cards.count(), 2);
        assert.equal(await page.locator("[data-share-workflow-run]").count(), 1);
        assert.equal(
          await page.locator('[data-conversation-share-row-kind="artifact"]').count(),
          0,
        );
        if (!process.env.SHARE_PARITY_PREVIEW) {
          for (const trigger of await page
            .locator('[data-conversation-share-history-trigger][data-history-open="false"]')
            .all())
            await trigger.click();
          const imageTool = page
            .locator('[data-conversation-share-row-kind="toolCall"]')
            .filter({ hasText: "missing-preview.png" });
          const toggle = imageTool.locator('[role="button"][aria-expanded="false"]').first();
          if (await toggle.count()) await toggle.click();
          await imageTool
            .getByText(locale === "cn/share" ? "预览不可用" : "Preview unavailable", {
              exact: true,
            })
            .waitFor();
          assert.doesNotMatch(await imageTool.innerText(), /Loading|正在加载/);
          await imageTool.screenshot({
            path: `${output}/image-${locale.replaceAll("/", "-")}-${width}-${theme}.png`,
          });
        }
        const completion = cards.nth(1);
        await completion.scrollIntoViewIfNeeded();
        await completion.locator('[data-testid="workflow-card-open-details"]').click();
        await page.getByRole("dialog").waitFor();
        await page.keyboard.press("Escape");
        const text = await completion.innerText();
        assert.match(text, /42/);
        assert.match(text, /34\.53/);
        assert.match(text, /9/);
        assert.match(text, /5/);
        assert.doesNotMatch(text, /阶段与参与者|Phases and participants|unavailable|不可用/);
        await completion.screenshot({
          path: `${output}/completion-${locale.replaceAll("/", "-")}-${width}-${theme}.png`,
        });
        for (const artifact of preview.content_blocks[1].payload.artifacts) {
          await completion.locator("button").filter({ hasText: artifact.title }).first().click();
          const dialog = page.getByRole("dialog");
          await dialog.waitFor();
          if (artifact.kind === "board")
            assert.ok((await dialog.locator('[data-testid="artifact-board-card"]').count()) > 0);
          else {
            assert.ok(artifact.preview_text?.length > 100);
            assert.doesNotMatch(await dialog.innerText(), /Preview failed|加载失败/);
            assert.ok((await dialog.innerText()).length > 500);
          }
          await dialog.screenshot({
            path: `${output}/${artifact.id}-${locale.replaceAll("/", "-")}-${width}-${theme}.png`,
          });
          await page.keyboard.press("Escape");
        }
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
          false,
        );
        assert.deepEqual(errors, []);
        assert.deepEqual(external, []);
        await context.close();
      }
  console.log(
    `SHARE-WF03: ${process.env.SHARE_PARITY_PREVIEW ? "captured session" : "fixture"}, eight locale/viewport/theme variants passed; no artifact network fetch`,
  );
} finally {
  await browser.close();
}
