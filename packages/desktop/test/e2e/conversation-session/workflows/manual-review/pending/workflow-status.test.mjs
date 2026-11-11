// 独立真实 renderer 验证状态、展开滚动与打开回调；不覆盖宿主侧栏路由。
import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright-core";

test("Workflow status 查询状态与展开内容", async () => {
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
      await import('/@fs${process.cwd()}/packages/ui/test/fixtures/workflow-status.fixture.tsx');
    </script>`,
      }),
    );
    for (const width of [1200, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`${origin}/__workflow_hover`);
      const summary = page.locator(".group\\/tool-summary");
      await summary.waitFor();
      assert.match(await summary.innerText(), /Checking workflow status/);
      assert.equal(await summary.getAttribute("role"), null);
      await page.getByRole("button", { name: "running", exact: true }).click();
      assert.match(
        await summary.innerText(),
        /Workflow status\s*·\s*Status workflow\s*·\s*1\/3 steps/s,
      );
      await summary.click();
      const body = page.getByTestId("workflow-status-body");
      await body.waitFor();
      assert.match(await body.innerText(), /1\/3 steps/);
      assert.doesNotMatch(await body.innerText(), /Actors|Usage|No logs/);
      assert.equal(await summary.getByRole("button", { name: /details/i }).count(), 0);
      await page.getByRole("button", { name: "completed", exact: true }).click();
      await body.getByRole("button", { name: "Copy code" }).waitFor();
      await page.waitForFunction(() => {
        const n = document.querySelector('[data-testid="workflow-status-body"] .max-h-80');
        return n && n.scrollHeight > n.clientHeight;
      });
      const copy = body.getByRole("button", { name: "Copy code" });
      const before = await copy.boundingBox();
      await body.locator(".max-h-80").evaluate((n) => {
        n.scrollTop = 100;
      });
      assert.equal((await copy.boundingBox()).y, before.y);
      await page.getByRole("button", { name: "run-failed", exact: true }).click();
      assert.match(await body.innerText(), /^RUN_ERROR: Actor failed/);
      await page.getByRole("button", { name: "query-failed", exact: true }).click();
      assert.equal(await body.innerText(), "Query denied");
    }
  } finally {
    await browser.close();
  }
});
