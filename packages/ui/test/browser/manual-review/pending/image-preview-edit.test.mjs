import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry = "/packages/ui/test/browser/manual-review/pending/image-preview-edit.fixture.tsx";
const artifacts = join(root, "packages/desktop/.e2e-artifacts/image-preview-edit-browser");
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

async function openPreview(page, query = "locale=zh-CN") {
  await page.goto(`${origin}fixture?${query}`);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('[role="dialog"] img')?.naturalWidth === 1200,
  );
  await page.locator("[data-image-preview-annotate]").click();
  await page.locator('[role="dialog"]').evaluate(async (el) => {
    await Promise.all(el.getAnimations().map((a) => a.finished));
  });
}
test("IPE01 blank closes but image does not", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 844 } });
  try {
    await openPreview(page);
    await page.locator('[role="dialog"] img').click();
    assert.equal(await page.locator('[role="dialog"]').count(), 1);
    await page.mouse.click(40, 400);
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 2000 });
  } finally {
    await page.close();
  }
});
test("IPE01 fit image uses normal cursor", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 844 } });
  try {
    await openPreview(page);
    const cursor = await page
      .locator('[role="dialog"] img')
      .evaluate((el) => getComputedStyle(el).cursor);
    assert.equal(cursor, "default");
  } finally {
    await page.close();
  }
});
test("IPE02 ordinary wheel zooms", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 844 } });
  try {
    await openPreview(page);
    await page.locator('[role="dialog"] img').hover();
    await page.mouse.wheel(0, -200);
    await page.waitForFunction(
      () =>
        !Array.from(document.querySelectorAll('[role="dialog"] span')).some(
          (e) => e.textContent === "100%",
        ),
      { timeout: 2000 },
    );
  } finally {
    await page.close();
  }
});

async function draw(page, tool = "pen", start = { x: 0.2, y: 0.2 }, end = { x: 0.6, y: 0.6 }) {
  await page.locator(`[data-image-preview-tool="${tool}"]`).click();
  const box = await page.locator("[data-image-preview-surface]").boundingBox();
  await page.mouse.move(box.x + box.width * start.x, box.y + box.height * start.y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * end.x, box.y + box.height * end.y, { steps: 8 });
  await page.mouse.up();
}
for (const width of [390, 1100])
  for (const theme of ["light", "dark"])
    for (const locale of ["zh-CN", "en-US"]) {
      test(`IPE03/IPE06 editing ${width}/${theme}/${locale}`, async () => {
        const context = await browser.newContext({
          viewport: { width, height: 844 },
          hasTouch: width === 390,
          isMobile: width === 390,
        });
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(String(error)));
        try {
          await openPreview(page, `theme=${theme}&locale=${locale}`);
          // 11-02 工具栏修订已去掉橡皮擦；新版“添加到聊天”只在有标注后出现在图形下方，位置由 IPE05 用例覆盖。
          assert.equal(await page.locator("[data-image-preview-tool=eraser]").count(), 0);
          assert.equal(await page.locator("[data-image-preview-save]").count(), 0);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
          await draw(page);
          await draw(page, "rectangle", { x: 0.1, y: 0.5 }, { x: 0.4, y: 0.8 });
          await draw(page, "ellipse", { x: 0.6, y: 0.2 }, { x: 0.8, y: 0.4 });
          await draw(page, "arrow", { x: 0.5, y: 0.7 }, { x: 0.8, y: 0.8 });
          assert.equal(await page.locator("[data-annotation-id]").count(), 4);
          await page.locator('[data-image-preview-tool="text"]').click();
          const box = await page.locator("[data-image-preview-surface]").boundingBox();
          await page.mouse.click(box.x + box.width * 0.45, box.y + box.height * 0.1);
          await page
            .getByRole("textbox", { name: locale === "zh-CN" ? "标注文字" : "Annotation text" })
            .fill("标注 ABC");
          await page
            .getByRole("textbox", { name: locale === "zh-CN" ? "标注文字" : "Annotation text" })
            .press("ArrowLeft");
          await page
            .getByRole("textbox", { name: locale === "zh-CN" ? "标注文字" : "Annotation text" })
            .press("Enter");
          assert.equal(await page.locator("[data-annotation-id]").count(), 5);
          // 色值属于图片内容，不随深浅主题变化。
          await page.locator("input[type=color]").fill("#22c55e");
          await draw(page, "pen", { x: 0.1, y: 0.9 }, { x: 0.3, y: 0.9 });
          const green = page.locator('[data-annotation-id][stroke="#22c55e"]');
          assert.equal(await green.count(), 1);
          await page
            .getByRole("button", { name: locale === "zh-CN" ? "撤销" : "Undo", exact: true })
            .click();
          assert.equal(await green.count(), 0);
          await page
            .getByRole("button", { name: locale === "zh-CN" ? "重做" : "Redo", exact: true })
            .click();
          assert.equal(await green.count(), 1);
          await page.screenshot({ path: join(artifacts, `${width}-${theme}-${locale}.png`) });
          await page.locator("[data-image-preview-save]").click();
          await page.waitForFunction(() => window.savedFiles.length === 1);
          const saved = await page.evaluate(async () => {
            const f = window.savedFiles[0],
              image = await createImageBitmap(f),
              c = document.createElement("canvas");
            c.width = image.width;
            c.height = image.height;
            const ctx = c.getContext("2d");
            ctx.drawImage(image, 0, 0);
            image.close();
            return {
              name: f.name,
              type: f.type,
              width: c.width,
              height: c.height,
              green: [...ctx.getImageData(240, 720, 1, 1).data],
              original: [...ctx.getImageData(600, 500, 1, 1).data],
            };
          });
          assert.equal(saved.name, "drawing-edited.png");
          assert.equal(saved.type, "image/png");
          assert.equal(saved.width, 1200);
          assert.equal(saved.height, 800);
          assert.deepEqual(saved.green, [34, 197, 94, 255]);
          assert.deepEqual(saved.original, [135, 206, 235, 255]);
          await page.locator("[role=dialog]").waitFor({ state: "hidden" });
          assert.deepEqual(errors, []);
        } finally {
          await context.close();
        }
      });
    }
