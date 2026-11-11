import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry = "/packages/ui/test/browser/manual-review/pending/inline-image-mention.fixture.tsx";
const artifacts = join(root, "packages/desktop/.e2e-artifacts/inline-image-mention-browser");
let server, browser, origin;
before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      {
        name: "image-actions-fixture",
        enforce: "pre",
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith("/fixture?")) return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await vite.transformIndexHtml(
                req.url,
                `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"/></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
              ),
            );
          });
        },
      },
      react(),
      tailwindcss(),
    ],
    resolve: { alias: { "@": `${root}packages/ui/src` } },
    optimizeDeps: { entries: [entry.slice(1)] },
    server: {
      host: "127.0.0.1",
      port: 0,
      hmr: false,
      watch: { ignored: ["**/packages/desktop/out/**", "**/.e2e-artifacts/**"] },
    },
  });
  await server.listen();
  origin = server.resolvedUrls.local[0];
  browser = await chromium.launch(
    process.env.CHROME_EXECUTABLE_PATH
      ? { executablePath: process.env.CHROME_EXECUTABLE_PATH }
      : { channel: "chrome" },
  );
});
after(async () => {
  await browser?.close();
  await server?.close();
});

test("IPE07 inline image mention opens the shared preview and preserves workspace boundaries", async () => {
  const checks = [];
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  try {
    page.on("pageerror", (e) => errors.push(e.message));
    const load = async (query = "") => {
      await page.goto(`${origin}fixture?${query.replace(/^\?/, "")}`);
      await page.getByText("不错不错，再来一张", { exact: false }).waitFor();
    };
    const opened = () =>
      page.waitForFunction(
        () => document.querySelector("[data-image-preview-surface] img")?.naturalWidth === 1200,
      );
    await load();
    await page.screenshot({ animations: "disabled", path: join(artifacts, "after-clickable.png") });
    await page.locator("[data-image-file-mention]").click();
    await opened();
    assert.deepEqual(await page.evaluate(() => window.inlineEvidence), [
      { kind: "readMediaPreview", path: "/workspace/images/小桥流水人家.jpg", owner: "local" },
    ]);
    await page.locator("[data-image-preview-surface] img").click({ button: "right" });
    await page.locator("[role=menu]").waitFor();
    assert.ok((await page.locator("[role=menuitem]").allTextContents()).includes("复制图片"));
    await page.screenshot({
      animations: "disabled",
      path: join(artifacts, "after-preview-context.png"),
    });
    checks.push("inline image destination read once and shared preview context menu");
    for (const mode of ["ordinary", "disguised", "traversal", "nested-escape", "http"]) {
      await load("?case=" + mode);
      assert.equal(await page.locator("[data-image-file-mention]").count(), 0);
      await page
        .getByText(mode === "ordinary" ? "README.md" : "小桥流水人家.jpg", { exact: true })
        .click();
      assert.equal(await page.locator("[role=dialog]").count(), 0);
      assert.deepEqual(await page.evaluate(() => window.inlineEvidence), []);
      checks.push(mode + " remains display-only");
    }
    await load("?case=windows");
    await page.locator("[data-image-file-mention]").focus();
    await page.keyboard.press("Enter");
    await opened();
    assert.equal(
      (await page.evaluate(() => window.inlineEvidence))[0].path.replaceAll("\\", "/"),
      "C:/work/images/小桥流水人家.jpg",
    );
    checks.push("Windows destination and Enter keyboard activation");
    for (const [mode, expectedPath] of [
      ["absolute", "/data/images/小桥流水人家.jpg"],
      ["file-url", "/data/images/小桥.jpg"],
    ]) {
      await load(`?case=${mode}&remote`);
      await page.locator("[data-image-file-mention]").click();
      await opened();
      assert.equal((await page.evaluate(() => window.inlineEvidence))[0].path, expectedPath);
      checks.push(`${mode} preserves the absolute path on remote provider`);
    }
    await load("?fail");
    await page.locator("[data-image-file-mention]").click();
    await page.getByRole("alert").waitFor();
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await page.locator("[data-image-file-mention]").click();
    await page.getByRole("alert").waitFor();
    assert.equal((await page.evaluate(() => window.inlineEvidence)).length, 2);
    checks.push("missing image shows error and retries after close");
    await load("?defer");
    await page.locator("[data-image-file-mention]").click();
    await page.getByRole("status").waitFor();
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await page.evaluate(() => window.releaseRead("local"));
    await page.waitForFunction(() => window.resolvedOwners.includes("local"));
    await page.locator("[role=dialog]").waitFor({ state: "hidden" });
    assert.equal(await page.locator("[role=dialog][data-state=open]").count(), 0);
    checks.push("close invalidates pending read");
    await load("?remote&defer");
    await page.locator("[data-image-file-mention]").click();
    await page.getByRole("status").waitFor();
    await page.evaluate(() => window.switchOwner("remote-B"));
    await page.locator('[data-owner="remote-B"]').waitFor();
    await page.waitForFunction(() => !document.querySelector("[role=dialog]"));
    await page.evaluate(() => window.releaseRead("remote-A"));
    await page.waitForFunction(() => window.resolvedOwners.includes("remote-A"));
    assert.equal(await page.locator("[role=dialog][data-state=open]").count(), 0);
    await page.locator("[data-image-file-mention]").click();
    await page.evaluate(() => window.releaseRead("remote-B"));
    await opened();
    assert.deepEqual(
      (await page.evaluate(() => window.inlineEvidence)).map((x) => x.owner),
      ["remote-A", "remote-B"],
    );
    checks.push("same path different remote owner invalidates old read and uses new provider");
    await page.setViewportSize({ width: 390, height: 844 });
    await load("?mobile&dark");
    await page.locator("[data-image-file-mention]").click();
    await opened();
    await page.getByRole("button", { name: "图片操作", exact: true }).click();
    await page.locator("[role=menu]").waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
    await page.screenshot({
      animations: "disabled",
      path: join(artifacts, "after-mobile-menu.png"),
    });
    checks.push("mobile dark preview and more menu with no horizontal overflow");
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("IPE07 native reveal saves once and application identity refreshes", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  try {
    if (process.env.PREVIEW_APP_ICON) {
      const icon = `data:image/png;base64,${(await readFile(process.env.PREVIEW_APP_ICON)).toString("base64")}`;
      await page.addInitScript((value) => {
        window.applicationIcon = value;
      }, icon);
    }
    if (process.env.PREVIEW_SAMPLE) {
      const sample = await readFile(process.env.PREVIEW_SAMPLE, "utf8");
      await page.addInitScript((value) => {
        window.previewSample = value;
      }, sample);
    }
    for (const scenario of ["", "cancelSave", "failSave"]) {
      const cancel = Boolean(scenario);
      await page.goto(`${origin}fixture?${scenario}`);
      await page.locator("[data-image-file-mention]").click();
      const img = page.locator("[data-image-preview-surface] img");
      await img.waitFor();
      await page.waitForFunction(
        () => document.querySelector("[data-image-preview-surface] img")?.naturalWidth === 1200,
      );
      await img.click({ button: "right" });
      const reveal = page.locator('[data-image-preview-action="reveal"]');
      await page.screenshot({ path: join(artifacts, `finder-enabled-${cancel}.png`) });
      await reveal.click();
      await page.waitForFunction(() => window.inlineEvidence.some((e) => e.kind === "saveFile"));
      if (cancel) {
        assert.equal(
          await page.evaluate(
            () => window.inlineEvidence.filter((e) => e.kind === "reveal").length,
          ),
          0,
        );
      } else {
        await page.getByRole("button", { name: "在 Preview 中打开" }).waitFor();
        assert.equal(await page.locator('[data-slot="file-application-icon"]').count(), 1);
        await page.screenshot({ path: join(artifacts, "application-logo.png") });
        await page.getByRole("button", { name: "选择打开方式" }).click();
        await page.locator('[data-file-application-direct="preview"]').waitFor();
        await page.waitForFunction(() =>
          [...document.querySelectorAll('[role="menu"]')].some(
            (el) => getComputedStyle(el).opacity === "1",
          ),
        );
        await page.screenshot({
          animations: "disabled",
          path: join(artifacts, "application-logo-menu.png"),
        });
        await page.keyboard.press("Escape");
        await img.click({ button: "right" });
        await page.waitForFunction(() =>
          [...document.querySelectorAll('[role="menu"]')].some(
            (el) => getComputedStyle(el).opacity === "1",
          ),
        );
        await page.screenshot({
          animations: "disabled",
          path: join(artifacts, "finder-with-logo.png"),
        });
        await reveal.click();
        assert.equal(
          await page.evaluate(
            () => window.inlineEvidence.filter((e) => e.kind === "saveFile").length,
          ),
          1,
        );
        assert.equal(
          await page.evaluate(
            () => window.inlineEvidence.filter((e) => e.kind === "reveal").length,
          ),
          2,
        );
      }
    }
  } finally {
    await page.close();
  }
});

for (const width of [1200, 390]) {
  test(`IPE03/IPE06 side drawing rail ${width}`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    try {
      if (process.env.PREVIEW_SAMPLE) {
        const sample = await readFile(process.env.PREVIEW_SAMPLE, "utf8");
        await page.addInitScript((value) => {
          window.previewSample = value;
        }, sample);
      }
      await page.goto(`${origin}fixture?${width < 600 ? "mobile" : ""}`);
      await page.locator("[data-image-file-mention]").click();
      await page.waitForFunction(
        () => document.querySelector("[data-image-preview-surface] img")?.naturalWidth === 1200,
      );
      const toggle = page.locator("[data-image-preview-annotate]");
      assert.equal(await toggle.getAttribute("aria-expanded"), "false");
      assert.equal(await page.locator('[role="toolbar"]').count(), 0);
      await page.screenshot({
        animations: "disabled",
        path: join(artifacts, `side-collapsed-${width}.png`),
      });
      await toggle.click();
      const rail = await page.locator("[data-image-preview-drawing-rail]").boundingBox();
      assert.ok(
        rail.x >= 0 && rail.x + rail.width <= width && rail.y >= 80 && rail.y + rail.height <= 740,
      );
      await page.locator('[data-image-preview-tool="ellipse"]').click();
      const image = await page.locator("[data-image-preview-surface]").boundingBox();
      await page.mouse.move(image.x + image.width * 0.3, image.y + image.height * 0.3);
      await page.mouse.down();
      await page.mouse.move(image.x + image.width * 0.6, image.y + image.height * 0.6, {
        steps: 10,
      });
      await page.mouse.up();
      assert.equal(await page.locator("[data-annotation-id]").count(), 1);
      await page.screenshot({
        animations: "disabled",
        path: join(artifacts, `side-expanded-${width}.png`),
      });
      await toggle.click();
      assert.equal(await page.locator('[role="toolbar"]').count(), 0);
      assert.equal(await page.locator("[data-annotation-id]").count(), 1);
    } finally {
      await page.close();
    }
  });
}
