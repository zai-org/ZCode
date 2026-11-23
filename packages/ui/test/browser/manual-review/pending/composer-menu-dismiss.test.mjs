import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { mkdir, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium, _electron } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry = "/packages/ui/test/browser/manual-review/pending/composer-menu-dismiss.fixture.tsx";
const artifacts = join(root, "packages/desktop/.e2e-artifacts/composer-menu-dismiss");
let server, browser, electron, origin, temporary;
before(async () => {
  await mkdir(artifacts, { recursive: true });
  temporary = await mkdtemp(join(tmpdir(), "composer-menu-dismiss-"));
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "composer-dismiss-fixture",
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (req.url === "/guest") {
              res.setHeader("Content-Type", "text/html");
              res.end(
                '<html><body style="margin:0;background:#ddd"><button style="position:fixed;inset:0" onclick="this.dataset.clicks=String(Number(this.dataset.clicks)+1)" data-clicks="0">Plugin action</button></body></html>',
              );
            } else if (req.url?.startsWith("/fixture?")) {
              res.setHeader("Content-Type", "text/html");
              res.end(
                await vite.transformIndexHtml(
                  req.url,
                  `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
                ),
              );
            } else next();
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
  const main = join(temporary, "main.cjs");
  await writeFile(
    main,
    `const { app, BrowserWindow } = require('electron'); app.on('window-all-closed', () => app.quit()); app.whenReady().then(() => { const win = new BrowserWindow({width:1200,height:800,webPreferences:{webviewTag:true}}); win.loadURL(${JSON.stringify(origin + "fixture?electron&theme=light")}); });`,
  );
  const require = createRequire(new URL("../../../../../desktop/package.json", import.meta.url));
  electron = await _electron.launch({
    executablePath: require("electron"),
    args: [main, `--user-data-dir=${join(temporary, "profile")}`],
  });
  await (await electron.firstWindow()).waitForLoadState("load");
});
after(async () => {
  await electron?.close();
  await browser?.close();
  await server?.close();
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

for (const surface of ["electron", "mobile"])
  for (const locale of ["en-US", "zh-CN"])
    for (const theme of ["light", "dark"]) {
      test(`SPFV-MODEL-001 ${surface}/${theme}/${locale}`, async () => {
        const page =
          surface === "electron"
            ? await electron.firstWindow()
            : await browser.newPage({
                viewport: { width: 390, height: 800 },
                hasTouch: true,
                isMobile: true,
              });
        const trace = [];
        try {
          await page.goto(
            `${origin}fixture?${surface === "electron" ? "electron&" : ""}theme=${theme}&locale=${locale}`,
          );
          await page.waitForSelector(surface === "electron" ? "webview" : "iframe");
          const guestClicks = () =>
            page.evaluate(
              async (native) =>
                native
                  ? await document
                      .querySelector("webview")
                      .executeJavaScript('document.querySelector("button").dataset.clicks')
                  : document.querySelector("iframe").contentDocument.querySelector("button").dataset
                      .clicks,
              surface === "electron",
            );
          await page.waitForFunction(async (native) => {
            try {
              return native
                ? await document
                    .querySelector("webview")
                    ?.executeJavaScript('Boolean(document.querySelector("button"))')
                : Boolean(
                    document.querySelector("iframe")?.contentDocument?.querySelector("button"),
                  );
            } catch {
              return false;
            }
          }, surface === "electron");
          await page.evaluate(() => {
            window.__menuEvents = [];
            for (const type of ["pointerdown", "pointerout", "focusin", "focusout"])
              document.addEventListener(
                type,
                (event) =>
                  window.__menuEvents.push({
                    type,
                    target: event.target.tagName,
                    testid: event.target.dataset?.testid,
                  }),
                true,
              );
          });
          const trigger = page.getByTestId("chat-model-select-trigger");
          const open = async () => {
            await trigger.click();
            await page.getByTestId("composer-model-panel").waitFor();
          };
          const closed = async () => {
            await page
              .getByTestId("composer-model-panel")
              .waitFor({ state: "hidden", timeout: 3000 });
            assert.equal(await trigger.getAttribute("aria-expanded"), "false");
          };
          await open();
          trace.push(
            await page.evaluate(() => ({
              bodyPointerEvents: getComputedStyle(document.body).pointerEvents,
              hit: document.elementFromPoint(80, 80)?.tagName,
              events: window.__menuEvents,
            })),
          );
          const before = await guestClicks();
          if (surface === "mobile") await page.touchscreen.tap(80, 80);
          else await page.mouse.click(80, 80);
          trace.push({
            guestBefore: before,
            guestAfter: await guestClicks(),
            events: await page.evaluate(() => window.__menuEvents),
            expanded: await trigger.getAttribute("aria-expanded"),
          });
          await closed();
          assert.equal(await guestClicks(), before, "dismissal must not activate the plugin");
          await page.mouse.click(80, 80);
          assert.equal(
            Number(await guestClicks()),
            Number(before) + 1,
            "plugin remains interactive after dismissal",
          );
          await open();
          const search = page.getByTestId("composer-model-search");
          await page.getByTestId("composer-provider-trigger").focus();
          await page.keyboard.press("Tab");
          await page.waitForFunction(
            () => document.activeElement?.getAttribute("data-testid") === "composer-model-search",
          );
          assert.equal(
            await search.getAttribute("placeholder"),
            locale === "zh-CN" ? "搜索模型..." : "Search models...",
          );
          await page.screenshot({
            path: join(artifacts, `${surface}-${theme}-${locale}-search.png`),
          });
          await search.fill("  tWO  ");
          assert.equal(await page.getByRole("option").count(), 1);
          assert.equal(await page.getByTestId("selection").textContent(), "one");
          const searchShape = await search.evaluate((el) => ({
            radius: parseFloat(getComputedStyle(el).borderRadius),
            height: el.getBoundingClientRect().height,
          }));
          assert.ok(searchShape.radius >= searchShape.height / 2, "search uses capsule corners");
          const clear = page.getByTestId("composer-model-search-clear");
          await clear.waitFor();
          await page.screenshot({
            path: join(artifacts, `${surface}-${theme}-${locale}-query.png`),
          });
          if (surface === "mobile") await clear.tap();
          else await clear.click();
          assert.equal(await search.inputValue(), "");
          assert.equal(await clear.count(), 0);
          assert.equal(await page.getByRole("option").count(), 3);
          assert.equal(
            await search.evaluate((element) => element === document.activeElement),
            true,
          );
          assert.equal(await trigger.getAttribute("aria-expanded"), "true");
          await search.fill("missing-model");
          assert.equal(await page.getByRole("option").count(), 0);
          await page.locator("[data-composer-model-list] [role=status]").waitFor();
          await search.fill("Model");
          await search.press("ArrowRight");
          await search.press("Space");
          assert.equal((await search.inputValue()).trim(), "Model");
          assert.equal(
            await search.evaluate((element) => element === document.activeElement),
            true,
          );
          if (surface === "electron") {
            const row = page.getByRole("option", { name: "Model Two", exact: true });
            await page.mouse.move(10, 10);
            const background = await row.evaluate(
              (element) => getComputedStyle(element).backgroundColor,
            );
            await row.hover();
            // 等待浏览器完成指针命中与样式更新，避免首帧读取到 hover 前的颜色。
            await page.waitForFunction(
              ({ element, background }) => getComputedStyle(element).backgroundColor !== background,
              { element: await row.elementHandle(), background },
            );
            assert.equal(
              await search.evaluate((element) => element === document.activeElement),
              true,
            );
            assert.equal(await page.getByTestId("selection").textContent(), "one");
            await page.keyboard.type("Two");
            assert.equal((await search.inputValue()).trim(), "Model Two");
            await page.mouse.move(10, 10);
            assert.equal(
              await row.evaluate((element) => getComputedStyle(element).backgroundColor),
              background,
            );
          }
          await search.fill("two");
          await search.press("ArrowDown");
          await page.keyboard.press("Enter");
          assert.equal(await page.getByTestId("selection").textContent(), "two");
          await search.fill("");
          await page.getByRole("option", { name: "Model Two", exact: true }).click();
          assert.equal(await trigger.getAttribute("aria-expanded"), "true");
          assert.equal(await page.getByTestId("selection").textContent(), "two");
          await page.getByRole("option", { name: "Model Two", exact: true }).focus();
          await page.keyboard.press("Enter");
          assert.equal(await trigger.getAttribute("aria-expanded"), "true");
          const waitFocusedModel = async (name) => {
            const element = await page.getByRole("option", { name, exact: true }).elementHandle();
            await page.waitForFunction((el) => el === document.activeElement, element);
          };
          await page.keyboard.press("Home");
          await waitFocusedModel("Model One");
          await page.keyboard.press("ArrowDown");
          await waitFocusedModel("Model Two");
          await page.keyboard.press("ArrowUp");
          await waitFocusedModel("Model One");
          await page.keyboard.press("End");
          await waitFocusedModel("Model Two");
          await page.keyboard.press("Space");
          assert.equal(await page.getByTestId("selection").textContent(), "two");
          trace.push({
            afterSelection: await page.getByTestId("selection").textContent(),
            expanded: await trigger.getAttribute("aria-expanded"),
          });
          const clicksAfterSelection = await guestClicks();
          if (surface === "mobile") await page.touchscreen.tap(80, 80);
          else await page.mouse.click(80, 80);
          await closed();
          assert.equal(await guestClicks(), clicksAfterSelection);
          await open();
          assert.equal(await search.inputValue(), "");
          await search.fill("locked");
          await page.getByRole("option", { name: "Locked Model" }).click({ force: true });
          assert.equal(await page.getByTestId("selection").textContent(), "two");
          assert.equal(await trigger.getAttribute("aria-expanded"), "true");
          if (surface === "electron") {
            await search.focus();
            await page.getByTestId("composer-provider-trigger").hover();
            const providerPanel = page.getByTestId("composer-provider-panel");
            await providerPanel.waitFor();
            assert.equal(await search.evaluate((el) => el === document.activeElement), true);
            const providerRow = page.getByRole("option", { name: "Provider B", exact: true });
            const bounds = await providerRow.boundingBox();
            await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, {
              steps: 8,
            });
            assert.equal(await providerPanel.isVisible(), true);
            assert.equal(await search.evaluate((el) => el === document.activeElement), true);
            await search.hover();
            await providerPanel.waitFor({ state: "hidden" });
            assert.equal(await search.evaluate((el) => el === document.activeElement), true);
          }
          await page.getByTestId("composer-provider-trigger").click();
          await page.getByRole("option", { name: "Provider B", exact: true }).click();
          assert.equal(await page.getByTestId("selection").textContent(), "three");
          assert.equal(await search.inputValue(), "");
          assert.equal(await trigger.getAttribute("aria-expanded"), "true");
          await search.focus();
          await page.getByRole("slider").hover();
          assert.equal(
            await search.evaluate((element) => element === document.activeElement),
            true,
          );
          await page.getByRole("slider").click();
          await page.keyboard.press("Home");
          assert.equal(await page.getByRole("slider").getAttribute("aria-valuetext"), "Low");
          await page.keyboard.press("End");
          assert.equal(await page.getByRole("slider").getAttribute("aria-valuetext"), "High");
          const sliderBox = await page.getByRole("slider").boundingBox();
          await page.mouse.move(
            sliderBox.x + sliderBox.width - 14,
            sliderBox.y + sliderBox.height / 2,
          );
          await page.mouse.down();
          await page.mouse.move(sliderBox.x + 14, sliderBox.y + sliderBox.height / 2, { steps: 5 });
          await page.mouse.up();
          assert.equal(await page.getByRole("slider").getAttribute("aria-valuetext"), "Low");
          assert.equal(await trigger.getAttribute("aria-expanded"), "true");
          await page.screenshot({ path: join(artifacts, `${surface}-${theme}-${locale}.png`) });
          await page.keyboard.press("Escape");
          await closed();
        } finally {
          trace.push({
            finalEvents: await page.evaluate(() => window.__menuEvents),
            active: await page.evaluate(() => document.activeElement?.getAttribute("data-testid")),
          });
          await writeFile(
            join(artifacts, `${surface}-${theme}-${locale}.json`),
            JSON.stringify(trace, null, 2),
          );
          if (surface !== "electron") await page.close();
        }
      });
    }