test("IPE03 select moves a mark; Delete removes it; undo restores it", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 844 } });
  try {
    await openPreview(page);
    await draw(page, "rectangle");
    const before = await page.locator("[data-annotation-id] rect").getAttribute("x");
    await page.locator("[data-image-preview-tool=select]").click();
    const box = await page.locator("[data-image-preview-surface]").boundingBox();
    await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.3);
    await page.mouse.up();
    assert.notEqual(
      await page.locator("[data-annotation-id] rect").first().getAttribute("x"),
      before,
    );
    await page.keyboard.press("Delete");
    assert.equal(await page.locator("[data-annotation-id]").count(), 0);
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    assert.equal(await page.locator("[data-annotation-id]").count(), 1);
  } finally {
    await page.close();
  }
});
async function deferExport(page) {
  await page.evaluate(() => {
    const toBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (...args) {
      window.finishExport = () => toBlob.apply(this, args);
    };
  });
}
for (const scenario of ["close", "scope", "double", "reject"])
  test(`IPE05 deferred save ${scenario}`, async () => {
    const page = await browser.newPage({ viewport: { width: 1100, height: 844 } });
    try {
      await openPreview(page);
      await draw(page);
      await deferExport(page);
      if (scenario === "reject") await page.evaluate(() => (window.rejectSave = true));
      await page.locator("[data-image-preview-save]").click();
      await page.waitForFunction(() => typeof window.finishExport === "function");
      if (scenario === "close") await page.keyboard.press("Escape");
      if (scenario === "scope") await page.evaluate(() => window.changeScope());
      if (scenario === "double")
        assert.equal(await page.locator("[data-image-preview-save]").isDisabled(), true);
      await page.evaluate(() => window.finishExport());
      if (scenario === "double") await page.waitForFunction(() => window.savedFiles.length === 1);
      else if (scenario !== "close")
        await page.getByText("图片保存失败，请重试", { exact: true }).waitFor();
      // 等待导出 callback 的结果可见，关闭分支另等解码/编码 promise 完成。
      if (scenario === "close")
        await page.waitForFunction(() => !document.querySelector("[role=dialog]"));
      assert.equal(
        await page.evaluate(() => window.savedFiles.length),
        scenario === "double" || scenario === "close" ? 1 : 0,
      );
      if (scenario === "scope" || scenario === "reject")
        assert.equal(await page.locator("[data-annotation-id]").count(), 1);
    } finally {
      await page.close();
    }
  });
