import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry = "/packages/ui/test/browser/manual-review/pending/update-confirmation.fixture.tsx";
const artifacts = join(root, "packages/desktop/.e2e-artifacts/update-confirmation-browser");
let server, browser, origin;

before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    cacheDir: join(root, "node_modules/.vite-update-confirmation"),
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "update-confirmation-fixture",
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith("/fixture?")) return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await vite.transformIndexHtml(
                req.url,
                `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
              ),
            );
          });
        },
      },
    ],
    resolve: { alias: { "@": `${root}packages/ui/src` } },
    optimizeDeps: { entries: [entry.slice(1)] },
    server: { host: "127.0.0.1", port: 0, hmr: false },
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

async function readLayout(dialog) {
  return dialog.evaluate((element) => {
    const footer = element.querySelector("[data-slot='dialog-footer']");
    const buttons = [...footer.querySelectorAll("button")];
    const title = element.querySelector("[data-slot='dialog-title']");
    const description = element.querySelector("[data-slot='dialog-description']");
    return {
      fits: element.scrollWidth <= element.clientWidth,
      width: element.getBoundingClientRect().width,
      left: element.getBoundingClientRect().left,
      right: element.getBoundingClientRect().right,
      footerWidth: footer.getBoundingClientRect().width,
      titleSize: parseFloat(getComputedStyle(title).fontSize),
      descriptionSize: parseFloat(getComputedStyle(description).fontSize),
      differentTextColors: getComputedStyle(title).color !== getComputedStyle(description).color,
      buttons: buttons.map((button) => {
        const rect = button.getBoundingClientRect();
        return {
          x: rect.x,
          top: rect.top,
          width: rect.width,
          height: parseFloat(getComputedStyle(button).height),
        };
      }),
    };
  });
}

for (const width of [390, 512, 1200])
  for (const theme of ["light", "dark"])
    for (const locale of ["zh-CN", "en-US"])
      test(`update confirmation ${width}/${theme}/${locale}`, { timeout: 90_000 }, async () => {
        const page = await browser.newPage({ viewport: { width, height: 600 } });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        try {
          await page.goto(`${origin}fixture?theme=${theme}&locale=${locale}`, { timeout: 60_000 });
          await page.getByTestId("open-update").click();
          const dialog = page.getByTestId("confirmation-fixture");
          await dialog.waitFor();
          await dialog.evaluate((element) =>
            Promise.all(element.getAnimations().map((animation) => animation.finished)),
          );
          const layout = await readLayout(dialog);
          assert.ok(layout.fits, "更新确认不能横向溢出");
          assert.ok(layout.width <= 448, "更新确认保持紧凑宽度");
          assert.ok(layout.left >= 16 && layout.right <= width - 16, "窄窗口保留16px侧边距");
          assert.equal(layout.buttons.length, 2);
          assert.ok(Math.abs(layout.buttons[0].top - layout.buttons[1].top) < 1, "按钮保持同排");
          assert.ok(layout.buttons[0].x < layout.buttons[1].x, "取消在前，确认在后");
          assert.ok(
            layout.buttons.every((button) => button.height === 32),
            "共享 lg 按钮为32px",
          );
          assert.ok(
            layout.buttons.every((button) => button.width < layout.footerWidth * 0.7),
            "按钮不铺满操作区",
          );
          assert.equal(layout.titleSize, 14);
          assert.equal(layout.descriptionSize, 12);
          assert.ok(layout.differentTextColors, "说明保留次级文字层级");
          assert.ok(!(await dialog.textContent()).includes("esc"), "更新确认隐藏快捷键文字");
          await page.screenshot({ path: join(artifacts, `${width}-${theme}-${locale}.png`) });
          await page.keyboard.press("Escape");
          await dialog.waitFor({ state: "hidden" });
          assert.equal(await page.getByTestId("choice").textContent(), "dismiss");
          await page.getByTestId("open-update").click();
          await dialog.waitFor();
          await page.keyboard.press("Enter");
          await dialog.waitFor({ state: "hidden" });
          assert.equal(await page.getByTestId("choice").textContent(), "confirm");
          await page.getByTestId("open-default").click();
          await dialog.waitFor();
          await dialog.evaluate((element) =>
            Promise.all(element.getAnimations().map((animation) => animation.finished)),
          );
          const original = await readLayout(dialog);
          assert.equal(original.titleSize, 16, "默认确认标题不受影响");
          assert.equal(original.descriptionSize, 14, "默认说明不受影响");
          assert.ok(
            original.buttons.every((button) => button.height === 36),
            "默认按钮高度不受影响",
          );
          if (width < 640)
            assert.ok(
              Math.abs(original.buttons[0].top - original.buttons[1].top) > 1,
              "默认窄屏堆叠不受影响",
            );
          assert.deepEqual(errors, []);
        } finally {
          await page.close();
        }
      });
