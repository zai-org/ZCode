// 独立真实 renderer 验证 hover/focus；不依赖当前会话，不覆盖宿主侧栏路由。
import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright-core";

test("完成通知产物链接样式与点击", async () => {
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
      await import('/@fs${process.cwd()}/packages/ui/test/fixtures/workflow-notification-link.fixture.tsx');
    </script>`,
      }),
    );
    for (const width of [1200, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`${origin}/__workflow_hover`);
      const summary = page.locator(".group\\/tool-summary");
      await summary.waitFor();
      assert.equal(await page.getByTestId("sample-artifact").locator(":scope > img").count(), 1);
      assert.equal(await page.getByTestId("sample-artifact").locator(".wf-pill-tile").count(), 0);
      assert.match(
        await summary.innerText(),
        /Workflow completed\s*·\s*Desktop workflow\s*·\s*Desktop startup/s,
      );
      const link = summary.getByRole("button", { name: "Desktop startup" });
      assert.match(await link.locator("img").getAttribute("src"), /markdown/i);
      await link.hover();
      assert.equal(await link.evaluate((n) => getComputedStyle(n).textDecorationLine), "underline");
      assert.equal(
        await link.evaluate((n) => getComputedStyle(n).backgroundColor),
        "rgba(0, 0, 0, 0)",
      );
      await link.click();
      assert.equal(await page.locator("body").getAttribute("data-open"), "true");
      assert.equal(await summary.getAttribute("aria-expanded"), "false");
      await summary.click();
      const result = page.getByTestId("workflow-notification-result");
      const copy = result.getByRole("button", { name: "Copy code" });
      await copy.waitFor();
      await page.waitForFunction(() => {
        const n = document.querySelector('[data-testid="workflow-notification-result"] .max-h-80');
        return n && n.scrollHeight > n.clientHeight;
      });
      const before = await copy.boundingBox();
      await result.locator(".max-h-80").evaluate((n) => {
        n.scrollTop = 100;
      });
      assert.equal((await copy.boundingBox()).y, before.y);
    }
  } finally {
    await browser.close();
  }
});