test("IPE02 anchored wheel, bounded drag and touch pinch", async () => {
  const context = await browser.newContext({
    viewport: { width: 1100, height: 844 },
    hasTouch: true,
  });
  const page = await context.newPage();
  try {
    await openPreview(page);
    const surface = page.locator("[data-image-preview-surface]");
    const initial = await surface.boundingBox();
    const anchor = { x: initial.x + initial.width * 0.65, y: initial.y + initial.height * 0.5 };
    await page.mouse.move(anchor.x, anchor.y);
    await page.mouse.wheel(0, -150);
    await page.waitForFunction(
      () =>
        document
          .querySelector("[data-image-preview-surface]")
          .style.transform.includes("scale(1.") &&
        getComputedStyle(document.querySelector("[data-image-preview-surface]")).cursor === "grab",
    );
    const zoomed = await surface.boundingBox();
    assert.ok(Math.abs((anchor.x - zoomed.x) / zoomed.width - 0.65) < 0.005);
    await page.mouse.move(550, 420);
    await page.mouse.down();
    await page.mouse.move(950, 600, { steps: 5 });
    await page.mouse.up();
    assert.equal(await page.locator("[role=dialog]").count(), 1);
    const box = await surface.boundingBox(),
      vp = await page.locator("[data-image-preview-viewport]").boundingBox();
    assert.ok(box.x <= vp.x + 1 && box.x + box.width >= vp.x + vp.width - 1);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        { x: 400, y: 400, id: 1 },
        { x: 600, y: 400, id: 2 },
      ],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        { x: 350, y: 400, id: 1 },
        { x: 650, y: 400, id: 2 },
      ],
    });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForFunction(
      (previous) =>
        document.querySelector("[data-image-preview-surface]").getBoundingClientRect().width >
        previous,
      box.width,
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: join(artifacts, "touch-resize.png") });
    assert.equal(await page.locator("[role=dialog]").count(), 1);
  } finally {
    await context.close();
  }
});
test("IPE05 encoder failure keeps edits and re-enables save", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 844 } });
  try {
    await openPreview(page);
    await draw(page);
    await page.evaluate(
      () =>
        (HTMLCanvasElement.prototype.toBlob = function (callback) {
          callback(null);
        }),
    );
    await page.locator("[data-image-preview-save]").click();
    await page.getByText("图片保存失败，请重试", { exact: true }).waitFor();
    assert.equal(await page.locator("[data-image-preview-save]").isEnabled(), true);
    assert.equal(await page.locator("[data-annotation-id]").count(), 1);
    assert.equal(await page.evaluate(() => window.savedFiles.length), 0);
  } finally {
    await page.close();
  }
});

for (const width of [390, 1100])
  test(`IPE gallery navigation remains clickable beside editing tools ${width}`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    try {
      await openPreview(page, "locale=zh-CN&multi=1");
      await page.getByRole("button", { name: "下一张图片", exact: true }).click({ timeout: 3000 });
      await page.waitForFunction(
        () => document.querySelector("[role=dialog] img")?.alt === "second.svg",
      );
      await page.getByRole("button", { name: "上一张图片", exact: true }).click();
      await page.waitForFunction(
        () => document.querySelector("[role=dialog] img")?.alt === "drawing.svg",
      );
    } finally {
      await page.close();
    }
  });

test("IPE05 no add action until drawing changes", async () => {
  const page = await browser.newPage();
  try {
    await openPreview(page);
    assert.equal(await page.locator("[data-image-preview-save]").count(), 0);
    await draw(page);
    assert.equal(await page.locator("[data-image-preview-save]").count(), 1);
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    assert.equal(await page.locator("[data-image-preview-save]").count(), 0);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator('[role="alertdialog"]').count(), 0);
  } finally {
    await page.close();
  }
});

