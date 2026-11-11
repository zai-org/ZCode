// 独立真实 renderer 验证 hover/focus；不依赖当前会话，不覆盖宿主侧栏路由。
import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright-core";

test("Workflow steps hover 与键盘聚焦高亮", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    page.on("pageerror", (error) => {
      process.stderr.write(String(error));
    });
    const targets = await (await fetch("http://localhost:9229/json/list")).json();
    const origin = new URL(targets.find((t) => t.type === "page").url).origin;
    await page.route("**/__workflow_hover", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<div id="root"></div><script type="module">
      import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;
      await import('/@fs${process.cwd()}/packages/ui/test/fixtures/workflow-summary-hover.fixture.tsx');
    </script>`,
      }),
    );
    for (const width of [1200, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`${origin}/__workflow_hover`);
      const steps = page.getByTestId("workflow-summary-steps");
      await steps.waitFor({ timeout: 15000 });
      await page.mouse.move(0, 700);
      const idle = await steps.evaluate((n) => getComputedStyle(n).color);
      await steps.hover();
      assert.notEqual(await steps.evaluate((n) => getComputedStyle(n).color), idle);
      await page.mouse.move(0, 700);
      await page.keyboard.press("Tab");
      assert.notEqual(await steps.evaluate((n) => getComputedStyle(n).color), idle);
      await page.keyboard.press("Enter");
      assert.equal(await page.locator("body").getAttribute("data-open"), "true");
    }
  } finally {
    await browser.close();
  }
});