test("IPE03 collapsed annotation controls keep marks read-only", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 844 } });
  try {
    await openPreview(page);
    await page.locator('[data-image-preview-tool="rectangle"]').click();
    const box = await page.locator("[data-image-preview-surface]").boundingBox();
    await page.mouse.move(box.x + 100, box.y + 100);
    await page.mouse.down();
    await page.mouse.move(box.x + 200, box.y + 180);
    await page.mouse.up();
    await page.locator("[data-image-preview-annotate]").click();
    const before = await page.locator("[data-annotation-id]").getAttribute("transform");
    const markup = await page.locator("[data-annotation-id]").evaluate((el) => el.outerHTML);
    await page.mouse.move(box.x + 100, box.y + 100);
    await page.mouse.down();
    await page.mouse.move(box.x + 150, box.y + 140);
    await page.mouse.up();
    await page.keyboard.press("Delete");
    await page.keyboard.press("ControlOrMeta+z");
    assert.equal(await page.locator("[data-annotation-id]").count(), 1);
    assert.equal(await page.locator("[data-annotation-id]").getAttribute("transform"), before);
    assert.equal(await page.locator("[data-annotation-id]").evaluate((el) => el.outerHTML), markup);
  } finally {
    await page.close();
  }
});

// 真实 Electron 换色现场先收到 buttons=0 的 lostpointercapture，再收到 pointerup。
// CDP 的松键移动复现同一原生事件顺序，不用延时模拟或修改组件状态。
test("IPE03 released capture before pointerup preserves consecutive colored strokes once", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 844 } });
  try {
    await openPreview(page);
    await draw(page);
    await page.locator("input[type=color]").fill("#0000ff");
    const cdp = await page.context().newCDPSession(page);
    const box = await page.locator("[data-image-preview-surface]").boundingBox();
    for (let i = 0; i < 2; i++) {
      const x = box.x + box.width * (0.4 + i * 0.15);
      const y = box.y + box.height * 0.2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 20, y + 100, { steps: 8 });
      assert.equal(await page.locator("[data-annotation-id]").count(), i + 2);
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: x + 20,
        y: y + 100,
        buttons: 0,
      });
      await page.mouse.up();
      assert.equal(await page.locator('[data-annotation-id][stroke="#0000ff"]').count(), i + 1);
      assert.equal(await page.locator("[data-annotation-id]").count(), i + 2);
    }
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    assert.equal(await page.locator("[data-annotation-id]").count(), 2);
    await page.getByRole("button", { name: "重做", exact: true }).click();
    assert.equal(await page.locator("[data-annotation-id]").count(), 3);
  } finally {
    await page.close();
  }
});
for (const ending of ["pointercancel", "held-capture"])
  test(`IPE03 ${ending} still discards an unfinished stroke`, async () => {
    const page = await browser.newPage({ viewport: { width: 1100, height: 844 } });
    try {
      await openPreview(page);
      await draw(page);
      const surface = page.locator("[data-image-preview-surface]");
      await surface.evaluate((element) => {
        element.addEventListener(
          "pointerdown",
          (event) => {
            element.dataset.activePointer = String(event.pointerId);
          },
          { once: true },
        );
      });
      const box = await surface.boundingBox();
      await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.4, { steps: 8 });
      assert.equal(await page.locator("[data-annotation-id]").count(), 2);
      await surface.evaluate((element, ending) => {
        const pointerId = Number(element.dataset.activePointer);
        if (ending === "pointercancel") {
          element.dispatchEvent(
            new PointerEvent("pointercancel", { bubbles: true, pointerId, buttons: 0 }),
          );
        } else {
          element.releasePointerCapture(pointerId);
        }
      }, ending);
      await page.mouse.move(box.x + box.width * 0.7 + 1, box.y + box.height * 0.4);
      await page.mouse.up();
      assert.equal(await page.locator("[data-annotation-id]").count(), 1);
      await page.getByRole("button", { name: "撤销", exact: true }).click();
      assert.equal(await page.locator("[data-annotation-id]").count(), 0);
    } finally {
      await page.close();
    }
  });

for (const cors of [true, false]) {
  test(`Image copy cross-origin CORS ${cors ? "allowed" : "denied"}`, async () => {
    const page = await browser.newPage();
    try {
      await openPreview(page);
      // 使用真实跨源 HTTP 服务；路由桩未复现 CORS 拒绝，不能用它代替浏览器真实边界。
      const imageServer = createHttpServer((_request, response) => {
        response.setHeader("Content-Type", "image/svg+xml");
        if (cors) response.setHeader("Access-Control-Allow-Origin", "*");
        response.end(
          '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>',
        );
      });
      await new Promise((resolve) => imageServer.listen(0, "127.0.0.1", resolve));
      const imageUrl = `http://127.0.0.1:${imageServer.address().port}/source.svg`;
      const result = await page.evaluate(async (imageUrl) => {
        const { copyPreviewImage } = await import("/packages/ui/src/lib/copyPreviewImage.ts");
        let copied = false;
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: {
            write: async (items) => {
              const blob = await items[0].getType("image/png");
              copied = blob.type === "image/png" && blob.size > 0;
            },
          },
        });
        const image = new Image();
        image.src = imageUrl;
        await image.decode();
        try {
          await copyPreviewImage(image);
          return { copied, failed: false };
        } catch {
          return { copied, failed: true };
        }
      }, imageUrl);
      imageServer.closeAllConnections();
      await new Promise((resolve) => imageServer.close(resolve));
      assert.deepEqual(result, { copied: cors, failed: !cors });
    } finally {
      await page.close();
    }
  });
}

for (const entry of ["close", "escape", "backdrop", "next"]) {
  test(`IPE05 unsaved three choices ${entry}`, async () => {
    const page = await browser.newPage({ viewport: { width: 1100, height: 844 } });
    try {
      if (process.env.PREVIEW_SAMPLE)
        await page.addInitScript(
          (value) => {
            window.previewSample = value;
          },
          await readFile(process.env.PREVIEW_SAMPLE, "utf8"),
        );
      await openPreview(page, "theme=light&locale=zh-CN&multi=1");
      await draw(page, "ellipse");
      if (entry === "close") await page.getByRole("button", { name: "关闭", exact: true }).click();
      if (entry === "escape") await page.keyboard.press("Escape");
      if (entry === "backdrop")
        await page.locator('[role="dialog"]').click({ position: { x: 5, y: 5 } });
      if (entry === "next")
        await page.getByRole("button", { name: "下一张图片", exact: true }).click();
      const confirm = page.getByRole("alertdialog");
      await confirm.waitFor();
      assert.equal(await page.evaluate(() => document.activeElement?.textContent), "继续编辑");
      await page.keyboard.press("ControlOrMeta+z");
      await page.keyboard.press("ArrowRight");
      assert.equal(await page.locator("[data-annotation-id]").count(), 1);
      assert.equal(await page.locator('[role="dialog"] img').getAttribute("alt"), "drawing.svg");
      assert.equal(await confirm.getByRole("button").count(), 3);
      await page.screenshot({
        animations: "disabled",
        path: join(artifacts, `unsaved-${entry}.png`),
      });
      await confirm.getByRole("button", { name: "继续编辑", exact: true }).click();
      assert.equal(await page.locator("[data-annotation-id]").count(), 1);
      await page.locator("[data-image-preview-annotate]").click();
      await page.keyboard.press("Escape");
      await confirm.waitFor();
      await page.evaluate(() => (window.rejectSave = true));
      await confirm.getByRole("button", { name: "添加到聊天", exact: true }).click();
      await page.getByText("图片保存失败，请重试", { exact: true }).waitFor();
      assert.equal(await page.locator("[data-annotation-id]").count(), 1);
      assert.equal(await page.evaluate(() => window.savedFiles.length), 0);
      await confirm.getByRole("button", { name: "放弃修改", exact: true }).click();
      await page.locator('[role="dialog"]').waitFor({ state: "hidden" });
    } finally {
      await page.close();
    }
  });
}
for (const width of [1100, 390]) {
  test(`IPE05 side add edited image ${width}`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    try {
      if (process.env.PREVIEW_SAMPLE)
        await page.addInitScript(
          (value) => {
            window.previewSample = value;
          },
          await readFile(process.env.PREVIEW_SAMPLE, "utf8"),
        );
      await openPreview(page, "theme=light&locale=zh-CN");
      await draw(page, "ellipse");
      const add = page.locator("[data-image-preview-save]");
      const box = await add.boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= width && box.y + box.height <= 844);
      await page.screenshot({
        animations: "disabled",
        path: join(artifacts, `side-add-${width}.png`),
      });
      await add.click();
      await page.waitForFunction(() => window.savedFiles.length === 1);
      await page.locator('[role="dialog"]').waitFor({ state: "hidden" });
      assert.equal(await page.locator("[data-composer-attachment]").count(), 1);
      assert.equal(await page.getByRole("textbox", { name: "输入框" }).inputValue(), "");
      await page.screenshot({
        animations: "disabled",
        path: join(artifacts, `added-draft-${width}.png`),
      });
    } finally {
      await page.close();
    }
  });
}

test("IPE05 unfinished text and confirmation add preserve edits", async () => {
  const page = await browser.newPage();
  try {
    await openPreview(page);
    await page.locator('[data-image-preview-tool="text"]').click();
    await page.locator("[data-image-preview-surface]").click({ position: { x: 150, y: 150 } });
    await page.getByRole("textbox", { name: "标注文字" }).fill("未确认的文字");
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "添加到聊天", exact: true })
      .click();
    await page.waitForFunction(() => window.savedFiles.length === 1);
    await page.locator('[role="dialog"]').waitFor({ state: "hidden" });
  } finally {
    await page.close();
  }
});

// 投票新版要求右键、顶部“…”与键盘菜单键给出同一组动作；手机没有右键，必须能从“…”进入。
test("IPE07 context menu, More menu and Shift+F10 expose the same actions", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 844 } });
  try {
    await openPreview(page);
    const openMenuIds = async () => {
      const menu = page.locator('[role="menu"]');
      await menu.waitFor();
      const ids = await menu
        .locator("[data-image-preview-action]")
        .evaluateAll((items) =>
          items.map((item) => item.getAttribute("data-image-preview-action")),
        );
      await page.keyboard.press("Escape");
      await menu.waitFor({ state: "hidden" });
      return ids;
    };
    await page.locator("[data-image-preview-surface]").click({ button: "right" });
    const context = await openMenuIds();
    assert.ok(context.includes("add") && context.includes("copy") && context.includes("download"));
    await page.getByRole("button", { name: "图片操作", exact: true }).click();
    assert.deepEqual(await openMenuIds(), context);
    await page.locator("[data-image-preview-viewport]").focus();
    await page.keyboard.press("Shift+F10");
    assert.deepEqual(await openMenuIds(), context);
    assert.equal(await page.locator('[role="dialog"]').count(), 1);
  } finally {
    await page.close();
  }
});

test("IPE05 original add action exports dirty result", async () => {
  const page = await browser.newPage();
  try {
    await openPreview(page);
    await draw(page, "ellipse");
    await page.locator("[data-image-preview-surface]").click({ button: "right" });
    await page.locator('[data-image-preview-action="add"]').click();
    await page.waitForFunction(() => window.savedFiles.length === 1);
    assert.ok(await page.evaluate(() => window.savedFiles[0].name.endsWith("-edited.png")));
    await page.locator('[role="dialog"]').waitFor({ state: "hidden" });
  } finally {
    await page.close();
  }
});

test("IPE05 pending original add locks editing and closing", async () => {
  const page = await browser.newPage();
  try {
    await openPreview(page);
    await page.evaluate(() => {
      const original = window.fetch;
      window.fetch = (...args) =>
        new Promise((resolve) => {
          window.releaseOriginal = () => resolve(original(...args));
        });
    });
    await page.locator("[data-image-preview-surface]").click({ button: "right" });
    await page.locator('[data-image-preview-action="add"]').click();
    await page.waitForFunction(() => typeof window.releaseOriginal === "function");
    assert.equal(await page.locator('[data-image-preview-tool="ellipse"]').isDisabled(), true);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator('[role="dialog"]').count(), 1);
    await page.evaluate(() => window.releaseOriginal());
    await page.waitForFunction(() => window.savedFiles.length === 1);
    await page.locator('[role="dialog"]').waitFor({ state: "hidden" });
  } finally {
    await page.close();
  }
});

test("IPE05 confirmation freezes an active captured stroke", async () => {
  const page = await browser.newPage();
  try {
    await openPreview(page);
    await page.locator('[data-image-preview-tool="ellipse"]').click();
    const box = await page.locator("[data-image-preview-surface]").boundingBox();
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4);
    const before = await page.locator("[data-annotation-id]").evaluate((el) => el.outerHTML);
    await page.keyboard.press("Escape");
    await page.getByRole("alertdialog").waitFor();
    await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.8);
    await page.mouse.up();
    assert.equal(await page.locator("[data-annotation-id]").count(), 1);
    assert.equal(await page.locator("[data-annotation-id]").evaluate((el) => el.outerHTML), before);
    await page.getByRole("button", { name: "继续编辑", exact: true }).click();
    assert.equal(await page.locator("[data-annotation-id]").count(), 1);
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    assert.equal(await page.locator("[data-annotation-id]").count(), 0);
  } finally {
    await page.close();
  }
});

for (const width of [1100, 390, 320])
  for (const theme of ["light", "dark"]) {
    test(`IPE06 refined image action ${width}/${theme}`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 844 } });
      try {
        if (process.env.PREVIEW_SAMPLE)
          await page.addInitScript(
            (value) => {
              window.previewSample = value;
            },
            await readFile(process.env.PREVIEW_SAMPLE, "utf8"),
          );
        await openPreview(page, `theme=${theme}&locale=zh-CN`);
        await page.locator("[data-image-preview-annotate]").click();
        await page.screenshot({
          animations: "disabled",
          path: join(artifacts, `refined-collapsed-${width}-${theme}.png`),
        });
        await page.locator("[data-image-preview-annotate]").click();
        await draw(page, "ellipse");
        const add = page.locator("[data-image-preview-save]");
        const shape = await page.locator("[data-annotation-id] > ellipse").boundingBox();
        const cta = await add.boundingBox();
        assert.ok(cta.x >= 0 && cta.x + cta.width <= width && cta.y + cta.height <= 844);
        assert.ok(cta.y >= shape.y + shape.height + 8 && cta.y <= shape.y + shape.height + 16);
        assert.ok(Math.abs(cta.x + cta.width / 2 - shape.x - shape.width / 2) < 2);
        const colors = await add.evaluate((el) => {
          const style = getComputedStyle(el),
            context = document.createElement("canvas").getContext("2d");
          const brightness = (color) => {
            context.clearRect(0, 0, 1, 1);
            context.fillStyle = color;
            context.fillRect(0, 0, 1, 1);
            const pixels = context.getImageData(0, 0, 1, 1).data;
            return (pixels[0] + pixels[1] + pixels[2]) / 3;
          };
          return {
            background: brightness(style.backgroundColor),
            foreground: brightness(style.color),
          };
        });
        assert.ok(
          theme === "light"
            ? colors.background > 180 && colors.foreground < 100
            : colors.background < 100 && colors.foreground > 180,
        );
        assert.equal(await add.evaluate((el) => getComputedStyle(el).whiteSpace), "nowrap");
        await page.screenshot({
          animations: "disabled",
          path: join(artifacts, `refined-drawing-${width}-${theme}.png`),
        });
        await page.keyboard.press("Escape");
        await page.getByRole("alertdialog").waitFor();
        await page.screenshot({
          animations: "disabled",
          path: join(artifacts, `refined-confirm-${width}-${theme}.png`),
        });
        await page.getByRole("button", { name: "继续编辑", exact: true }).click();
        await page.locator("[data-image-preview-surface]").hover();
        await page.mouse.wheel(0, -500);
        await page.waitForTimeout(100);
        const zoomCTA = await add.boundingBox();
        const viewport = await page.locator("[data-image-preview-viewport]").boundingBox();
        assert.ok(zoomCTA.y + zoomCTA.height <= 844);
        const zoomed = await page.locator("[data-annotation-id] > ellipse").boundingBox();
        assert.ok(
          zoomCTA.y >= Math.min(zoomed.y + zoomed.height, viewport.y + viewport.height) + 8,
        );
        await page.getByTitle("重置缩放", { exact: true }).click();
        await draw(page, "ellipse", { x: 0.55, y: 0.1 }, { x: 0.8, y: 0.25 });
        const second = await page.locator("[data-annotation-id] > ellipse").last().boundingBox();
        const secondCTA = await add.boundingBox();
        assert.ok(Math.abs(secondCTA.y - second.y - second.height - 12) < 2);
        await page.getByRole("button", { name: "撤销", exact: true }).click();
        const restored = await page.locator("[data-annotation-id] > ellipse").boundingBox();
        const restoredCTA = await add.boundingBox();
        assert.ok(Math.abs(restoredCTA.y - restored.y - restored.height - 12) < 2);
      } finally {
        await page.close();
      }
    });
  }
